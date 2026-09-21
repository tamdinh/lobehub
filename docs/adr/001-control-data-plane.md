# ADR 001: Separation of SaaS Control Plane and LobeHub Data Plane

## Context
LobeHub is a feature-rich, high-performance open-source AI conversational and agent execution framework. We are converting this codebase into a production commercial multi-tenant AI SaaS platform. The system must support strict tenant isolation, quotas, billing, enterprise administration, and security controls while retaining compatibility with upstream LobeHub releases.

## Problem
Allowing SaaS business rules (such as subscription checks, credit deduction, billing, user moderation, and tenant access rules) to be scattered inside LobeHub's execution runtimes (AgentRuntime, ModelRuntime, ToolRuntime) creates tight coupling, prevents clean upstream merges, and risks security bypasses if an execution path does not trigger a check.

## Options
1. **Option A (Rewrite LobeHub):** Fork and refactor LobeHub internally to embed multi-tenant billing and authorization deep within every runtime loop.
2. **Option B (Separate Microservices):** Build a separate microservice proxy in front of LobeHub that handles auth and billing via HTTP forwarding.
3. **Option C (Logical In-Process Planes — Chosen):** Enforce a strict boundary between two architectural planes within the same logical codebase:
   * **SaaS Control Plane:** Owns Authority (Identity, Organization, Workspace, Membership, Authorization, Entitlements, Billing, Usage, Risk, Approval, Audit).
   * **LobeHub Data Plane:** Owns Execution (Agent Runtime, Model Runtime, Tool Runtime, Workflow, Context Engine).

## Decision
We adopt **Option C**.

Core Invariant:
> **The SaaS layer owns AUTHORITY. LobeHub owns EXECUTION.**

The LobeHub execution engines will never make direct calls to Stripe or billing databases, nor will they make authoritative authorization decisions. All execution requests must pass through the SaaS Control Plane before reaching the LobeHub Data Plane.

## Consequences
* Upstream compatibility is preserved because core engines in `packages/agent-runtime`, `packages/model-runtime`, and `packages/tool-runtime` remain unmodified.
* The SaaS Control Plane intercepts requests at the tRPC boundary (`packages/trpc`, `apps/server/src/routers/lambda`).
* All operations are auditable and subject to authorization before execution begins.

## Rejected Alternatives
* **Option A:** Rejected because it violates Rule 4 ("Do not rewrite LobeHub") and would destroy upstream mergeability.
* **Option B:** Rejected because it violates Rule 10 ("Do not over-engineer / Do not introduce microservices") and adds unnecessary operational overhead and network latency.
