# Testing strategy

Wrangnarök should get as close to the real Cloudflare runtime as practical before deploying anything.

## Principle

**Mock vendors; emulate Cloudflare.**

Cloudflare's local tooling runs Workers under `workerd` and provides local implementations of bindings. Prefer those implementations to hand-written fake D1/Workflow/Queue/etc. interfaces whenever they are available.

## Layers

### 1. Pure TypeScript tests

Use ordinary Vitest tests for domain behavior that does not need bindings:

- Saga catalog/identity rules;
- Journey state transitions;
- structured errors;
- Realm request/response shaping;
- validation and serialization.

### 2. Worker-runtime tests

Use Cloudflare's current `@cloudflare/vitest-plugin` integration so tests execute in the Workers runtime and can access configured bindings.

Primary targets:

- HTTP routing;
- D1 repositories/migrations;
- authorization/context propagation;
- Realm code that depends on Worker runtime APIs.

### 3. Local D1

Run migrations against a local D1 binding. Test persistence and queries against Cloudflare's local D1 implementation rather than SQLite mocks.

Tests must be repeatable from an empty database and must not depend on production data.

### 4. Local Workflows

Use `wrangler dev` local Workflows support for end-to-end Journey tests. Exercise creation, execution and inspection of Workflow instances locally.

First Acorn should prove:

```text
HTTP request
  -> Worker
  -> D1 Journey row
  -> local Workflow instance
  -> multiple durable Operations
  -> mocked external HTTP Realm
  -> terminal Journey state/result in D1
```

### 5. External Realm mocks

External APIs are the mock boundary. Tests should provide deterministic HTTP behavior for:

- success;
- validation/client error;
- transient server/rate-limit error;
- timeout/network failure where practical;
- malformed/unexpected response.

Do not make the core test suite require NinjaOne, Microsoft, Halo, or other vendor credentials.

### 6. Live Cloudflare smoke tests

After local First Acorn is green, deploy a minimal development instance to Cloudflare and repeat a small smoke path within Free-tier allowances. Live tests should remain sparse and must not become necessary for ordinary development.

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
- a local end-to-end Journey test once Workflows harnessing is stable in CI.

Production deployment should not be required to merge ordinary PRs.
