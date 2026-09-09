# Upstream Bifrost capability map

This document treats `gobifrost/bifrost` as a behavioral/product reference for Wrangnarök rather than as an implementation to port.

Status vocabulary:

- **Adopt** — preserve the capability substantially as-is at the product level.
- **Adapt** — preserve the intent, but redesign it around Cloudflare primitives.
- **Defer** — plausible Wrangnarök capability, but not needed for the current milestone.
- **Reject** — deliberately outside the experiment.
- **Investigate** — upstream behavior or Cloudflare fit needs more study.

| Upstream capability | Status | Wrangnarök direction | Candidate Cloudflare primitive |
| --- | --- | --- | --- |
| Code-first workflows | **Adopt** | TypeScript **Sagas** | Workflows |
| Workflow executions | **Adapt** | **Journeys** with durable Operations | Workflow instances + D1 Trail |
| Reusable integrations | **Adopt** | Typed **Realms** | Worker TypeScript modules |
| Multi-tenancy / organizations | **Adopt** | **Groves** | D1 initially |
| Connection/config management | **Adopt** | **Connections** scoped to Groves | D1 + Worker secrets where appropriate |
| OAuth management / refresh | **Defer** | Realm-specific auth contract with common helpers | Worker + D1/secrets |
| Secret management | **Investigate** | Do not invent application crypto casually; determine safe Cloudflare-native tenant-secret model | Secrets / bindings / possibly encrypted D1 data |
| Dynamic forms | **Defer** | Preserve only after execution core works | Worker + static UI + D1 |
| Tables / application storage | **Adapt** | Determine minimum user-facing data model rather than mirroring Postgres | D1 |
| Triggers | **Adopt** | **Signals** | HTTP / Cron / other event sources |
| Async execution queue | **Adapt** | Use only where Workflows alone do not provide required semantics/backpressure | Queues if earned |
| Cache/session layer | **Reject as required architecture** | Add caching only for demonstrated need | KV / Cache API / Durable Objects if earned |
| Object storage | **Defer** | **Artifacts** when Sagas need files or larger outputs | R2 |
| Scheduler service | **Adapt** | No persistent scheduler process | Cron Triggers / Workflows |
| Persistent worker processes | **Reject** | Execution should live in Cloudflare primitives | Workers / Workflows |
| Hot reload | **Adapt** | Standard local Worker development experience | Wrangler |
| Git-based workflow management | **Adopt** | Sagas and Realms are ordinary version-controlled TypeScript | GitHub |
| AI-assisted development | **Adopt as philosophy** | Keep APIs/types easy for coding agents to understand | TypeScript types + docs/tests |
| Monitoring / execution history | **Adopt** | **Trail** | D1 + Workers observability |
| Self-host anywhere | **Reject** | This experiment is intentionally Cloudflare-native | Cloudflare |
| PostgreSQL | **Reject as implementation dependency** | Re-evaluate required data semantics against D1 | D1 |
| Redis | **Reject as implementation dependency** | Replace only actual behaviors, not the product | Native primitives as needed |
| RabbitMQ | **Reject as implementation dependency** | Workflows first; Queues for actual queue semantics | Workflows / Queues |
| Docker Compose deployment | **Reject** | Deployment target is Cloudflare | Wrangler |

## Questions to answer from upstream

This is deliberately incomplete. Future spec sweeps should inspect upstream behavior and documentation for at least:

1. Exact Saga/workflow authoring and discovery contract.
2. Execution lifecycle, retries, failure semantics, cancellation, and status model.
3. Integration module contract and how integrations expose reusable functionality.
4. Organization scoping and tenant-isolation guarantees.
5. Connection configuration, OAuth lifecycle, and secret boundaries.
6. Trigger types and scheduling semantics.
7. Tables/storage behavior used directly by workflow authors.
8. Forms and dynamic data-provider behavior.
9. Solutions/packages and how multiple capabilities are bundled/distributed.
10. Agents and any newer upstream abstractions that overlap with Cloudflare primitives.
11. Audit/monitoring expectations.
12. API surface needed by the UI and external callers.

For each area, capture **observable behavior and invariants first**. Avoid copying implementation structure unless there is a concrete compatibility reason.

## Free-tier rule

Every proposed capability should answer:

> Can a small but useful deployment exercise this capability indefinitely within Cloudflare Free allowances?

If not, document the exact limit or missing primitive. Paid-tier escape hatches are useful findings, but they are not MVP defaults.
