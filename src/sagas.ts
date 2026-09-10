// SPDX-License-Identifier: AGPL-3.0
// Stable Saga definitions (ADR 002, Accepted per issue #57).
//
// Each Saga is a static Git-owned definition built with defineSaga: stable
// UUID identity, discovery metadata, and a run(ctx, step) body whose every
// durable effect flows through step.do(...). The WorkflowEntrypoint subclasses
// at the bottom are thin adapters only — they validate the invocation,
// bind ctx/step, and delegate. No Saga behavior lives in the adapters.
//
// Retry gate (ADR 001, upstream finding 14): every step.do retry limit is
// resolved by the adapter through stepRetryLimit — vendor steps 0, idempotent
// D1 checkpoints up to the operator ceiling 2; all business/expected failures
// throw NonRetryableError. Resilience (issue #16): native step.sleep wait on
// the echo success path, and an explicit timeout-mark-v1 checkpoint that is
// the sole writer of TimedOut. Cancelling is honored via the prepare guard +
// conditional writes: a cancelled row never advances to Running here.
import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import type { Bindings } from "./bindings";
import {
  digestSaga,
  echoSaga,
  ECHO_INTEGRATION_ID,
  EXECUTION_ID,
  Fault,
  ninjaSaga,
  NINJA_INTEGRATION_ID,
  parseDigestInput,
  parseInput,
  parseNinjaOrgsInput,
  parseSmokeInput,
  shapeDigest,
  smokeSaga,
} from "./domain";
import type {
  DigestInput,
  DigestResult,
  EchoInput,
  ExecutionParams,
  NinjaOrgsResult,
  SafeError,
  SmokeResult,
} from "./domain";
import { assertJsonSerializable, bindSagaStep, buildCatalog, defineSaga } from "./saga";
import type { CatalogEntry, SagaDefinition, SagaEventContext } from "./saga";
import { beginOperation, failExecution, finishOperation } from "./executions";
import type { ExecutionRow } from "./executions";
import { buildUsage, logUsage, persistUsage } from "./usage";
import { echo } from "./integrations/echo";
import { listOrganizations } from "./integrations/ninjaone";

const echoInputSchema = Object.freeze({
  type: "object" as const,
  properties: Object.freeze({ message: Object.freeze({ type: "string" }) }),
  required: Object.freeze(["message"]),
  additionalProperties: false,
});

