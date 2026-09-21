# LobeHub Reuse Map

## Capability Classification Matrix

| Capability | Status | Existing Location | Reuse Strategy |
| :--- | :--- | :--- | :--- |
| **Authentication** | `EXISTING_UPSTREAM` | `src/auth.ts`, `src/libs/better-auth/`, `packages/database/src/schemas/betterAuth.ts` | Reuse Better-Auth and OIDC JWT mechanisms as-is. Map resolved user identity directly into SaaS `ActorContext`. |
| **Organization** | `ADAPTER_REQUIRED` | N/A (implicit in `workspaces`) | Adapt `Workspace` as the primary tenant container, or provide an Organization adapter mapping 1:1 or 1:N to Workspaces for enterprise hierarchies. |
| **Workspace** | `EXISTING_UPSTREAM` | `packages/database/src/models/workspace.ts`, `schemas/workspace.ts` | Reuse schema and model. Implement the missing router procedures (`create`, `update`, `list`) currently stubbed in `packages/business-server`. |
| **Membership** | `EXISTING_UPSTREAM` | `packages/database/src/models/workspaceMember.ts`, `schemas/workspace.ts` | Reuse existing schema, built-in roles (`owner`, `admin`, `member`, `viewer`), and single-owner invariant. |
| **RBAC** | `PARTIALLY_REUSABLE` | `packages/database/src/models/rbac.ts`, `packages/const/src/rbac.ts` | Reuse permission matrix and `RbacModel`. Replace stubbed middlewares in `packages/business-server/src/trpc-middlewares/` with an authoritative `AuthorizationService`. |
| **Database** | `EXISTING_UPSTREAM` | `packages/database/` (Drizzle ORM, schemas, migrations) | Reuse database infrastructure and migrations. Add net-new tables for SaaS billing, entitlements, and immutable usage ledger via standard Drizzle migrations. |
| **Agent Runtime** | `EXISTING_UPSTREAM` | `packages/agent-runtime/`, `apps/server/src/services/agentRuntime/` | **DO NOT REWRITE.** Preserve upstream execution engine. Intercept requests at the tRPC boundary before dispatching to `AgentRuntimeService`. |
| **Model Runtime** | `EXISTING_UPSTREAM` | `packages/model-runtime/`, `packages/model-bank/` | Reuse 89 provider adapters and streaming infrastructure. Wrap provider selection behind SaaS Model Catalog. |
| **Tool Runtime** | `EXISTING_UPSTREAM` | `packages/tool-runtime/`, `packages/builtin-tools/` | Reuse typed tool invocation pipeline. Add administrative typed tools adhering to the same interface. |
| **Workflow** | `EXISTING_UPSTREAM` | `apps/server/src/workflows/`, `@upstash/workflow` | Reuse Upstash Workflow integration for background jobs, ensuring security context is passed into all steps. |
| **Agent Signal** | `EXISTING_UPSTREAM` | `packages/agent-signal/`, `apps/server/src/services/agentSignal/` | Reuse intent analysis and background signaling engines. |
| **Observability** | `EXISTING_UPSTREAM` | `packages/observability-otel/`, `packages/agent-tracing/` | Reuse OpenTelemetry SDK and tracing. Propagate `requestId`, `traceId`, `actorId`, `workspaceId`, `runId` on all spans. |
| **Usage** | `NET_NEW` | `apps/server/src/services/usage/` (OSS aggregates from `messages` table) | Build an immutable Usage Ledger (`usage_events`, adjustments, reversals) to replace mutable/derived message counts for financial accounting. |
| **Billing** | `NET_NEW` | N/A | Implement `BillingService` abstraction with Stripe adapter, credit grants, quotas, and subscription state tracking. |
| **Admin** | `NET_NEW` | `packages/database/migrations/0053_better_auth_admin.sql` (banning flag only) | Implement typed administrative tools (`admin.user.suspend`, `admin.workspace.freeze`, `admin.agent.retry`, `admin.model.disable`) with idempotency and audit logs. |
