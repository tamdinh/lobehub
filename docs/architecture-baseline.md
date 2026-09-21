# Architecture Baseline

## 1. Repository Architecture
* **Type:** Monorepo managed with `pnpm@12.4.1` (using workspace protocol `pnpm-workspace.yaml`).
* **Root Application:** `@lobehub/lobehub` (v2.2.17) containing Next.js 16 web app, Vite-based Single Page Applications (`public/_spa*`), and desktop integration.
* **Workspace Packages (`packages/`):**
  * `agent-runtime`, `agent-tracing`, `agent-signal`, `conversation-flow`, `context-engine`
  * `database`: Drizzle ORM schemas, migration scripts, models, and repositories.
  * `model-runtime`: 89 LLM provider integrations with streaming adapters.
  * `model-bank`: Model catalog definitions, default pricing, parameters.
  * `tool-runtime`: Execution runtimes for tools (computer, local system, shell).
  * `builtin-tools`: Registered tool manifests and executors.
  * `observability-otel`: OpenTelemetry tracer and metric instrumentation.
  * `business`, `business-server`: Business layer stubs and cloud interfaces.
  * `types`, `const`, `utils`, `env`, `app-config`: Shared foundational modules.
* **Applications (`apps/`):**
  * `apps/server`: Backend tRPC routers (`lambda`, `async`, `tools`), server services, and Upstash workflows.
  * `apps/desktop`: Electron client wrapper.
  * `apps/cli`: CLI utility (`lh`).
  * `apps/auth`, `apps/share`, `apps/workbench`: Sub-applications for specialized flows.

---

## 2. Runtime Architecture
* **Next.js & Vite Hybrid:** Next.js serves SSR/API routes; Vite builds client-side SPAs.
* **tRPC Gateway:** Client-to-server communication is mediated through tRPC procedures (`packages/trpc`, `apps/server/src/routers/lambda`).
* **Execution Engines:**
  * Synchronous mode: Direct execution in Node.js server.
  * Asynchronous/Queue mode: Redis-backed state management (`AgentStateManager`) and pub/sub event streaming (`StreamEventManager`).

---

## 3. Authentication Architecture
* **Primary Auth Engine:** Better-Auth (`better-auth@1.6.15`), persisted in PostgreSQL via Drizzle (`packages/database/src/schemas/betterAuth.ts`, `users` table).
* **Enterprise SSO / OIDC:** Optional OIDC JWT validation via `validateOIDCJWT` (`packages/trpc/src/lambda/context.ts`).
* **API Key Authentication:** Header `X-API-Key` validated in `createLambdaContext`, bound to `userId` and optionally `workspaceId` with defined capability scopes.
* **Session Resolution:** Evaluated per request in `createLambdaContext` via `auth.api.getSession({ headers })`.

---

## 4. Organization Architecture
* **Status:** In LobeHub OSS, there is no separate `organizations` table.
* **SaaS Requirement:** Commercial SaaS multi-tenancy requires top-level accounts (Organizations) that can contain billing profiles, quotas, and multiple Workspaces.
* **Seam:** An Organization layer maps 1:1 or 1:N with Workspaces. In single-workspace scenarios, Organization and Workspace coalesce cleanly.

---

## 5. Workspace Architecture
* **Model:** `packages/database/src/models/workspace.ts` (`WorkspaceModel`).
* **Schema:** `workspaces` table containing `id` (NanoId 16), `slug`, `name`, `primaryOwnerId`, `settings`, `frozen`.
* **State Management:**
  * Freezing: `frozen = true` disables workspace actions.
  * Ownership Transfer: Atomic transaction updating `primaryOwnerId` and demoting prior owner to admin.

---

## 6. Membership Architecture
* **Model:** `packages/database/src/models/workspaceMember.ts` (`WorkspaceMemberModel`).
* **Schema:** `workspace_members` with composite PK `(workspace_id, user_id)`.
* **Roles:** `owner`, `admin`, `member`, `viewer`. Exactly one active `owner` per workspace enforced by partial unique index.
* **Lifecycle:** Supports soft deletion via `deleted_at`.

---

## 7. Authorization Architecture
* **Database Layer:** `packages/database/src/models/rbac.ts` (`RbacModel`).
* **Matrix Definition:** `packages/const/src/rbac.ts` (`WORKSPACE_ROLE_PERMISSIONS`).
* **Runtime Interceptors:**
  * `packages/business-server/src/trpc-middlewares/workspaceAuth.ts`
  * `packages/business-server/src/trpc-middlewares/rbacPermission.ts`
