# ADR 007: First Acorn submission and local execution slice

**Status: Draft implementation proposal; runtime validation pending.**

Related: [#4](https://github.com/MTG-Thomas/Wrangnarok/issues/4), [#2](https://github.com/MTG-Thomas/Wrangnarok/issues/2). Implements a narrow slice of ADRs 001-004; does not replace them or claim their open questions are settled.

## Primitive and identity boundaries

Use only Worker + Workflows + D1. The echo Saga has an explicit UUID in the static code catalog, separate from its source name/revision and Workflow binding. D1 snapshots that metadata in each Execution, so deleting or renaming source does not erase history. A separate catalog table is unnecessary for the single built-in Saga.

D1 is the product's query, authorization and history surface. Workflows owns durable execution/checkpoints. The Execution ID is also the native instance ID. No process worker, portability runtime or competing scheduler is introduced.

The fixture principal is configured locally, not supplied by the request. Every public Execution read checks both Organization and requester. The Workflow loads the Organization from its immutable Execution row, not from a client-provided execution context. Integration Connection resolution is exact-Organization with no upstream global/provider bypass semantics.

## Admission and ambiguous failure

An Idempotency-Key is required: 16-128 ASCII alphanumeric or `._:-` characters. A SHA-256 hash of a versioned tuple of Organization, requester and key identifies one Execution. The same key with changed Saga/input conflicts. JSON input is normalized before comparison; HTTP bodies are capped at 4096 bytes and message text at 1024 UTF-8 bytes.

D1 reserves the immutable Execution before native dispatch. `Workflow.createBatch` with one instance provides retained-ID deduplication. A durable D1 dispatch marker is written only after that call acknowledges. A 202 is returned only after the marker is persisted. D1 and Workflows are not one atomic transaction.

If creation or marker persistence fails, return 503 `DISPATCH_UNCONFIRMED`: work may have started, and the caller must retry the original key. No autonomous outbox is implemented. Reads never launch work. An unconfirmed reservation may be retried only within 15 minutes and under the same Saga revision; later ambiguity returns 409 without relaunching. Confirmed rows never dispatch again, even if native history has expired.

This safety argument assumes Cloudflare retains instance IDs throughout that recovery window and nobody manually deletes/resets native instances or D1 records. Operators must not shorten retention below the window. Concurrent submission and ambiguous-failure behavior remain native-runtime test gates, not guarantees proved by unit doubles.

## Operations and history

Two product Operations are persisted in order: `prepare-input-v1` and `echo-http-v1`. Separate native steps persist terminal success/failure; not every infrastructure checkpoint is a product Operation. Prepared input and the echo outcome are checkpointed JSON. Expected Integration failures return a structured outcome so their code survives replay without relying on Error subclass transport.

The fixture Action has zero configured retries. It is a read-like echo POST, not a mutating vendor integration. A stable operation ID is sent, but the implementation does not claim exactly-once external effects. Future retryable mutations require destination-side idempotency and a deliberate policy.

List results omit input/results and return a maximum of 20 records plus `hasMore`. Cursor pagination is deferred. Detail exposes stored status, two Operation records and a separate `runtimeStatus` when native inspection succeeds. Native exception bodies are never public.

Normal success and expected failure are persisted in D1. If D1 or the runtime fails during the terminal checkpoint, D1 can remain Pending/Running. A missing native status is not interpreted as success, failure or expiry. A reconciliation design is required before claiming operationally complete lifecycle handling. TimedOut/Cancelled are reserved domain states, not implemented controls.

Admission/history records currently have no automatic cleanup. Growth is bounded by usage, not by a retention policy; this is another pre-production gate. Workflow source/step changes need versioning discipline before in-flight deployment upgrades are supported.

## Local fixture and safety

The only supported Connection endpoint is `http://127.0.0.1:8788/echo`. Redirects are rejected, HTTP has a five-second timeout and response byte bounds, and vendor failures become safe codes/messages. The demo cannot reach an arbitrary URL supplied by a caller. No real secret format or OAuth design is implied.

The default configuration disables the lab. An explicit local setup script creates an ignored random token and fixture identity without overwriting an existing file. This is not a production identity provider. A future deployed smoke Saga should avoid the loopback/vendor dependency, as required by ADR 004.

## Verification and Free-tier gate

Use the repo's Cloudflare Vitest plugin with real local bindings, not fake D1/Workflow implementations. Only the vendor HTTP boundary is mocked. See `CODEX_HANDOFF.md` for exact unrun validation and commands.

The design avoids paid-only primitives, but Free-tier viability has not been demonstrated. Measure Worker CPU, Workflow steps/requests, D1 rows read/written and retained storage for a full Execution and retries on the actual runtime. Do not equate the absence of an account ID with proven cost or performance behavior.

Platform API references used while authoring (checked 2026-09-09):

- https://developers.cloudflare.com/workflows/build/workers-api/
- https://developers.cloudflare.com/workers/testing/vitest-integration/
- https://developers.cloudflare.com/workers/testing/vitest-integration/test-apis/
