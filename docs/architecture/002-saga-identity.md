# ADR 002: Stable Saga identity and discovery

**Status:** Accepted (per issue #57, Phase 1a)

## Context

Upstream Bifrost separates workflow implementation source from a stable registered workflow entity. Ordinary edits keep identity; moves/renames require explicit replacement/remapping because silently minting a new UUID breaks forms, events, agents, apps, and workflow-to-workflow references.

Wrangnarök needs the same invariant without necessarily reproducing Bifrost's registration machinery.

## Decision direction

A Saga has two identities:

1. **Stable Saga ID** — durable application identity used by Triggers, history, API callers, and persisted relationships.
2. **Source locator/name** — developer-facing TypeScript identity used for discovery and diagnostics; allowed to change deliberately.

Do not use an export name, file path, Cloudflare Workflow class name, or Worker binding name as the sole durable identity.

## Accepted registration model (issue #57)

Registration is deliberately static and Git-owned:

- A Saga is a TypeScript definition built with `defineSaga` in `src/sagas.ts`: an explicit stable UUID id plus discovery metadata (name, revision, description, optional category/tags, IO schemas) plus `parse` and `run`.
- At Worker startup the definitions are collected by `buildCatalog` (`src/saga.ts`) into the Catalog. **Duplicate stable IDs or names are fatal boot errors**: the module import throws and the Worker never serves.
- `GET /api/sagas` serves that Catalog (metadata only).
- **D1 mirrors metadata only, never authoritative for behavior.** Execution rows carry `saga_id`/`saga_name`/`saga_revision` as foreign-key/diagnostic copies so history stays readable after renames and deletions; Saga behavior always comes from source.
- No database migration owns Saga identity. (Phase 1a performs no schema changes.)

## Authoring contract

`run` mirrors the native Workflow `run(event, step)` shape as `run(ctx, step)`: `ctx` is the validated event context (deterministic execution identity plus Integration/D1/secret handles), `step` is the durable Operation API (`do` for retry-unit work, `sleep` for explicit waits). The thin adapter in `src/sagas.ts` maps native `WorkflowEntrypoint` classes onto definitions; no Saga behavior lives in the adapters.

Determinism constraints (enforced by `test/saga-contract.test.ts`, not by types alone): NO direct `Date.now()`, `Math.random()`, `crypto.randomUUID()`, `fetch()`, or Integration calls in the `run` body. All nondeterminism and I/O MUST go inside an Operation, which maps to a Cloudflare Workflow `step.do()` retry unit. `ctx.integrations.*`, `ctx.db`, and `ctx.secrets` may ONLY be touched inside a `step.do()` callback. `input`/`output` MUST be serializable JSON (no functions, `Map`/`Set`, class instances, streams) per `assertJsonSerializable`.

```ts
import { defineSaga } from "../src/saga";
import type { SagaEventContext, SagaStep } from "../src/saga";
import type { EchoInput, EchoOutput } from "../src/domain";

export const echoSaga = defineSaga<EchoOutput>({
  id: "00000000-0000-0000-0000-000000000001",
  name: "echo",
  revision: "echo-v1",
  description: "First durable Wrangnarök Saga",
  tags: ["utility"],
  parse: parseInput,
  run: async (ctx: SagaEventContext, step: SagaStep): Promise<EchoOutput> => {
    // ILLEGAL here: Date.now(), Math.random(), fetch(), ctx.integrations.*,
    // ctx.db, ctx.secrets. All of that lives inside step.do(...) below.
    const echoed = await step.do("echo", async () => ctx.integrations.echo.echo(connFrom(ctx), input, opId));
    return { message: echoed.message };
  },
});
```

Exact handle shapes may evolve, but the constraints are not: non-`step` I/O in `run` fails review and the contract test, and `ctx.integrations.*` outside `step.do()` fails review and the contract test.

Retry limits and step timeouts are resolved by the adapter through the `stepRetryLimit` table (`src/domain.ts`), never by Saga source. The `sleep` duration on an explicit wait step remains orchestration written in source; everything retry/timeout/schedule-shaped is persisted policy, never a definition property (upstream finding 3).

## Rename/move behavior

- moving a source file does not change Saga ID;
- changing display/name metadata does not change Saga ID;
- changing the explicit Saga ID is treated as creating a different Saga;
- deleting a Saga must not erase historical Executions;
- deployment tooling detects accidental identity churn (see below).

## Churn/rename detection

`sagas.manifest.json` (repo root) is the checked-in snapshot of `{id, name, revision}` for every registered Saga. `test/saga-contract.test.ts` compares the startup Catalog against that manifest and fails loudly on any unexpected add/remove/rename/revision drift, with instructions for the deliberate path.

Deliberate identity change procedure (creating a different Saga on purpose):

1. Justify it in the PR (dependents — Triggers, history, API callers — must be remapped, never silently forked).
2. Update `sagas.manifest.json` in the same PR.
3. Keep the old Execution history readable: the D1 mirror rows are never rewritten.

Any manifest/catalog diff without that procedure fails CI. This is intentionally boring: an explicit UUID plus a diffable manifest, no hashing of paths/names/code (all accidentally mutable), no generated registry until ergonomics demand one.

## Why explicit IDs initially

Alternatives such as hashing source paths, names, or implementation code make identity accidentally mutable. A generated manifest could eventually improve ergonomics, but an explicit UUID is boring, obvious, Git-diffable, and sufficient for the experiment.

## Discovery metadata

Catalog metadata stays small:

- stable ID;
- unique name/slug;
- revision marker for diagnostics;
- description;
- optional category/tags;
- input/output schema metadata hand-derived from the TypeScript types (no codegen dependency while the surface is three Sagas; revisit if schema drift ever bites);
- source/build version metadata for diagnostics.

Operational policy such as retries, schedules, access rules, and endpoints must not become source-definition properties merely because upstream has equivalents. `buildCatalog` rejects those keys at startup; they are decided as persisted policy in their own contracts.

## Consequences

- Sagas remain code-first while gaining stable references.
- Cloudflare Workflow binding/class names are implementation details.
- History remains readable after Saga deletion/rename.
- Startup validation (duplicate IDs/names fatal) plus the manifest churn gate make accidental identity changes loud instead of silent.
- We accept a little explicit UUID ceremony in exchange for avoiding identity migration problems early.
