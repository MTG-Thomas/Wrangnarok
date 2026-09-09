# ADR 001: Saga, Execution, and Operation execution model

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

A Saga has durable identity independent of ordinary source edits. Initial discovery/registration mechanics remain TBD, but callers and Triggers must not depend solely on a mutable export name or source path.

Saga `run` bodies execute under Cloudflare Workflows determinism constraints (see ADR 002 example). All I/O, nondeterminism, and Integration calls MUST live inside Operations (`ctx.step.do(...)`); direct `fetch()` / `Date.now()` / `Math.random()` / top-level `ctx.integrations.*` in `run` fails review. Saga inputs/outputs MUST be serializable JSON.

### Execution

An **Execution** is one durable execution of a Saga.

An Execution is backed initially by a Cloudflare Workflow instance but has its own Wrangnarök record in D1 for discovery, authorization, history, and product-level state.

An Execution record must include `org_id` from day one. First Acorn ships a single default Organization (`default` stub ID) propagated explicitly via `ctx`; multi-tenancy and authorization are deferred to Phase 3.

Initial state model:

```text
Pending -> Running -> Succeeded
                  \-> Failed
                  \-> TimedOut
                  \-> Cancelled
```

State definitions:

- `Pending`: D1 row exists. No confirmed Cloudflare Workflow instance. This is the only state that can exist without a Workflow instance.
- `Running`: Cloudflare Workflow instance has accepted the Execution (`create()` succeeded and/or the Workflow has reported back). Covers queued, executing, sleeping, and waiting-on-`step`.
- `Succeeded` / `Failed` / `TimedOut` / `Cancelled`: terminal. Written once via the status callback (see below). No transitions out.

Allowed transitions:

```text
Pending -> Running | Failed | Cancelled
Running -> Succeeded | Failed | TimedOut | Cancelled
```

No other transitions are legal. Unit-test the transition table as pure TypeScript.

`CompletedWithErrors` is intentionally omitted until a concrete Saga use case demonstrates semantics distinct from `Succeeded` with structured warnings or `Failed`.

The full Execution record should eventually include at least:

- stable Execution ID (`executionId`, UUIDv7, TEXT PRIMARY KEY; also used as the Cloudflare Workflow instance `id`);
- Saga ID and source/version metadata sufficient for diagnosis;
- Organization ID/context (required; `default` stub in Phase 0/1);
- initiating principal/context where available;
- status;
- created, scheduled, started and completed timestamps as applicable;
- structured result metadata;
- structured error metadata;
- underlying Cloudflare Workflow instance identifier (`workflow_instance_id TEXT`; equals `executionId` in First Acorn, kept separate so a future binding can diverge);
- idempotency key (`idempotency_key TEXT NOT NULL UNIQUE`; see below);
- `create_attempts INTEGER NOT NULL DEFAULT 1`;
- ExecutionHistory/observability linkage.

### Operation

An **Operation** is a durable unit of Saga execution owned by Wrangnarök semantics and normally backed by a Cloudflare Workflow step.

Operations should be named for diagnostic stability. Their persisted/public representation should not require exposing Cloudflare-internal step representation.

First Acorn Operation defaults (ported from Cloudflare-native lab spike):

- stable step names per Saga version (e.g. `inventory-v1-0`, `inventory-v1-1`); never reorder/rename persisted v1 steps;
- stable `operation_id` per unit of work (e.g. `${executionId}:<saga-version>:<index>`) passed to the Integration Action/Executor; retries reuse the same ID;
- serial, bounded fanout (cap 8 targets/iterations for the Acorn);
- step timeout 10 seconds, retries limit 2 with exponential backoff; permanent failures propagate, never reported as success;
- **no exactly-once external-side-effect guarantee:** a step may redeliver after a lost checkpoint. Integration Actions MUST enforce `operation_id` idempotency at the destination or refuse automatic retries for unsafe operations.

### Invocation and creation protocol (D1 + Workflow instance)

Starting a Saga is asynchronous. The API acknowledges accepted work and returns the Execution identity without waiting for completion.

A later API may support delayed/scheduled start, but First Acorn only requires immediate start.

Worker `POST /sagas/:sagaId/executions` MUST use this order because D1 + `Workflow.create()` are non-atomic (dual-write). D1 is the idempotency record; the Cloudflare Workflow instance is the executor.

D1 schema (excerpt):

```sql
CREATE TABLE executions (
  id TEXT PRIMARY KEY, -- UUIDv7, == Workflow instance id
  saga_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  input_fingerprint TEXT NOT NULL, -- sha256 of canonical input JSON; same key + different input => 409
  status TEXT NOT NULL DEFAULT 'Pending',
  workflow_instance_id TEXT,
  create_attempts INTEGER NOT NULL DEFAULT 1,
  input_json TEXT NOT NULL,
  result_json TEXT,
  error_json TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT
);
```

