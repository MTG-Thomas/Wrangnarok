# ADR 004: CI/CD and deployment safety

- **Status:** Accepted for initial implementation
- **Date:** 2026-09-09

## Context

Wrangnarök is intended to be Cloudflare-native while remaining useful on Cloudflare Free. CI should therefore obtain high confidence without requiring Cloudflare credentials or consuming production resources for every pull request. Deployment should be intentionally boring: test the same runtime model locally, deploy through Wrangler, migrate D1 deliberately, and verify the deployed control plane with a safe Saga.

Cloudflare infrastructure terminology remains visible. CI should test Workers in `workerd` and use local Cloudflare bindings rather than maintaining hand-written mocks of D1 or Workflows.

## Decision

### Pull requests are credential-free CI

Normal pull-request CI MUST NOT require Cloudflare account credentials or real Realm credentials.

The baseline PR pipeline is:

1. checkout;
2. install pinned Node dependencies;
3. lint;
4. TypeScript typecheck;
5. unit tests;
6. Worker-runtime integration tests using Cloudflare's Vitest/workerd tooling and local bindings;
7. `wrangler deploy --dry-run` or the closest current non-mutating build validation.

External Realm/vendor behavior is mocked or served by deterministic fixtures. Cloudflare services are locally emulated wherever Cloudflare provides supported local bindings.

### Deployment is separate from validation

Only trusted deployment workflows receive Cloudflare credentials. Deployment credentials MUST be scoped API tokens rather than global account credentials where Cloudflare supports the required permissions.

Real Realm/Connection credentials MUST NOT be stored as GitHub deployment secrets merely to run application CI.

### Environments

Initial implementation SHOULD use two logical environments once live deployment begins:

- `dev` — first deployment target and smoke-test environment;
- `production` — promoted after dev smoke tests succeed.

The environments MUST use distinct mutable data resources where practical, especially D1 databases. A smoke test must never mutate production tenant/Connection data.

For the First Acorn, production promotion may initially be manual or omitted until a dev deployment is stable. The architecture should not require elaborate progressive delivery before there is real traffic.

### D1 migration rule

Database migration safety is stricter than Worker rollback safety.

Production migrations SHOULD be forward-compatible with both the newly deployed Worker and the immediately previous Worker version. Prefer additive changes. Destructive/semantic changes should be staged across releases rather than coupled to a single deploy.

Typical staged change:

1. add new schema;
2. deploy code capable of old + new reads and appropriate writes;
3. migrate/backfill as needed;
4. deploy code that relies only on new schema;
5. remove obsolete schema in a later release.

D1 recovery features are a safety net, not a substitute for compatible migrations.

### Platform smoke Saga

Wrangnarök SHOULD permanently include a safe internal `system.smoke` Saga once the execution model supports it.

The smoke Saga should prove the deployed control plane rather than merely return HTTP 200. It should exercise, at minimum:

1. Worker/API request handling;
2. Journey creation;
3. D1 write;
4. Cloudflare Workflow execution;
5. multiple Operations;
6. D1 read/write verification;
7. terminal Journey persistence;
8. Journey status/detail retrieval.

It MUST NOT require an external vendor, tenant credentials, or destructive production data. Test records should be identifiable and safely disposable.

### CI/CD ladder

Target shape:

```text
Pull request
  |
  +-- lint
  +-- typecheck
  +-- unit tests
  +-- workerd integration tests
  +-- Wrangler dry-run/build validation
  |
  v
merge to main
  |
  +-- repeat required validation
  +-- apply dev D1 migrations
  +-- deploy dev Worker version
  +-- run system.smoke
  |
  v
production promotion
  |
  +-- apply compatible production migrations
  +-- deploy/promote Worker version
  +-- run system.smoke
```

Progressive/canary traffic deployment is deferred until real usage makes it useful.

### Platform deployment vs content deployment

For the MVP, Sagas ship inside the Worker/application bundle. Deploying Wrangnarök deploys its built-in Sagas.

Do not create a second deployment system for Saga/Realm content yet. If Wrangnarök later supports portable bundles analogous to Bifrost Solutions, content installation/versioning becomes a separate architecture problem from deploying the Wrangnarök platform itself.

## Consequences

### Positive

- Public PRs can run meaningful CI without privileged secrets.
- Tests execute against Cloudflare's runtime model rather than Node-only approximations.
- Vendor outages do not block ordinary development.
- Deployment credentials exist only at the mutation boundary.
- D1 schema evolution is treated as an explicit compatibility concern.
- `system.smoke` becomes a reusable production canary for the actual orchestration path.

### Costs

- Local Cloudflare emulation can still differ from production; deployed smoke tests remain necessary.
- Two environments consume additional free-tier resource allowance and configuration complexity.
- Forward-compatible D1 migration discipline requires more staged changes than destructive one-shot migrations.
- CI configuration must evolve with Wrangler and Cloudflare's testing tooling.

## First Acorn implementation

Issue #4 should establish the PR validation half of this ADR first. Live deployment automation should be added only after the TypeScript scaffold can pass locally.

The first GitHub Actions workflow may tolerate missing `package.json` while the repository is specification-only, but MUST become a required real validation workflow once implementation lands.
