# ADR 002: Stable Saga identity and discovery

**Status:** Draft

## Context

Upstream Bifrost separates workflow implementation source from a stable registered workflow entity. Ordinary edits keep identity; moves/renames require explicit replacement/remapping because silently minting a new UUID breaks forms, events, agents, apps, and workflow-to-workflow references.

Wrangnarök needs the same invariant without necessarily reproducing Bifrost's registration machinery.

## Decision direction

A Saga has two identities:

1. **Stable Saga ID** — durable application identity used by Triggers, history, API callers, and persisted relationships.
2. **Source locator/name** — developer-facing TypeScript identity used for discovery and diagnostics; allowed to change deliberately.

Do not use an export name, file path, Cloudflare Workflow class name, or Worker binding name as the sole durable identity.

## First Acorn proposal

For the first implementation, keep registration deliberately static and Git-owned. A Saga definition declares an explicit stable ID and metadata in TypeScript. `run` executes as a Cloudflare Workflow `run(event, step)` body and is subject to Workflows determinism constraints: NO direct `Date.now()`, `Math.random()`, `crypto.randomUUID()`, `fetch()`, or Integration calls in the `run` body. All nondeterminism and I/O MUST go inside an Operation, which maps to a Cloudflare Workflow `step.do()` retry unit. `ctx.integrations.*` may ONLY be called inside a `step.do()` callback. `input`/`output` MUST be serializable JSON (no functions, `Map`/`Set`, class instances, streams).

```ts
import { defineSaga, defineOperation } from "../../src/saga";
import type { SagaContext } from "../../src/saga";
import type { HttpIntegration } from "../../src/integrations/http";

type EchoInput = { message: string };
type EchoOutput = { message: string; fetchedAt: string };

// Integration fetch isolated in an Operation = one Workflow step.do() unit.
const fetchStatus = defineOperation({
  name: "fetch-status",
  run: async (
    ctx: SagaContext,
    integrations: { http: HttpIntegration },
  ): Promise<{ fetchedAt: string }> => {
    const res = await integrations.http.getJson<{ now: string }>("/status");
    return { fetchedAt: res.now };
  },
});

export const echoSaga = defineSaga<EchoInput, EchoOutput>({
  id: "00000000-0000-0000-0000-000000000001",
  name: "echo",
  description: "First durable Wrangnarök Saga",
  run: async (ctx, input: EchoInput): Promise<EchoOutput> => {
    // ILLEGAL here: Date.now(), Math.random(), fetch(), ctx.integrations.http.*.
    const echoed = await ctx.step.do("echo", async () => input.message);
    const status = await ctx.step.do("fetch-status", () =>
      fetchStatus.run(ctx, ctx.integrations),
    );
    return { message: echoed, fetchedAt: status.fetchedAt };
  },
});
```

Exact API is illustrative, not final, but the constraints are not: non-`step` I/O in `run` fails review, and `ctx.integrations.*` outside `step.do()` fails review.

At Worker startup/build time, Sagas are collected into a catalog (Catalog). Duplicate stable IDs or names are fatal configuration errors.

D1 may persist catalog metadata needed for Execution foreign keys/discovery, but source remains authoritative for behavior.

## Rename/move behavior

- moving a source file does not change Saga ID;
- changing display/name metadata does not change Saga ID;
- changing the explicit Saga ID is treated as creating a different Saga;
- deleting a Saga must not erase historical Executions;
- future deployment tooling should detect accidental identity churn.

## Why explicit IDs initially

Alternatives such as hashing source paths, names, or implementation code make identity accidentally mutable. A generated manifest could eventually improve ergonomics, but an explicit UUID is boring, obvious, Git-diffable, and sufficient for the experiment.

## Discovery metadata

Initial catalog metadata should remain small:

- stable ID;
- unique name/slug;
- description;
- optional category/tags later;
- input/output schema metadata if derivable safely;
- source/build version metadata for diagnostics.

Operational policy such as retries, schedules, access rules, and endpoints should not automatically become source-definition properties merely because upstream has equivalents. Decide those contracts separately.

## Consequences

- Sagas remain code-first while gaining stable references.
- Cloudflare Workflow binding/class names are implementation details.
- History remains readable after Saga deletion/rename.
- We accept a little explicit UUID ceremony in exchange for avoiding identity migration problems early.
