# Business & Cloud Overlay Map

## 1. Architectural Overlay Strategy

LobeHub was designed with an overlay separation between:
1. **Core Open-Source Software (OSS):** Base chatbot and single-tenant/self-hosted features (`apps/server`, `src/`, `packages/*`).
2. **Business Stubs (`packages/business-server`):** Type-compatible placeholders that allow open-source code to compile without depending on proprietary SaaS backends.
3. **Cloud Overlay:** In official LobeHub Cloud, proprietary implementations override the stubs in `packages/business-server/src` via path priority or build flags.

Our commercial SaaS platform leverages this exact extension seam to inject real enterprise SaaS multi-tenancy, RBAC, billing, and administration without modifying upstream core engines.

---

## 2. tsconfig Path Override Seam

In `/workspace/lobehub/tsconfig.json`:
```json
"paths": {
  "@/business/server/*": [
    "./packages/business-server/src/*",
    "./src/business/server/*"
  ]
}
```

When building or running with custom business modules, any implementation placed in `./src/business/server/*` or injected into `./packages/business-server/src/*` takes immediate effect across all consumers in `apps/server/src/routers/lambda/`.

---

## 3. Detailed Audit of Business Modules & Stubs

| Module Path | Current OSS Implementation | Commercial SaaS Implementation Requirement |
| :--- | :--- | :--- |
| `packages/business-server/src/lambda-routers/workspace.ts` | **Stubbed:** `create`, `update`, `ensureMarketOrganization` throw `cloudOnly('NOT_IMPLEMENTED')`. `getById`, `list`, `getStatistics` return dummy data. | **Replace with SaaS Workspace Service:** Backed by PostgreSQL `workspaces`, `workspace_members`, `workspace_audit_logs`. Full CRUD, invitations, transfer, stats. |
| `packages/business-server/src/trpc-middlewares/workspaceAuth.ts` | **Stubbed:** `requireWorkspaceRole` is a no-op `opts.next()`. `cloudWorkspaceAuth` returns `undefined` slug. | **Replace with SaaS Workspace Auth:** Verifies active membership in DB, enforces built-in roles (`owner`, `admin`, `member`, `viewer`), throws `TRPCError(UNAUTHORIZED)` on failure. |
| `packages/business-server/src/trpc-middlewares/rbacPermission.ts` | **Stubbed:** `withRbacPermission`, `withAnyRbacPermission`, `withScopedPermission` are no-ops (`opts.next()`). | **Replace with SaaS RBAC Guard:** Calls `RbacModel` / `AuthorizationService` to evaluate user's effective permissions for `(userId, workspaceId)`. |
| `packages/business-server/src/workspaceApiKey.ts` | **Stubbed:** Returns true if workspace has key. | **Extend with Entitlement Gate:** Verifies plan tier and workspace quota allow API key usage. |
| `packages/business-server/src/agent-run/` | Implements agent intervention review routines (`agentInterventionReview.ts`, `heteroInterventionReview.ts`). | **Reusable:** Integrates with human-in-the-loop approvals. |
| `packages/business-server/src/openapiUsage.ts` | Logs usage records. | **Extend with SaaS Usage Ledger:** Emit immutable usage events to financial ledger. |
| `packages/business-server/src/aiProvider.ts` | Provider credential resolution stub. | **Extend with SaaS Model Catalog:** Vaults credentials securely, prevents leakage to agents. |

---

## 4. Build-Time Flags and Environment Variables

* `AUTH=true`: Builds SPA with auth entry point enabled (`vite.config.ts`, `scripts/copySpaBuild.mts`).
* `MOBILE=true`: Builds mobile-specific bundle.
* `DOCKER=true`: Optimizes Next.js output for standalone container deploy.
* `MIGRATION_DB=1`: Tells database adaptor to initialize WebSocket constructor for Neon or run direct migrations.
* `ENABLE_OIDC=1`: Activates OIDC SSO middleware and JWT validation.
* `AGENT_RUNTIME_MODE=queue`: Enables Redis-backed task queue instead of direct sync execution.
