# Testing strategy

Wrangnarök should get as close to the real Cloudflare runtime as practical before deploying anything.

## Principle

**Mock vendors; emulate Cloudflare.**

Cloudflare's local tooling runs Workers under `workerd` and provides local implementations of bindings. Prefer those implementations to hand-written fake D1/Workflow/Queue/etc. interfaces whenever they are available.

## Layers

### 1. Pure TypeScript tests

Use ordinary Vitest tests for domain behavior that does not need bindings:

- Saga catalog/identity rules;
- Execution state transitions;
- structured errors;
- Integration request/response shaping;
- validation and serialization.

### 2. Worker-runtime tests

Use Cloudflare's current `@cloudflare/vitest-plugin` integration so tests execute in the Workers runtime and can access configured bindings.

Primary targets:

- HTTP routing;
- D1 repositories/migrations;
- authorization/context propagation;
- Integration code that depends on Worker runtime APIs.

### 3. Local D1

Run migrations against a local D1 binding. Test persistence and queries against Cloudflare's local D1 implementation rather than SQLite mocks.

Tests must be repeatable from an empty database and must not depend on production data.

Executable SQL fed to workerd D1 `exec()` in tests must contain no header comments — it rejects leading comment-only input (the wrangler CLI tolerates them, tests do not). Document SQL files in code or markdown, not in the SQL.

### 4. Local Workflows

Use `wrangler dev` local Workflows support for end-to-end Execution tests. Exercise creation, execution and inspection of Workflow instances locally.

MVP slice should prove:

```text
HTTP request
  -> Worker
  -> D1 Execution row
  -> local Workflow instance
  -> multiple durable Operations
  -> mocked external HTTP Integration
  -> terminal Execution state/result in D1
```

- Dual-write fault test (Worker-runtime + local D1 + local Workflow binding): crash between D1 `Pending` insert and `Workflow.create()`, then assert retry with the same `Idempotency-Key` returns the same `executionId` and reconciliation adopt-or-fails the `Pending` row (no second Workflow instance). Cover `create()`-throws and callback-never-arrives cases.
- Idempotency conflict test: same key + different canonical input => 409 `IDEMPOTENCY_CONFLICT` + original lookup path; stored input immutable; concurrent conflicting submits never both launch.
- Expiry test: `Pending` older than 10 minutes with absent Workflow history is never silently recreated; surfaces expired lookup path and requires a fresh key.
- Determinism authoring test: static assertion + runtime test that Saga `run` bodies contain no direct `Date.now()` / `Math.random()` / `fetch()` / top-level `ctx.integrations.*` outside `ctx.step.do()` / `defineOperation`, and that Saga `input`/`output` fixtures round-trip through `JSON.stringify` (serializable contract).
- Runtime smoke skeleton (local Wrangler, no login/deploy, temp config + temp state, teardown after): duplicate-submit, conflict-submit (409), cross-principal isolation (404 without touching Workflow binding), completion with bounded Operations, restart persistence (same key => same Execution + same result). Model on the lab spike's `scripts/runtime-smoke.mjs` crash/ambiguity windows: simultaneous same-key submits, lost create response, receipt-write failure, quota failure, retained receipt after history loss.

### 5. External Integration mocks

External APIs are the mock boundary. Tests should provide deterministic HTTP behavior for:

- success;
- validation/client error;
- transient server/rate-limit error;
- timeout/network failure where practical;
- malformed/unexpected response.

Do not make the core test suite require NinjaOne, Microsoft, Halo, or other vendor credentials.

### 6. Live Cloudflare smoke tests

After local MVP slice is green, deploy a minimal development instance to Cloudflare and repeat a small smoke path within Free-tier allowances. Live tests should remain sparse and must not become necessary for ordinary development.

## Tooling baseline

Use current versions at implementation time, but the intended stack is:

- TypeScript
- Wrangler
- Vitest 4+
- `@cloudflare/vitest-plugin`
- workerd/Miniflare through Cloudflare tooling

Avoid older `@cloudflare/vitest-pool-workers` examples when newer plugin documentation applies.

## CI direction

Initial CI should require:

- formatting/linting once configured;
- TypeScript typecheck;
- unit/Worker-runtime tests;
- local D1 migration/application tests;
- a local end-to-end Execution test once Workflows harnessing is stable in CI.

Production deployment should not be required to merge ordinary PRs.
