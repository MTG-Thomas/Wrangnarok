# Roadmap

Wrangnarök grows by proving Bifrost-like product capabilities on Cloudflare primitives without prematurely recreating Bifrost's infrastructure.

## Phase 0 — The First Acorn

Goal: prove the minimal durable execution loop on Cloudflare Free.

- Worker API
- D1 catalog/ExecutionHistory with `org_id` column on all Execution/Connection/ExecutionHistory rows from day one
- single default Organization (`default` stub ID); explicit propagation via `ctx`; no multi-tenancy/auth yet
- one TypeScript Saga
- one Execution
- multiple durable Operations backed by Workflow steps
- one simple HTTP Integration
- execution status/results (JSON history + detail API; tiny read-only debug page if cheap — full static web UI stays Phase 4)
- idempotency conflict (409) + 10-minute admission expiry + HTTP hardening per ADR 001
- failure test
- documented Free-tier consumption

Tracked by issue #1.

## Phase 1 — Identity before features

Before adding lots of integrations, settle the contracts that are expensive to change later:

- stable Saga identity independent of source edits
- Saga discovery/registration model
- Execution and Operation state model
- Organization context propagation via `ctx` (builds on Phase 0 `default` stub; still no multi-tenancy/auth)
- Integration vs Connection contract
- local-development behavior
- source metadata vs persisted runtime policy

## Phase 2 — Real orchestration

Prove that the model handles useful API automation:

- second Integration
- multi-Integration Saga
- retries and actionable downstream errors
- sleeps/waits
- cancellation/timeout investigation
- concurrency and idempotency rules
- ExecutionHistory querying
- schedules/webhook Triggers

Only introduce Queues or Durable Objects when a demonstrated orchestration requirement needs them.

## Phase 3 — Multi-tenant Connections

- full Organization model: multi-tenancy, isolation, and authorization (extends Phase 0 `default` stub and `org_id` columns; no schema retrofit)
- Connection resolution
- secure credential storage decision (see ADR 005; Proposed, not production-approved)
- first OAuth Integration
- token refresh lifecycle
- tenant isolation tests
- authorization model

Security design is a gate here, not cleanup afterward.

Phase 0's `default` stub exists precisely to avoid retrofitting `org_id` later.

## Phase 4 — Author-facing platform surfaces

Investigate/adapt upstream capabilities:

- Tables over D1
- Forms
- Artifacts/files over R2
- richer Triggers/topics
- static web UI
- role/policy model as justified

## Phase 5 — Portable bundles

Explore the strongest ideas from Bifrost Solutions without blindly cloning their implementation:

- portable definition vs Organization installation
- manifests/catalog
- one definition installed in many Organizations
- environment state excluded from source packages
- declarative ownership/reconciliation
- versioning/export/install

## Phase 6 — AI/tool surface

Only after the ordinary orchestration platform is coherent:

- opt-in tool exposure for Sagas/Integration Actions
- agent/MCP integration
- tool discovery metadata
- permission preservation through AI callers

## Continuous upstream-spec work

For every phase, compare against current `gobifrost/bifrost` docs, source, and tests. Record behavioral invariants in `docs/upstream-spec.md`. Upstream is allowed to teach Wrangnarök product lessons without dictating its infrastructure.