/** Stable echo Saga: prepare input and call the local HTTP echo Integration. */
export const echoSagaDef = defineSaga<EchoInput>({
  id: echoSaga.id,
  name: echoSaga.name,
  revision: echoSaga.revision,
  description: echoSaga.description,
  tags: ["utility", "fixture"],
  inputSchema: echoInputSchema,
  outputSchema: echoInputSchema,
  parse: parseInput,
  run: async (ctx, step): Promise<EchoInput> => {
    const id = ctx.executionId;
    if (typeof id !== "string" || !EXECUTION_ID.test(id)) {
      throw new NonRetryableError("Invalid local Execution invocation.");
    }
    let expectedFailure: SafeError | undefined;
    let timedOut = false;
    try {
      const prepared = await step.do("prepare-input-v1", async () => {
        const row = await ctx.db.prepare("SELECT * FROM executions WHERE id=?").bind(id).first<ExecutionRow>();
        if (!row || row.saga_id !== echoSaga.id || row.saga_revision !== echoSaga.revision) {
          throw new NonRetryableError("Unknown Saga revision.");
        }
        if (row.status === "Cancelling" || row.status === "Cancelled") {
          throw new NonRetryableError("Execution was cancelled.");
        }
        const input = parseInput(JSON.parse(row.input_json));
        await ctx.db
          .prepare(
            "UPDATE executions SET status='Running',started_at=COALESCE(started_at,?) WHERE id=? AND status='Pending'",
          )
          .bind(new Date().toISOString(), id)
          .run();
        await beginOperation(ctx.db, id, "prepare-input-v1", 0);
        await finishOperation(ctx.db, id, "prepare-input-v1", input);
        return { input, orgId: row.org_id };
      });
      const outcome = await step.do("echo-http-v1", async () => {
        await beginOperation(ctx.db, id, "echo-http-v1", 1);
        const connection = await ctx.db
          .prepare("SELECT endpoint FROM connections WHERE org_id=? AND integration_id=?")
          .bind(prepared.orgId, ECHO_INTEGRATION_ID)
          .first<{ endpoint: string }>();
        if (!connection)
          return {
            ok: false as const,
            error: {
              code: "CONNECTION_NOT_CONFIGURED",
              message: "No echo Connection is configured for this Organization.",
            },
          };
        let result: EchoInput;
        try {
          result = await ctx.integrations.echo.echo(connection, prepared.input, `${id}-echo-http-v1`);
        } catch (error) {
          const safe =
            error instanceof Fault
              ? { code: error.code, message: error.message }
              : { code: "ECHO_INTEGRATION_FAILED", message: "The echo Integration could not complete." };
          return { ok: false as const, error: safe };
        }
        await finishOperation(ctx.db, id, "echo-http-v1", result);
        return { ok: true as const, result };
      });
      if (!outcome.ok) {
        expectedFailure = outcome.error;
        timedOut = outcome.error.code === "ECHO_VENDOR_TIMEOUT";
        if (timedOut) {
          // Explicit timeout step: the sole writer of TimedOut. The vendor
          // deadline fired inside echo-http-v1; nothing here is inferred from
          // native Workflow introspection. The shared catch below skips its
          // Failed checkpoint once this marker has persisted.
          const failure: SafeError = outcome.error;
          await step.do("timeout-mark-v1", () => failExecution(ctx.db, id, failure, "TimedOut"));
        }
        throw new NonRetryableError(expectedFailure.code);
      }
      const output = outcome.result;
      // Native wait primitive. Deliberately not a product Operation: not every
      // infrastructure checkpoint is ExecutionHistory.
      await step.sleep("settle-wait-v1", "1 second");
      await step.do("persist-success-v1", async () => {
        await ctx.db
          .prepare(
            "UPDATE executions SET status='Succeeded',completed_at=?,result_json=? WHERE id=? AND status='Running'",
          )
          .bind(new Date().toISOString(), JSON.stringify(output), id)
          .run();
      });
      return output;
    } catch {
      // Expected failures are serialized step results, not Error subclasses transported by Workflows.
      const safe: SafeError = expectedFailure ?? {
        code: "EXECUTION_FAILED",
        message: "The Execution could not complete. Inspect local runtime diagnostics.",
      };
      if (!timedOut) {
        await step.do("persist-failure-v1", () => failExecution(ctx.db, id, safe));
      }
      throw new NonRetryableError(safe.code);
    }
  },
});

