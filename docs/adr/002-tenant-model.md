# ADR 002: Tenant Model — Workspace as Core Tenant Boundary with Organization Mapping

## Context
LobeHub already contains a mature `workspaces` table (`packages/database/src/schemas/workspace.ts`) with associated `workspace_members`, `workspace_invitations`, `workspace_audit_logs`, and `workspace_user_settings`. Most shared resources (`agents`, `sessions`, `topics`, `messages`, `files`, `knowledge_bases`, `tasks`, `agent_provider_accounts`, `api_keys`) already include a `workspace_id` column.

## Problem
Commercial SaaS requirements refer to "Organizations" and "Workspaces". We must decide how to model tenancy without breaking LobeHub's existing schema and queries.

## Options
1. **Option A (Database-Per-Tenant):** Separate PostgreSQL database or schema per tenant.
2. **Option B (Intrusive Global Refactor):** Introduce an `organizations` table, alter every existing LobeHub table to add `organization_id`, and rewrite all queries.
3. **Option C (Workspace-Centric Multi-Tenancy with Organization Mapping — Chosen):**
   * Recognize `Workspace` as the physical tenant container in the database layer.
   * Provide an Organization abstraction in the SaaS Control Plane where an Organization maps 1:1 or 1:N with Workspaces.
   * Every tenant-scoped query filters on `workspace_id`.
   * Enforce tenant isolation strictly at the application repository and service boundaries.

## Decision
We adopt **Option C**.

We reuse LobeHub's existing `workspaces` and `workspace_members` tables as the primary tenant boundary.
In the SaaS domain model:
* `SecurityContext.workspaceId` represents the active tenant partition.
* `SecurityContext.organizationId` maps to the billing and administrative account owning the workspace.
* In single-workspace accounts, `organizationId == workspaceId`. In enterprise accounts, multiple workspaces link to the same parent Organization entity.

### Database Defense in Depth & Row-Level Security (RLS)
* Composite constraints, foreign keys with `ON DELETE CASCADE`, and explicit `where(and(eq(table.workspaceId, ctx.workspaceId), ...))` clauses in all repositories provide immediate, enforceable isolation.
* PostgreSQL Row-Level Security (RLS) is **recommended as a secondary defense-in-depth layer for high-security environments**, but should not be the sole mechanism due to connection pooling overhead (setting `SESSION app.current_workspace_id` on pooled connections).

## Consequences
* Upstream queries and schemas for agents, topics, messages, and files remain fully compatible.
* No risky data migrations or massive table refactors are needed.
* Eliminates IDOR/BOLA by strictly verifying `ctx.workspaceId` against `workspace_members` on every request.

## Rejected Alternatives
* **Option A (Database-per-tenant):** Rejected per Rule 10 ("Do not over-engineer / Do not introduce database-per-tenant unless there is a demonstrated requirement").
* **Option B (Intrusive Refactor):** Rejected because it needlessly alters tens of upstream tables and breaks existing repositories without architectural benefit.
