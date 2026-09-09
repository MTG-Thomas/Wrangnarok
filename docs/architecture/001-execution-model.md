# ADR 001: Saga, Journey, and Operation execution model

**Status:** Draft

## Context

Wrangnarök needs a durable execution contract that belongs to the application rather than leaking Cloudflare Workflows terminology into every public/domain surface.

Upstream Bifrost provides several useful behavioral invariants:

- workflow invocation is asynchronous and returns an execution ID;
- execution summaries and full execution detail are separate surfaces;
- executions retain caller/organization provenance and are authorization-scoped;
- deferred/scheduled execution is a runtime concern, not workflow source identity;
- durable work exposes status, result/error, timestamps and observability;
- cancellation, timeout and retry are explicit semantics;
- retry after ambiguous infrastructure loss is only safe for idempotent side effects.

Cloudflare Workflows provides durable instances and steps, but Wrangnarök should not make Cloudflare's API shape its permanent product contract.

## Decision

### Saga

A **Saga** is a stable, discoverable TypeScript automation definition.

A Saga has durable identity independent of ordinary source edits. Initial discovery/registration mechanics remain TBD, but callers and Signals must not depend solely on a mutable export name or source path.

### Journey

A **Journey** is one durable execution of a Saga.

A Journey is backed initially by a Cloudflare Workflow instance but has its own Wrangnarök record in D1 for discovery, authorization, history, and product-level state.

Initial state model:

```text
Pending -> Running -> Succeeded
                  \-> Failed
                  \-> TimedOut
                  \-> Cancelled
```

`CompletedWithErrors` is intentionally omitted until a concrete Saga use case demonstrates semantics distinct from `Succeeded` with structured warnings or `Failed`.

A Journey record should eventually include at least:

- stable Journey ID;
- Saga ID and source/version metadata sufficient for diagnosis;
- Grove ID/context;
- initiating principal/context where available;
- status;
- created, scheduled, started and completed timestamps as applicable;
- structured result metadata;
- structured error metadata;
- underlying Cloudflare Workflow instance identifier;
- optional idempotency/deduplication key;
- Trail/observability linkage.

### Operation

An **Operation** is a durable unit of Saga execution owned by Wrangnarök semantics and normally backed by a Cloudflare Workflow step.

Operations should be named for diagnostic stability. Their persisted/public representation should not require exposing Cloudflare-internal step representation.

### Invocation

Starting a Saga is asynchronous. The API acknowledges accepted work and returns the Journey identity without waiting for completion.

A later API may support delayed/scheduled start, but First Acorn only requires immediate start.

### Result and error

Successful Journey output must be serializable and bounded. Exact persistence/size thresholds remain to be measured against Workflows and D1 Free limits.

Expected failures should eventually use a structured error shape containing a stable machine-readable code plus safe human-readable message. Internal exception details and secrets must not be exposed by default.

### History versus detail

History/list endpoints should return lightweight Journey summaries suitable for pagination. Full input/result/Trail detail belongs on an individual Journey endpoint. This avoids turning history queries into large D1 reads and mirrors a useful upstream separation.

### Cancellation

Cancellation is a product capability, not assumed behavior. First Acorn may omit user cancellation. When implemented, Wrangnarök must define which states are cancellable and map that deliberately onto Cloudflare Workflow instance controls.

### Retry and idempotency

Do not transparently retry arbitrary Realm mutations merely because infrastructure can retry them. Retry policy must account for whether an Operation is safe/idempotent or has a caller-provided idempotency mechanism.

Cloudflare Workflow step retry behavior is an implementation tool; Wrangnarök should expose only semantics it can explain safely.

## Local testing strategy

Prefer real local Cloudflare emulation over fake interfaces:

1. pure domain tests for state transitions/serialization;
2. Worker-runtime tests with Cloudflare's Vitest integration;
3. local D1 for persistence tests;
4. local Workflows through Wrangler for end-to-end Journey tests;
5. mock external vendor HTTP at the Realm boundary.

This gives us meaningful local confidence without requiring a Cloudflare deployment or vendor credentials.

## Consequences

- D1 intentionally duplicates a small amount of Workflow instance metadata because it is Wrangnarök's query/auth/history surface.
- Cloudflare remains visible in implementation code; this ADR is not a portability abstraction.
- We can change Cloudflare adapter details without renaming product concepts.
- Saga registration/stable identity becomes an early design dependency.

## Open questions

- Exact status mapping from Cloudflare Workflow instances.
- Whether `Pending` and `Scheduled` should be distinct public states once delayed starts ship.
- Input/result size limits and whether larger payloads graduate to R2.
- Operation-level persisted history versus relying partly on Workflow introspection/observability.
- Cancellation guarantees for currently running external HTTP calls.
- Public idempotency-key contract.