* **Vulnerability in OSS:** Middleware stubs are no-ops (`opts.next()`). In the SaaS platform, these must delegate to `AuthorizationService`.

---

## 8. Database Architecture
* **ORM:** Drizzle ORM (`drizzle-orm@0.45.2`), declarative schemas in `packages/database/src/schemas`.
* **Adaptor:** `packages/database/src/core/web-server.ts` supporting `node-postgres` and `@neondatabase/serverless`.
* **Migrations:** Managed via `drizzle-kit` in `packages/database/migrations`.

---

## 9. Tenant Boundaries
* Every tenant-scoped entity (`agents`, `sessions`, `topics`, `messages`, `files`, `knowledge_bases`, `tasks`, `api_keys`) must carry `workspace_id`.
* All queries must include `where(eq(table.workspaceId, securityContext.workspaceId))`.

---

## 10. Agent Execution Flow
```text
Client (Web / Desktop / API)
  │ (tRPC: aiAgent.createAgentOperation / execAgent)
  ▼
createLambdaContext (Resolves userId, validates apiKey, reads X-Workspace-Id)
  │
  ▼
SaaS Security & Authorization Interceptor (Validates membership, permissions, quota)
  │
  ▼
apps/server/src/services/agentRuntime/AgentRuntimeService.ts
  │
  ▼
packages/agent-runtime/src/core/runtime.ts (Agent execution loop)
  │
  ▼
packages/model-runtime/src (Provider streaming)
  │
  ▼
Completion Lifecycle & Usage Extraction
```

---

## 11. Model Execution Flow
* Dispatched via `ModelRuntime` (`packages/model-runtime/src`).
* Selects provider runtime dynamically from `runtimeMap.ts`.
* Unifies parameter translation, streaming SSE formatting, and token calculation.

---

## 12. Tool Execution Flow
* Dispatched via `ToolExecutionService` (`apps/server/src/services/toolExecution`).
* Coordinates builtin tools (`BuiltinToolsExecutor`), MCP tools (`mcpService`), and local system commands (`tool-runtime`).
* Security Invariant: Agents never receive raw database credentials, direct shell execution without isolation, or untyped execution.

---

## 13. Workflow / Background Architecture
* Managed via Upstash Workflow & QStash (`@upstash/workflow`).
* Step execution helpers in `apps/server/src/workflows/step.ts` handle JSON replay serialization.
* Background jobs must carry full security context (`actor`, `workspaceId`, `runId`).

---

## 14. Observability Architecture
* OpenTelemetry instrumentation in `packages/observability-otel`.
* Auto-instrumentation for HTTP, Node.js runtime, and PostgreSQL (`@opentelemetry/instrumentation-pg`).
* Correlates `traceId`, `requestId`, `runId`, `actorId`, `workspaceId`.

---

## 15. Business / Cloud Architecture
* Business layer isolated in `packages/business`, `packages/business-server`, and `src/business/server`.
* Allows overriding open-source stubs without modifying upstream core code.

---

## 16. Existing Admin Architecture
* OSS has only basic user banning (`users.banned`) and workspace freezing (`workspaces.frozen`).
* No dedicated administrative console or typed administrative tools exist.

---

## 17. Existing Usage / Billing Architecture
* OSS aggregates token usage on-the-fly from `messages.usage` and `messages.metadata`.
* No immutable ledger, no credit wallet, no subscription enforcement, no Stripe adapter exists in OSS.

---

## 18. Extension Points
* **tRPC Middleware Seam:** `packages/business-server/src/trpc-middlewares/`
* **Path Override Seam:** `tsconfig.json` path alias `@/business/server/*`
* **Database Migration Seam:** Adding new schemas in `packages/database/src/schemas` and running Drizzle migrations.
* **Agent Completion Lifecycle Hooks:** Intercepting completion in `CompletionLifecycle` to write usage events.

---

## 19. Areas NOT Safe to Modify
* `packages/agent-runtime/src/core/runtime.ts`: Core streaming and execution logic.
* `packages/model-runtime/src/providers/`: Provider-specific LLM implementations.
* `packages/database/src/schemas/user.ts`: Better-Auth table contracts.
* Upstream git commits: Do not modify historical commits or diverge from pinned upstream.

---

## 20. Architectural Gaps
1. **No Authoritative SaaS SecurityContext:** Context in tRPC passes untrusted `workspaceId` without enforced role binding.
2. **No Immutable Usage Ledger:** Token tracking is mutable and coupled to message rows.
3. **No Commercial Entitlement / Quota Engine:** Free-tier or plan limits are not enforced.
4. **No Typed Administrative Operations:** Admins have no retry-safe, auditable tools.