/** Stable ninjaone-orgs Saga: read-only census of NinjaOne organizations. */
export const ninjaOrgsSagaDef = defineSaga<NinjaOrgsResult>({
  id: ninjaSaga.id,
  name: ninjaSaga.name,
  revision: ninjaSaga.revision,
  description: ninjaSaga.description,
  tags: ["ninjaone", "read-only"],
  inputSchema: Object.freeze({
    type: "object" as const,
    properties: Object.freeze({}),
    required: Object.freeze([]),
    additionalProperties: false,
  }),
  outputSchema: Object.freeze({
    type: "object" as const,
    properties: Object.freeze({
      organizationCount: Object.freeze({ type: "number" }),
      organizations: Object.freeze({ type: "array" }),
    }),
    required: Object.freeze(["organizationCount", "organizations"]),
    additionalProperties: false,
  }),
  parse: parseNinjaOrgsInput,
  run: async (ctx, step): Promise<NinjaOrgsResult> => {
    const id = ctx.executionId;
    if (typeof id !== "string" || !EXECUTION_ID.test(id)) {
      throw new NonRetryableError("Invalid local Execution invocation.");
    }
    let expectedFailure: SafeError | undefined;
    try {
      const prepared = await step.do("prepare-input-v1", async () => {
        const row = await ctx.db.prepare("SELECT * FROM executions WHERE id=?").bind(id).first<ExecutionRow>();
        if (!row || row.saga_id !== ninjaSaga.id || row.saga_revision !== ninjaSaga.revision) {
          throw new NonRetryableError("Unknown Saga revision.");
        }
        if (row.status === "Cancelling" || row.status === "Cancelled") {
          throw new NonRetryableError("Execution was cancelled.");
        }
        parseNinjaOrgsInput(JSON.parse(row.input_json));
        await ctx.db
          .prepare(
            "UPDATE executions SET status='Running',started_at=COALESCE(started_at,?) WHERE id=? AND status='Pending'",
          )
          .bind(new Date().toISOString(), id)
          .run();
        await beginOperation(ctx.db, id, "prepare-input-v1", 0);
        await finishOperation(ctx.db, id, "prepare-input-v1", {});
        return { orgId: row.org_id };
      });
      const outcome = await step.do("ninja-list-orgs-v1", async () => {
        await beginOperation(ctx.db, id, "ninja-list-orgs-v1", 1);
        const connection = await ctx.db
          .prepare("SELECT endpoint FROM connections WHERE org_id=? AND integration_id=?")
          .bind(prepared.orgId, NINJA_INTEGRATION_ID)
          .first<{ endpoint: string }>();
        if (!connection)
          return {
            ok: false as const,
            error: {
              code: "CONNECTION_NOT_CONFIGURED",
              message: "No NinjaOne Connection is configured for this Organization.",
            },
          };
        // Local-only credential posture (documented Rung 1 deviation): the
        // client secret lives in env, never in D1. ADR 005 envelope before
        // any second Organization.
        const { clientId, clientSecret } = ctx.secrets;
        if (!clientId || !clientSecret)
          return {
            ok: false as const,
            error: { code: "NINJA_NOT_CONFIGURED", message: "NinjaOne credentials are not configured." },
          };
        let result: NinjaOrgsResult;
        try {
          result = await ctx.integrations.ninjaone.listOrganizations(connection, { clientId, clientSecret });
        } catch (error) {
          const safe =
            error instanceof Fault
              ? { code: error.code, message: error.message }
              : { code: "NINJA_INTEGRATION_FAILED", message: "The NinjaOne Integration could not complete." };
          return { ok: false as const, error: safe };
        }
        await finishOperation(ctx.db, id, "ninja-list-orgs-v1", result);
        return { ok: true as const, result };
      });
      if (!outcome.ok) {
        expectedFailure = outcome.error;
        throw new NonRetryableError(expectedFailure.code);
      }
      const output = outcome.result;
      await step.do("persist-success-v1", async () => {
        await ctx.db
          .prepare(
            "UPDATE executions SET status='Succeeded',completed_at=?,result_json=? WHERE id=? AND status='Running'",
          )
          .bind(new Date().toISOString(), JSON.stringify(output), id)
          .run();
      });
      return output;
    } catch {
      // Expected failures are serialized step results, not Error subclasses transported by Workflows.
      const safe: SafeError = expectedFailure ?? {
        code: "EXECUTION_FAILED",
        message: "The Execution could not complete. Inspect local runtime diagnostics.",
      };
      await step.do("persist-failure-v1", () => failExecution(ctx.db, id, safe));
      throw new NonRetryableError(safe.code);
    }
  },
});

/** Stable ninjaone-echo-digest Saga (Phase 2): read-only NinjaOne census
 * shaped into a bounded digest and echoed through the echo Integration. Both
 * vendor steps resolve retries 0 via stepRetryLimit; the digest is a pure
 * transform of the census and never carries secrets or vendor bodies. */
