# Roadmap

Wrangnarök grows by proving Bifrost-like product capabilities on Cloudflare primitives without prematurely recreating Bifrost's infrastructure.

## Phase 0 — The First Acorn

Goal: prove the minimal durable execution loop on Cloudflare Free.

- Worker API
- D1 catalog/Trail
- one TypeScript Saga
- one Journey
- multiple durable Operations backed by Workflow steps
- one simple HTTP Realm
- execution status/results
- failure test
- documented Free-tier consumption

Tracked by issue #1.

## Phase 1 — Identity before features

Before adding lots of integrations, settle the contracts that are expensive to change later:

- stable Saga identity independent of source edits
- Saga discovery/registration model
- Journey and Operation state model
- Grove context propagation
- Realm vs Connection contract
- local-development behavior
- source metadata vs persisted runtime policy

## Phase 2 — Real orchestration

Prove that the model handles useful API automation:

- second Realm
- multi-Realm Saga
- retries and actionable downstream errors
- sleeps/waits
- cancellation/timeout investigation
- concurrency and idempotency rules
- Trail querying
- schedules/webhook Signals

Only introduce Queues or Durable Objects when a demonstrated orchestration requirement needs them.

## Phase 3 — Multi-tenant Connections

- Grove model
- Connection resolution
- secure credential storage decision
- first OAuth Realm
- token refresh lifecycle
- tenant isolation tests
- authorization model

Security design is a gate here, not cleanup afterward.

## Phase 4 — Author-facing platform surfaces

Investigate/adapt upstream capabilities:

- Tables over D1
- Forms
- Artifacts/files over R2
- richer Signals/topics
- static web UI
- role/policy model as justified

## Phase 5 — Portable bundles

Explore the strongest ideas from Bifrost Solutions without blindly cloning their implementation:

- portable definition vs Grove installation
- manifests/catalog
- one definition installed in many Groves
- environment state excluded from source packages
- declarative ownership/reconciliation
- versioning/export/install

## Phase 6 — AI/tool surface

Only after the ordinary orchestration platform is coherent:

- opt-in tool exposure for Sagas/Realm Actions
- agent/MCP integration
- tool discovery metadata
- permission preservation through AI callers

## Continuous upstream-spec work

For every phase, compare against current `gobifrost/bifrost` docs, source, and tests. Record behavioral invariants in `docs/upstream-spec.md`. Upstream is allowed to teach Wrangnarök product lessons without dictating its infrastructure.
