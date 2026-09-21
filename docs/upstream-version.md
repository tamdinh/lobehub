# Upstream Version Pinning

## 1. Repository Identification

* **Upstream Git URL:** `git@github.com:tamdinh/lobehub.git` (forked from `lobehub/lobehub`)
* **Checked-out Branch:** `saas/production-multi-tenant` (branched from upstream commit `5221d09344048d2230bf42acfa3365e5b5d8f5d7`)
* **Pinned Upstream Commit SHA:** `5221d09344048d2230bf42acfa3365e5b5d8f5d7`
* **Upstream Version:** `@lobehub/lobehub` v2.2.17
* **Package Manager:** `pnpm@12.4.1` (configured via `packageManager` and `pnpm-workspace.yaml`)
* **Node.js Engine:** Node.js v26.8.2 (`.nvmrc` specifies `lts/krypton`)

## 2. Infrastructure & Stack Baseline

* **Primary Database:** PostgreSQL (supported via Drizzle ORM `^0.45.2`). Supports `pg.Pool` (Node.js runtime) and `@neondatabase/serverless` (edge/serverless WebSocket runtime).
* **Caching & Realtime Pub/Sub:** Redis (`ioredis` / `@upstash/redis`) via `REDIS_URL`. Falls back to In-Memory (`InMemoryStateManager`, `InMemoryStreamEventManager`) for local/single-process runs.
* **Background Jobs & Workflows:** Upstash Workflow & QStash (`@upstash/workflow`, `@upstash/qstash`).
* **Object / Blob Storage:** S3-compatible API via `@aws-sdk/client-s3` (AWS S3, Cloudflare R2, MinIO).
* **Search / Retrieval:** PostgreSQL Full-Text Search with sync outbox (`fts_search_sync_outbox`), Elasticsearch/Meilisearch sync capabilities.
* **Application Framework:** Next.js 16 (App Router + Pages Router for specific routes), Vite 8 (SPA entry points for Web, Auth, Mobile, Desktop, Share, Workbench), tRPC v11 for RPC routers.
* **Testing Framework:** Vitest 5.0.0.

## 3. Verification Command

To verify tree consistency against this pinned commit:

```bash
git rev-parse HEAD
# Output must be: 5221d09344048d2230bf42acfa3365e5b5d8f5d7
```