export const digestSagaDef = defineSaga<DigestResult>({
  id: digestSaga.id,
  name: digestSaga.name,
  revision: digestSaga.revision,
  description: digestSaga.description,
  tags: ["ninjaone", "echo", "read-only"],
  inputSchema: Object.freeze({
    type: "object" as const,
    properties: Object.freeze({}),
    required: Object.freeze([]),
    additionalProperties: false,
  }),
  outputSchema: Object.freeze({
    type: "object" as const,
    properties: Object.freeze({
      organizationCount: Object.freeze({ type: "number" }),
      echoed: Object.freeze({ type: "object" }),
    }),
    required: Object.freeze(["organizationCount", "echoed"]),
    additionalProperties: false,
  }),
  parse: parseDigestInput,
  run: async (ctx, step): Promise<DigestResult> => {
    const id = ctx.executionId;
    if (typeof id !== "string" || !EXECUTION_ID.test(id)) {
      throw new NonRetryableError("Invalid local Execution invocation.");
    }
    let expectedFailure: SafeError | undefined;
    let timedOut = false;
    try {
      const prepared = await step.do("prepare-input-v1", async () => {
        const row = await ctx.db.prepare("SELECT * FROM executions WHERE id=?").bind(id).first<ExecutionRow>();
        if (!row || row.saga_id !== digestSaga.id || row.saga_revision !== digestSaga.revision) {
          throw new NonRetryableError("Unknown Saga revision.");
        }
        if (row.status === "Cancelling" || row.status === "Cancelled") {
          throw new NonRetryableError("Execution was cancelled.");
        }
        const input: DigestInput = parseDigestInput(JSON.parse(row.input_json));
        await ctx.db
          .prepare(
            "UPDATE executions SET status='Running',started_at=COALESCE(started_at,?) WHERE id=? AND status='Pending'",
          )
          .bind(new Date().toISOString(), id)
          .run();
        await beginOperation(ctx.db, id, "prepare-input-v1", 0);
        await finishOperation(ctx.db, id, "prepare-input-v1", input);
        return { orgId: row.org_id };
      });
      const census = await step.do("ninja-list-orgs-v1", async () => {
        await beginOperation(ctx.db, id, "ninja-list-orgs-v1", 1);
        const connection = await ctx.db
          .prepare("SELECT endpoint FROM connections WHERE org_id=? AND integration_id=?")
          .bind(prepared.orgId, NINJA_INTEGRATION_ID)
          .first<{ endpoint: string }>();
        if (!connection)
          return {
            ok: false as const,
            error: {
              code: "CONNECTION_NOT_CONFIGURED",
              message: "No NinjaOne Connection is configured for this Organization.",
            },
          };
        const { clientId, clientSecret } = ctx.secrets;
        if (!clientId || !clientSecret)
          return {
            ok: false as const,
            error: { code: "NINJA_NOT_CONFIGURED", message: "NinjaOne credentials are not configured." },
          };
        let result: NinjaOrgsResult;
        try {
          result = await ctx.integrations.ninjaone.listOrganizations(connection, { clientId, clientSecret });
        } catch (error) {
          const safe =
            error instanceof Fault
              ? { code: error.code, message: error.message }
              : { code: "NINJA_INTEGRATION_FAILED", message: "The NinjaOne Integration could not complete." };
          return { ok: false as const, error: safe };
        }
        await finishOperation(ctx.db, id, "ninja-list-orgs-v1", result);
        return { ok: true as const, result };
      });
      if (!census.ok) {
        expectedFailure = census.error;
        throw new NonRetryableError(census.error.code);
      }
      const echoed = await step.do("echo-digest-v1", async () => {
        await beginOperation(ctx.db, id, "echo-digest-v1", 2);
        const connection = await ctx.db
          .prepare("SELECT endpoint FROM connections WHERE org_id=? AND integration_id=?")
          .bind(prepared.orgId, ECHO_INTEGRATION_ID)
          .first<{ endpoint: string }>();
        if (!connection)
          return {
            ok: false as const,
            error: {
              code: "CONNECTION_NOT_CONFIGURED",
              message: "No echo Connection is configured for this Organization.",
            },
          };
        let result: EchoInput;
        try {
          result = await ctx.integrations.echo.echo(connection, shapeDigest(census.result), `${id}-echo-digest-v1`);
        } catch (error) {
          const safe =
            error instanceof Fault
              ? { code: error.code, message: error.message }
              : { code: "ECHO_INTEGRATION_FAILED", message: "The echo Integration could not complete." };
          return { ok: false as const, error: safe };
        }
        await finishOperation(ctx.db, id, "echo-digest-v1", result);
        return { ok: true as const, result };
      });
      if (!echoed.ok) {
        expectedFailure = echoed.error;
        timedOut = echoed.error.code === "ECHO_VENDOR_TIMEOUT";
        if (timedOut) {
          const failure: SafeError = echoed.error;
          await step.do("timeout-mark-v1", () => failExecution(ctx.db, id, failure, "TimedOut"));
        }
        throw new NonRetryableError(echoed.error.code);
      }
      const output: DigestResult = { organizationCount: census.result.organizationCount, echoed: echoed.result };
      // Native wait primitive, same posture as echo: infrastructure checkpoint,
      // not a product Operation.
      await step.sleep("settle-wait-v1", "1 second");
      await step.do("persist-success-v1", async () => {
        await ctx.db
          .prepare(
            "UPDATE executions SET status='Succeeded',completed_at=?,result_json=? WHERE id=? AND status='Running'",
          )
          .bind(new Date().toISOString(), JSON.stringify(output), id)
          .run();
      });
      return output;
    } catch {
      const safe: SafeError = expectedFailure ?? {
        code: "EXECUTION_FAILED",
        message: "The Execution could not complete. Inspect local runtime diagnostics.",
      };
      if (!timedOut) {
        await step.do("persist-failure-v1", () => failExecution(ctx.db, id, safe));
      }
      throw new NonRetryableError(safe.code);
    }
  },
});