HTTP hardening (First Acorn API):

- `Content-Type` must be `application/json` (else 415); body cap 4096 bytes streamed (else 413, enforced even without `Content-Length`); invalid JSON/nonsoap input => 422 `InputError`;
- never reflect binding/provider errors, tokens, or execution payloads; ambiguous/provider failure => 503 + `Retry-After: 5` with "retry POST with the same Idempotency-Key";
- `Cache-Control: no-store` + `X-Content-Type-Options: nosniff` on lab/Execution responses;
- authorization (Organization owner check in Phase 3, `default`-Organization principal in Phase 0) runs BEFORE touching the Workflow binding; foreign owners get 404, not 403-with-existence-leak.

Protocol:

1. Read optional `Idempotency-Key` request header. If absent or not a valid UUID, generate a UUIDv7 server-side. Validate `input` is serializable JSON now (fail 400 before any write). Compute `input_fingerprint = sha256(canonical input_json)`.
2. `INSERT INTO executions (id, saga_id, org_id, idempotency_key, input_fingerprint, status='Pending', input_json, created_at)`. `id` is a new UUIDv7 generated server-side.
3. On `UNIQUE constraint failed: executions.idempotency_key`: `SELECT` the existing row by `idempotency_key`. Compare `(saga_id, org_id, input_fingerprint)`. If all match, return the original row (`200`, replay, `replayed: true`). If any differ, return `409` with code `IDEMPOTENCY_CONFLICT` plus the original `executionId`/`status_url` lookup path. Do NOT create a second Workflow instance and do NOT mutate the stored input in either case. If the existing row is `Pending`, the reconciler below will adopt-or-retry it (subject to the 10-minute expiry).
4. On insert success: call `await env.SAGA_WORKFLOW.create({ id: executionId, params: { executionId, sagaId, orgId, idempotencyKey, input } })`. `SAGA_WORKFLOW` is the Workflow binding; `id` is the `executionId`.
5. Return `202 { executionId, idempotencyKey, status: "Pending" }`. Do NOT optimistically mark `Running`. `Running` is only written by the status callback in step 6.
6. The Workflow instance reports back via an internal Worker callback invoked from inside a Workflow `step` (same-Worker `fetch` or service binding, authenticated by a non-portable `INTERNAL_CALLBACK_SECRET` binding, never an Organization Connection credential):
   - first `step.do("mark-running", ...)` -> `POST /internal/executions/:executionId/running { idempotencyKey }` -> `Pending -> Running` (+ `started_at`, `workflow_instance_id`).
   - terminal `step.do("mark-finished", ...)` -> `POST /internal/executions/:executionId/finish { status, result?, error? }` -> `Running -> Succeeded | Failed | TimedOut | Cancelled` (+ `completed_at`, bounded serializable payload).
   - Callback handler MUST verify `idempotencyKey` matches the D1 row and reject illegal transitions with 409.
7. If `create()` throws after the D1 insert: leave the row `Pending`, increment `create_attempts`, return `202` with the `Pending` Execution. Reconciliation heals it. Never delete the D1 row to "roll back".

### Result and error

Successful Execution output must be serializable and bounded. Exact persistence/size thresholds remain to be measured against Workflows and D1 Free limits.

Expected failures should eventually use a structured error shape containing a stable machine-readable code plus safe human-readable message. Internal exception details and secrets must not be exposed by default.

### History versus detail

History/list endpoints should return lightweight Execution summaries suitable for pagination. Full input/result/ExecutionHistory detail belongs on an individual Execution endpoint. This avoids turning history queries into large D1 reads and mirrors a useful upstream separation.

### Cancellation

Cancellation is a product capability, not assumed behavior. First Acorn may omit user cancellation. When implemented, Wrangnarök must define which states are cancellable and map that deliberately onto Cloudflare Workflow instance controls.

### Retry and idempotency

Do not transparently retry arbitrary Integration mutations merely because infrastructure can retry them. Retry policy must account for whether an Operation is safe/idempotent or has a caller-provided idempotency mechanism.

Cloudflare Workflow step retry behavior is an implementation tool; Wrangnarök should expose only semantics it can explain safely.

Public idempotency contract (resolved for First Acorn):

- Header `Idempotency-Key: <uuidv7>` is optional on execution creation.
- Scope is global `UNIQUE(idempotency_key)` in D1. Per-`(org_id, saga_id)` scoping is deferred until a concrete multi-tenant use case needs it.
- Server generates a UUIDv7 when the client omits the header and always returns the effective `idempotencyKey` in the Execution summary/detail.
- Retrying with the same key + same canonical input returns the original Execution (`200`, `replayed: true`); it never forks a second Execution or Workflow instance.
- Same key + different `(saga_id, org_id, input_fingerprint)` returns `409 CONFLICT` (`IDEMPOTENCY_CONFLICT`) with the original lookup path. Stored input is immutable. Concurrent conflicting submits never both launch (single winner via the UNIQUE constraint; loser gets 409).

