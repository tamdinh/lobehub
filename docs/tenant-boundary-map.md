# Tenant Boundary & Resource Map

## 1. Executive Summary

In LobeHub's existing architecture, the primary multi-user tenant boundary is **`Workspace`** (`workspaces` table). There is no native `organizations` table in the database schema; in cloud/business deployments, the `Workspace` acts as the organizational tenant container with members, roles, invitations, and audit logs.

To support commercial SaaS requirements where customers may expect an "Organization" owning multiple "Workspaces" (or where an Organization is synonymous with a top-level account), our SaaS Control Plane must provide an authoritative mapping layer.

---

## 2. Core Tenant Entities in Database

### 2.1 `workspaces` (`packages/database/src/schemas/workspace.ts`)
* **Primary Key:** `id` (text, NanoId 16).
* **Identity & Slugs:** `slug` (varchar 100, unique index `workspaces_slug_idx`), `name` (varchar 255), `avatar`, `description`.
* **Primary Ownership:** `primary_owner_id` (references `users.id` on delete cascade, indexed). Uniquely binds Stripe subscription and ultimate authority to a specific user.
* **Control / Administrative State:**
  * `frozen` (boolean, default false): Driven by risk control (fraud, abnormal spend, quota abuse).
  * `frozen_reason` (text), `frozen_at` (timestamptz).
  * `settings` (jsonb): Free-form configuration containing workspace preferences, API key policies (`apiKey.memberCreation`).
* **Timestamps:** `created_at`, `updated_at`.

### 2.2 `workspace_members` (`packages/database/src/schemas/workspace.ts`)
* **Primary Key:** Composite `(workspace_id, user_id)`.
* **Roles:** Built-in enum: `owner`, `admin`, `member`, `viewer` (default: `member`).
* **Invariants:**
  * Partial unique index `workspace_members_unique_active_owner_idx` ensures exactly one active (`deleted_at IS NULL`) owner per workspace.
  * Soft delete support via `deleted_at` timestamp.

### 2.3 Supporting Tenant Tables
* **`workspace_invitations`:** Pending invites scoped to `workspace_id`, email, role, token, and expiry.
* **`workspace_audit_logs`:** Audit trail recording `(workspace_id, user_id, action, resource_type, resource_id, metadata, ip_address)`.
* **`workspace_user_settings`:** Per-user workspace-scoped preferences (e.g. default device, model preferences within workspace).

---

## 3. Resource Boundary Classification

| Resource Table | Tenant Scope | Key Columns | Authorization & Isolation Rule |
| :--- | :--- | :--- | :--- |
| `workspaces` | Tenant Root | `id`, `primary_owner_id` | Member must have active membership in `workspace_members`. Owner/Admin required for mutation. |
| `workspace_members` | Tenant Root | `workspace_id`, `user_id`, `role` | Read: any workspace member. Write/Manage: Admin or Owner. Demote/Transfer Owner: Owner only. |
| `agents` | Workspace / User | `id`, `user_id`, `workspace_id` | If `workspace_id` is set, visible to workspace members with `agent:read`. Managed by creator or Admin. |
| `sessions` | Workspace / User | `id`, `user_id`, `workspace_id` | Conversations within an agent. Scoped by `workspace_id`. |
| `topics` | Workspace / User | `id`, `user_id`, `workspace_id` | Topics within a session. Inherits workspace scope. |
| `messages` | Workspace / User | `id`, `user_id`, `workspace_id`, `agent_id` | Chat messages and completions. Contains `usage` and `metadata`. |
| `files` | Workspace / User | `id`, `user_id`, `workspace_id` | Stored attachments/assets. Must be constrained to `workspace_id`. |
| `knowledge_bases` | Workspace / User | `id`, `user_id`, `workspace_id` | Document corpora for RAG. Must be constrained to `workspace_id`. |
| `tasks` / `works` | Workspace / User | `id`, `user_id`, `workspace_id` | Autonomous tasks and background workflows. Must be scoped to workspace. |
| `agent_provider_accounts`| Workspace / User | `id`, `user_id`, `workspace_id` | External provider OAuth/token vault (Claude Code, Codex, Kimi). Scoped to workspace. |
| `api_keys` | Workspace / User | `id`, `user_id`, `workspace_id` | Programmatic API keys. Personal keys cannot access workspace data; workspace keys cannot access foreign workspaces. |
| `rbac_roles` | Workspace / Global | `id`, `workspace_id` | Null `workspace_id` indicates global system role (e.g. `super_admin`); non-null is custom workspace role. |
| `rbac_user_roles` | Workspace / Global | `user_id`, `role_id`, `workspace_id`| Evaluated in `RbacModel`. Global roles grant permissions across all workspaces. |
| `users` | System / Identity | `id`, `email`, `role`, `banned` | Global user entity. Managed by Better-Auth and Clerk adapters. |
| `auth_sessions` | User | `id`, `user_id`, `token` | HTTP session table managed by Better-Auth. |
| `user_memories` | User | `id`, `user_id` | Personal memory bank for individual user. |

---

## 4. Tenant Isolation Invariants & Vulnerability Analysis

### 4.1 Header Injection (BOLA / IDOR) Risk
* **Observation:** In incoming tRPC requests, `packages/trpc/src/lambda/context.ts` parses `workspaceId = request.headers.get('X-Workspace-Id')`.
* **Critical Invariant:** **Never trust `X-Workspace-Id` alone.**
* In LobeHub OSS, `packages/business-server/src/trpc-middlewares/workspaceAuth.ts` stubbed `requireWorkspaceRole` as a no-op (`opts.next()`).
* In our production SaaS platform, the **SaaS Authorization Service** must intercept every request, verify that `ctx.userId` has an active, non-deleted membership in `workspace_members` for the specified `workspaceId`, and verify that the user's role satisfies the required permission. If invalid, the request must immediately reject with `WORKSPACE_ACCESS_DENIED`.

### 4.2 Cross-Tenant Query Contamination
* **Query Level:** A repository query must never search by `id` alone when retrieving a tenant-owned resource.
* **Bad Pattern:**
  ```typescript
  // VULNERABLE: BOLA / IDOR
  db.query.agents.findFirst({ where: eq(agents.id, agentId) });
  ```
* **Required Pattern:**
  ```typescript
  // SECURE: Strict tenant isolation
  db.query.agents.findFirst({
    where: and(eq(agents.id, agentId), eq(agents.workspaceId, securityContext.workspaceId))
  });
  ```

### 4.3 Database Defense in Depth
* Foreign keys with `ON DELETE CASCADE` exist from `workspace_members`, `workspace_invitations`, and `workspace_audit_logs` to `workspaces(id)`.
* Unique constraint composite indexes prevent duplicate active memberships and multiple owners.
* PostgreSQL Row-Level Security (RLS) is evaluated in ADR 002.