/** Stable system.smoke Saga: loopback-free platform smoke. D1-only Operations
 * plus a pure transform — zero external vendor dependency, no Connection
 * lookup, no secrets, no fetch. D1 checkpoint steps only may use retries up to
 * the operator ceiling 2; expected failures throw NonRetryableError. */
export const smokeSagaDef = defineSaga<SmokeResult>({
  id: smokeSaga.id,
  name: smokeSaga.name,
  revision: smokeSaga.revision,
  description: smokeSaga.description,
  tags: ["platform", "smoke"],
  inputSchema: Object.freeze({
    type: "object" as const,
    properties: Object.freeze({}),
    required: Object.freeze([]),
    additionalProperties: false,
  }),
  outputSchema: Object.freeze({
    type: "object" as const,
    properties: Object.freeze({
      d1WriteOk: Object.freeze({ type: "boolean" }),
      d1ReadOk: Object.freeze({ type: "boolean" }),
      operationCount: Object.freeze({ type: "number" }),
      operations: Object.freeze({ type: "array" }),
    }),
    required: Object.freeze(["d1WriteOk", "d1ReadOk", "operationCount", "operations"]),
    additionalProperties: false,
  }),
  parse: parseSmokeInput,
  run: async (ctx, step): Promise<SmokeResult> => {
    const id = ctx.executionId;
    if (typeof id !== "string" || !EXECUTION_ID.test(id)) {
      throw new NonRetryableError("Invalid local Execution invocation.");
    }
    let expectedFailure: SafeError | undefined;
    try {
      const prepared = await step.do("prepare-input-v1", async () => {
        const row = await ctx.db.prepare("SELECT * FROM executions WHERE id=?").bind(id).first<ExecutionRow>();
        if (!row || row.saga_id !== smokeSaga.id || row.saga_revision !== smokeSaga.revision) {
          throw new NonRetryableError("Unknown Saga revision.");
        }
        if (row.status === "Cancelling" || row.status === "Cancelled") {
          throw new NonRetryableError("Execution was cancelled.");
        }
        parseSmokeInput(JSON.parse(row.input_json));
        await ctx.db
          .prepare(
            "UPDATE executions SET status='Running',started_at=COALESCE(started_at,?) WHERE id=? AND status='Pending'",
          )
          .bind(new Date().toISOString(), id)
          .run();
        await beginOperation(ctx.db, id, "prepare-input-v1", 0);
        await finishOperation(ctx.db, id, "prepare-input-v1", {});
        // startedMs is captured inside the Operation (replay-memoized), never
        // at the top of run: Date.now() outside step.do fails the contract.
        return { orgId: row.org_id, startedMs: Date.now() };
      });
      const written = await step.do("smoke-write-v1", async () => {
        // D1 write verification: durable probe row, then read it back in-step.
        await beginOperation(ctx.db, id, "smoke-write-v1", 1);
        await finishOperation(ctx.db, id, "smoke-write-v1", { probe: `smoke_${id.slice(0, 8)}` });
        const probe = await ctx.db
          .prepare("SELECT result_json FROM operations WHERE execution_id=? AND name=?")
          .bind(id, "smoke-write-v1")
          .first<{ result_json: string | null }>();
        if (!probe?.result_json || !probe.result_json.includes("smoke_")) {
          return {
            ok: false as const,
            error: { code: "SMOKE_WRITE_UNVERIFIED", message: "The smoke D1 write could not be verified." },
          };
        }
        return { ok: true as const, result: { probe: probe.result_json } };
      });
      if (!written.ok) {
        expectedFailure = written.error;
        throw new NonRetryableError(written.error.code);
      }
      const verified = await step.do("smoke-verify-v1", async () => {
        // D1 read verification + pure transform: confirm the Execution row and
        // all Operation rows, then shape the bounded summary. No I/O besides D1.
        await beginOperation(ctx.db, id, "smoke-verify-v1", 2);
        const execution = await ctx.db
          .prepare("SELECT id,status,org_id FROM executions WHERE id=?")
          .bind(id)
          .first<{ id: string; status: string; org_id: string }>();
        const operations = await ctx.db
          .prepare("SELECT name,status FROM operations WHERE execution_id=? ORDER BY position,name")
          .bind(id)
          .all<{ name: string; status: string }>();
        if (!execution || execution.id !== id || execution.status !== "Running") {
          return {
            ok: false as const,
            error: { code: "SMOKE_READ_UNVERIFIED", message: "The smoke D1 read could not be verified." },
          };
        }
        const names = operations.results.map((row) => row.name);
        for (const required of ["prepare-input-v1", "smoke-write-v1", "smoke-verify-v1"]) {
          if (!names.includes(required)) {
            return {
              ok: false as const,
              error: { code: "SMOKE_READ_UNVERIFIED", message: "The smoke Operation history is incomplete." },
            };
          }
        }
        const result: SmokeResult = {
          d1WriteOk: true,
          d1ReadOk: true,
          operationCount: names.length,
          operations: names,
        };
        await finishOperation(ctx.db, id, "smoke-verify-v1", result);
        return { ok: true as const, result: { shaped: result, orgId: execution.org_id } };
      });
      if (!verified.ok) {
        expectedFailure = verified.error;
        throw new NonRetryableError(verified.error.code);
      }
      const output: SmokeResult = verified.result.shaped;
      await step.do("persist-success-v1", async () => {
        await ctx.db
          .prepare(
            "UPDATE executions SET status='Succeeded',completed_at=?,result_json=? WHERE id=? AND status='Running'",
          )
          .bind(new Date().toISOString(), JSON.stringify(output), id)
          .run();
        const count = await ctx.db
          .prepare("SELECT COUNT(*) AS n FROM operations WHERE execution_id=?")
          .bind(id)
          .first<{ n: number }>();
        const usage = buildUsage({
          saga: smokeSaga.name,
          sagaRevision: smokeSaga.revision,
          executionId: id,
          orgId: verified.result.orgId || prepared.orgId,
          status: "Succeeded",
          operationRows: count?.n ?? output.operationCount,
          reads: 4,
          writes: 8,
          stepsExecuted: 4,
          durationMs: Date.now() - prepared.startedMs,
        });
        logUsage(usage);
        await persistUsage(ctx.db, id, usage);
      });
      return output;
    } catch {
      const safe: SafeError = expectedFailure ?? {
        code: "EXECUTION_FAILED",
        message: "The Execution could not complete. Inspect local runtime diagnostics.",
      };
      await step.do("persist-failure-v1", () => failExecution(ctx.db, id, safe));
      throw new NonRetryableError(safe.code);
    }
  },
});

