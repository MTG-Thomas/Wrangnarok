# ADR 008: Full-stack app on a single Worker

- **Status:** Accepted
- **Date:** 2026-09-09

## Context

Upstream Bifrost is full-stack: a React + Vite SPA (`client/`) backed by a FastAPI service with PostgreSQL/Redis/RabbitMQ. Wrangnarök's MVP slice is API-only by design (`docs/roadmap.md` Phase 0: JSON history + detail API, tiny debug page only if cheap).

The open question was whether Wrangnarök stays an API-only service with a thin debug page, or commits to a full browser UI. Decision: Wrangnarök is a full-stack app, matching Bifrost's product surface with Cloudflare primitives.

## Decision

1. One Cloudflare Worker serves both the browser UI and the JSON API (single deployment). The UI is bundled as Workers Static Assets; API routes stay under `/api/*`.
2. No separate Pages project and no separate frontend deployment. Frontend + backend ship together via Wrangler.
3. UI tentpole is Vite + React, following Bifrost's `client/` patterns (AGPL-3.0, preserve attribution where adapted). Full UI lands in Phase 4; Phase 0 stays API + optional tiny debug page.
4. Backend stays Worker + Workflows + D1. Static Assets is part of the Worker's deployment, not a new infrastructure dependency. Any further primitive (Queue, Durable Object, R2, KV) still must be earned per AGENTS.md constraint 7.
5. Product boundaries carry over to the UI: explicit Organization context, authorization-checked reads, and secrets never in browser/client code or execution output (`docs/upstream-spec.md` invariants 3, 5, 7).

## Consequences

- `README.md` Initial architecture and `docs/roadmap.md` Phase 4 now describe the full-stack target.
- Phase 4 work is a strangler port of Bifrost UI surfaces (History, Execution detail, dashboard first), pointed at Wrangnarök's `/api/*`, not a full `client/` lift.
- Bifrost UI assumptions that do not fit must be adapted: nginx serving, Vite `/api` proxy to FastAPI, Redis sessions, WebSocket subscribe, Minio paths.
- Free-tier viability must be measured for the served UI like any other capability (requests, bandwidth, build size).
