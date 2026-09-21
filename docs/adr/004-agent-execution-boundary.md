# ADR 004: Agent Execution Boundary & Interception Hooks

## Context
Executing an AI agent involves resolving configuration, selecting models, evaluating prompts, calling LLM provider APIs, executing tools (system, browser, shell, MCP), streaming tokens back to the user, and recording message history.

## Problem
In a commercial SaaS platform, agent execution is where security risks, cost generation, and tenant isolation converge:
1. AI agents are untrusted decision makers (Rule 6).
2. Agent execution incurs direct financial cost (LLM tokens).
3. Agents must not access another tenant's files, tools, or memory.
4. Completion must trigger immutable accounting usage events (Rule 8).

## Options
1. **Option A (Internal Agent Runtime Modification):** Alter `packages/agent-runtime/src/core/runtime.ts` to inject SaaS billing checks and database queries during the execution loop.
2. **Option B (SaaS AgentService Boundary Wrapper — Chosen):**
   * Keep `packages/agent-runtime` unmodified.
   * Implement a SaaS `AgentService` boundary between tRPC routers and `AgentRuntimeService`.
   * Enforce Pre-Flight Checks: Identity -> Actor -> Scope -> Authorization -> Quota & Credit Reservation.
   * Attach `run_id`, `trace_id`, `workspace_id`, and `actor_id` to the execution context.
   * Intercept completion via the existing `CompletionLifecycle` seam to emit immutable usage events and audit records.

## Decision
We adopt **Option B**.

Execution Flow:
```text
Request (tRPC: aiAgent.createAgentOperation / execAgent)
  │
  ▼
createLambdaContext (Resolves identity, traceparent)
  │
  ▼
AuthorizationService (Validates workspace membership, agent:execute permission)
  │
  ▼
Entitlement & Quota Check (Validates available credits / token allowance)
  │
  ▼
SaaS AgentService
  │  ├── Allocates run_id
  │  ├── Creates audit log entry: AGENT_RUN_STARTED
  │  └── Sets up usage capture hook
  ▼
LobeHub AgentRuntimeService (`apps/server/src/services/agentRuntime`)
  │
  ▼
Completion Lifecycle Hook
  │  ├── Emits immutable `usage_event` (tokens, model, cost)
  │  ├── Deducts credits from tenant wallet
  │  └── Creates audit log entry: AGENT_RUN_COMPLETED
  ▼
Result Streamed to Client
```

## Consequences
* Core `agent-runtime` remains 100% upstream-compatible.
* LLM costs are strictly tracked in an immutable accounting ledger.
* High-risk actions by agents are subject to approval policies.

## Rejected Alternatives
* **Option A:** Rejected because modifying `packages/agent-runtime` internals violates Rule 4 ("Do not rewrite LobeHub") and risks subtle regressions in streaming and error handling.