/** All Saga definitions, in canonical order. Add new Sagas here; the catalog
 * below validates them at Worker startup. */
export const SAGA_DEFINITIONS: readonly SagaDefinition<unknown>[] = [
  echoSagaDef,
  ninjaOrgsSagaDef,
  digestSagaDef,
  smokeSagaDef,
];

/** Static Git-owned Catalog (ADR 002): duplicate stable IDs or names throw at
 * module load, which fails Worker boot. D1 mirrors this metadata for foreign
 * keys/discovery but never drives behavior. */
export const SAGA_CATALOG: readonly CatalogEntry[] = buildCatalog(SAGA_DEFINITIONS);

// --- Thin Workflow adapters --------------------------------------------------
// Each native Workflow class validates the invocation, binds the Saga ctx/step
// contract, and delegates. No Saga behavior lives here.

async function executeSaga<TOutput>(
  env: Bindings,
  event: WorkflowEvent<ExecutionParams>,
  step: WorkflowStep,
  def: SagaDefinition<TOutput>,
): Promise<TOutput> {
  const id = event.payload.executionId;
  if (env.LAB_ENABLED !== "true" || typeof id !== "string" || !EXECUTION_ID.test(id) || id !== event.instanceId) {
    throw new NonRetryableError("Invalid local Execution invocation.");
  }
  const ctx: SagaEventContext = {
    executionId: id,
    integrations: { echo: { echo }, ninjaone: { listOrganizations } },
    db: env.DB,
    secrets: { clientId: env.NINJA_CLIENT_ID, clientSecret: env.NINJA_CLIENT_SECRET },
  };
  const output = await def.run(ctx, bindSagaStep(step));
  assertJsonSerializable(output, `${def.name} output`);
  return output;
}

export class EchoWorkflow extends WorkflowEntrypoint<Bindings, ExecutionParams> {
  async run(event: WorkflowEvent<ExecutionParams>, step: WorkflowStep): Promise<EchoInput> {
    return executeSaga(this.env, event, step, echoSagaDef);
  }
}

export class NinjaOrgsWorkflow extends WorkflowEntrypoint<Bindings, ExecutionParams> {
  async run(event: WorkflowEvent<ExecutionParams>, step: WorkflowStep): Promise<NinjaOrgsResult> {
    return executeSaga(this.env, event, step, ninjaOrgsSagaDef);
  }
}

export class NinjaEchoDigestWorkflow extends WorkflowEntrypoint<Bindings, ExecutionParams> {
  async run(event: WorkflowEvent<ExecutionParams>, step: WorkflowStep): Promise<DigestResult> {
    return executeSaga(this.env, event, step, digestSagaDef);
  }
}

export class SmokeWorkflow extends WorkflowEntrypoint<Bindings, ExecutionParams> {
  async run(event: WorkflowEvent<ExecutionParams>, step: WorkflowStep): Promise<SmokeResult> {
    return executeSaga(this.env, event, step, smokeSagaDef);
  }
}
