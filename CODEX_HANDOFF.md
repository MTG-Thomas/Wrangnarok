# First Acorn implementation handoff

**Repository: MTG-Thomas/Wrangnarok. Branch: codex/first-acorn.**

This is an incomplete, local-only implementation slice for [issue #4](https://github.com/MTG-Thomas/Wrangnarok/issues/4), based on Wrangnarok commit `abbca6696ac83b490e4e53354468e1e22c01d9b7`. Read `AGENTS.md`, the existing ADRs, and the draft `docs/architecture/005-first-acorn-slice.md` first.

`gobifrost/bifrost` is the behavioral reference, not the destination or Git parent. The earlier labs placed in the Midtown Bifrost fork are superseded reference work, not this project's architecture. Do not import their Durable Objects, infrastructure interfaces, Python-compatibility requirement, or upstream scope-bypass port. No existing Wrangnarok documentation, license, or CI workflow is replaced by this branch.

## Implemented source

- Root TypeScript Worker/Wrangler project with native D1 and Workflow bindings.
- Static, explicit Saga UUID and revision; Journey metadata snapshots preserve historical identity.
- Grove/requester-qualified, idempotent submission; exact-Grove Connection lookup.
- Two observable Operations: prepare input and call the HTTP echo Realm. Native Workflow steps checkpoint these plus terminal persistence.
- D1 migration for Groves, Connections, Journeys and Operations; fixture seed kept separate.
- Authenticated local-only API for catalog, submission, individual detail and a bounded first history page.
- Local echo HTTP fixture and random-token setup script. No customer credentials.
- Authored Vitest/workerd tests using Cloudflare's plugin and real local bindings; only vendor HTTP is intercepted.

## Blocking validation before a PR

Dependency installation failed in the authoring shell with `EAI_AGAIN registry.npmjs.org`. No lockfile was fabricated, and existing `npm ci` CI was not weakened. No Cloudflare account or resources were used.

From a real Wrangnarok worktree on this branch:

```sh
npm install
npm run typecheck
npm test
npm run build
```

Resolve any dependency/API/typing failures, then commit the real `package-lock.json`. Prove a clean `npm ci` reproduces the result. The manifest pins Wrangler 4.130.0, the Cloudflare Vitest plugin 1.1.6, Vitest 4.1.0 and TypeScript 5.8.3; these have not been resolved or installed together here. Configure formatting/linting before treating ADR 004's pipeline as complete.

The native tests in `test/journeys.test.ts` must actually exercise the Workflow and D1. Confirm the vendor HTTP interceptor applies in the Workflow's runtime; if the test runner isolates that execution, use Cloudflare's documented network interception or the deterministic HTTP fixture instead. Do not replace D1 or Workflows with test doubles to obtain a green result.

Add native-boundary coverage for simultaneous identical submissions, a lost dispatch acknowledgment, recovery expiry, retained D1 replay after native history expiry, and persistence across a Wrangler restart. Existing tests cover the intended happy path, sanitized vendor failure, denied reads, and missing-Grove Connection behavior, but none has executed in workerd here.

## Interactive local path (not run in the authoring shell)

```sh
npm run setup:local
npm run db:migrate:local
npm run db:seed:local
npm run fixture
# In another terminal in the same worktree:
npm run dev
```

The fixture binds `127.0.0.1:8788`; Wrangler binds loopback. Read the random token from the ignored `.dev.vars` locally, without pasting it into chat or committing it. Send `Authorization: Bearer <local token>` on API requests. POST `/api/journeys` with `Content-Type: application/json`, a 16-128 character `Idempotency-Key`, and:

```json
{"sagaId":"720b9ebf-9b6a-4eac-bae9-6ed22c970401","input":{"message":"hello"}}
```

Follow the returned `statusUrl`; GET `/api/journeys` returns only the first 20 summaries and `hasMore`. Cursor pagination is not implemented. Changing input under an existing key returns 409. On `DISPATCH_UNCONFIRMED`, repeat the same key/input: execution may already have started.

## Validation actually performed

- Strict TypeScript 5.8.3 compilation of `src/domain.ts` and `src/auth.ts` only (no Cloudflare binding types involved).
- Independent Node assertions for parsing, scoped identity, streamed bounds and fixture authentication.
- Syntax checks for the two Node scripts; local setup overwrite protection; actual loopback echo-fixture HTTP request.
- SQLite migration/seed and constraint sanity checks only, not D1 runtime validation.
- Whitespace checks on the new files.

**Not run:** package installation/resolution, npm audit, generated binding types, full source/test typecheck, Vitest, workerd/D1/Workflow integration, Wrangler dry-run, CI, deployment, free-tier CPU/operation measurements, or the upstream Bifrost suites. Prior Bifrost-lab test counts do not apply here. The source snapshot is not a declaration that First Acorn or issue #4 is complete.

## Resource handoff stays separate

Do not provision or deploy as part of the validation pass. The committed D1 ID is a local placeholder; the lab is disabled by default, has no routes/account ID, and disables workers.dev and previews. Those settings are guardrails, not production authentication.

Remaining product gates include durable failure reconciliation when D1 itself is unavailable, archive/retention policy, real authorization, full history pagination, a vendor-independent `system.smoke` Saga, and measured Free-tier consumption. Connection secret storage remains gated by issue #3. No OAuth, arbitrary code/URLs, cross-Grove access, user cancellation, Queues, Durable Objects or R2 are included.
