# ADR 003: Authoritative Authorization Service & SecurityContext

## Context
In LobeHub's open-source codebase, `packages/trpc/src/lambda/context.ts` reads `X-Workspace-Id` directly from request headers. In `packages/business-server/src/trpc-middlewares/`, the procedures `requireWorkspaceRole` and `withRbacPermission` are declared as no-op stubs (`opts.next()`).

## Problem
Allowing client-supplied workspace identifiers to pass through without server-side validation is a critical security vulnerability (BOLA / IDOR). An authenticated user could send `X-Workspace-Id: <victim_workspace>` and access or mutate another tenant's agents, messages, or files.

## Options
1. **Option A (Ad-Hoc Procedure Guards):** Manually insert database membership queries at the top of every tRPC procedure.
2. **Option B (SaaS AuthorizationService & SecurityContext Middleware — Chosen):**
   * Introduce a strongly-typed `ActorContext` and `SecurityContext`.
   * Implement an authoritative `AuthorizationService` that resolves the actor, validates active membership in `workspace_members`, verifies role requirements, and evaluates RBAC permissions against `RbacModel`.
   * Override `packages/business-server/src/trpc-middlewares/workspaceAuth.ts` and `rbacPermission.ts` to enforce this check globally across all procedures.

## Decision
We adopt **Option B**.

We introduce:
```typescript
export type ActorContext = {
  actorType: 'USER' | 'SERVICE' | 'AGENT' | 'SYSTEM' | 'ADMIN';
  actorId: string;
  authSource: 'BETTER_AUTH' | 'OIDC' | 'API_KEY' | 'SYSTEM';
};

export type SecurityContext = {
  actor: ActorContext;
  organizationId?: string;
  workspaceId?: string;
  membershipId?: string;
  systemRole?: string;
  workspaceRole?: 'owner' | 'admin' | 'member' | 'viewer';
  permissions: string[];
  requestId: string;
  traceId?: string;
  runId?: string;
  agentId?: string;
};
```

All incoming requests must pass through `AuthorizationService.authorize()`:
1. Validates identity (`actorId`).
2. If `workspaceId` is requested, queries `workspace_members` table for `(workspaceId, actorId)`. If no active (`deletedAt IS NULL`) membership exists, immediately rejects with `WORKSPACE_ACCESS_DENIED`.
3. If workspace is `frozen`, blocks state-changing operations.
4. Checks whether the caller's effective role / permissions permit the action.

## Consequences
* Completely closes IDOR and BOLA vulnerabilities across all tRPC endpoints.
* Frontend `X-Workspace-Id` is treated purely as a routing hint, never as an authorization token.
* Centralizes audit logging for unauthorized access attempts.

## Rejected Alternatives
* **Option A:** Rejected because ad-hoc checks are error-prone, duplicate code, and risk being forgotten on new endpoints.