### Reconciliation (adopt-or-fail)

A `Pending` row with no confirmed Workflow instance is expected transiently and heals via reconciliation. Trigger: Cloudflare Cron Trigger (e.g. every 5 minutes, Free-compatible) hitting `POST /internal/reconcile`, plus a lazy check on `GET /executions/:id` when `status='Pending'` and `created_at` is older than 60s.

Reconciler (Worker + D1 + Workflow binding, no new primitive):

```sql
SELECT * FROM executions WHERE status = 'Pending'
  AND created_at < datetime('now', '-60 seconds')
  ORDER BY created_at LIMIT 50;
```

For each row:

1. `status = await env.SAGA_WORKFLOW.get(executionId).status()` (`queued | running | errored | complete | terminated`).
   - found (`queued|running`): callback-equivalent `Pending -> Running`.
   - found terminal: write the corresponding terminal state (`complete -> Succeeded`, `errored -> Failed`, `terminated -> Cancelled`).
2. On not-found error and row age < 10 minutes: retry `env.SAGA_WORKFLOW.create({ id: sameExecutionId, params: sameParams })` once with the SAME `executionId` + `idempotencyKey`. Increment `create_attempts`.
3. If still not-found / `create()` fails and `create_attempts >= 3` and row age < 10 minutes: `Pending -> Failed` with code `WORKFLOW_CREATE_FAILED`. This is the only reconciler path that terminally fails a young `Pending` row.
4. Expiry (ported from lab spike): never silently resurrect a `Pending` row older than 10 minutes (`ADMISSION_RETRY_WINDOW`). Workflow history retention means a very old ambiguous launch must not be recreated much later. Return the original lookup path and require a fresh key: `Pending -> Failed` with code `ADMISSION_RETRY_WINDOW_EXPIRED`. A retained receipt (D1 row) prevents restart-after-history-loss from fabricating a terminal result — missing/expired Workflow history surfaces as unavailable/expired, never as invented success.

### Workflow status mapping (resolved for First Acorn)

| Cloudflare Workflow instance `status()` | Execution `status` |
|---|---|
| `queued`, `running` | `Running` |
| `complete` | `Succeeded` (or `Failed` if `mark-finished` carried an error payload) |
| `errored` | `Failed` |
| `terminated` | `Cancelled` |

`TimedOut` is never inferred from Workflow introspection alone. It is only written by an explicit timeout `step` / `mark-finished { status: "TimedOut" }` so Wrangnarök can explain what timed out. Operation-level history beyond Workflow introspection is deferred (see Open questions).

## Local testing strategy

Prefer real local Cloudflare emulation over fake interfaces:

1. pure domain tests for state transitions/serialization;
2. Worker-runtime tests with Cloudflare's Vitest integration;
3. local D1 for persistence tests;
4. local Workflows through Wrangler for end-to-end Execution tests;
5. mock external vendor HTTP at the Integration boundary.

This gives us meaningful local confidence without requiring a Cloudflare deployment or vendor credentials.

## Consequences

- D1 intentionally duplicates a small amount of Workflow instance metadata because it is Wrangnarök's query/auth/history surface.
- Cloudflare remains visible in implementation code; this ADR is not a portability abstraction.
- We can change Cloudflare adapter details without renaming product concepts.
- Saga registration/stable identity becomes an early design dependency.

## Open questions

- Whether `Pending` and `Scheduled` should be distinct public states once delayed starts ship.
- Input/result size limits and whether larger payloads graduate to R2.
- Operation-level persisted history versus relying partly on Workflow introspection/observability.
- Cancellation guarantees for currently running external HTTP calls.
- Progress reporting and lost-run detection: Execution record carries status/result but no `progress` field yet; reconciler covers `Pending` admission only, not mid-run liveness. Decide whether progress is a first-class Execution field or derived from Operation history.
- Job-contract hygiene (lift-and-shift lesson): shared Operation/Execution contract must not assume processes, cgroups, local filesystem persistence, or synchronous transports. Concurrency, cancellation, timeouts, and resource limits must be explicit fields, not host behavior.
- Retention/partitioning policy: D1 10 GB per-database limit plus Workflow history retention bound how long Execution/Operation history can be kept in place. Decide retention windows, partitioning, and what "expired/missing history" surfaces as (never invented success) before Phase 4 Tables/History querying.

Resolved by this ADR:

- ~~Exact status mapping from Cloudflare Workflow instances.~~ See `Workflow status mapping` above.
- ~~Public idempotency-key contract.~~ See `Retry and idempotency` + `Invocation and creation protocol` above.
