// SPDX-License-Identifier: AGPL-3.0
import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import type { Bindings } from "./bindings";
import {
  echoSaga,
  ECHO_INTEGRATION_ID,
  Fault,
  EXECUTION_ID,
  ninjaSaga,
  NINJA_INTEGRATION_ID,
  parseInput,
  parseNinjaOrgsInput,
  parseSmokeInput,
  smokeSaga,
  stepRetryLimit,
} from "./domain";
import type { EchoInput, ExecutionParams, NinjaOrgsResult, SafeError, SmokeResult } from "./domain";
import { beginOperation, failExecution, finishOperation } from "./executions";
import type { ExecutionRow } from "./executions";
import { buildUsage, logUsage, persistUsage } from "./usage";
import { echo } from "./integrations/echo";
import { listOrganizations } from "./integrations/ninjaone";

/** Native Workflow implementation of the stable echo Saga. No portability runtime.
 * Retry gate (ADR 001 #15, upstream finding 14): every step.do retry limit
 * resolves through stepRetryLimit — vendor steps 0, idempotent D1 checkpoints
 * up to the operator ceiling 2; all business/expected failures throw
 * NonRetryableError. Resilience (#16): native step.sleep wait on the success
 * path, and an explicit timeout-mark-v1 checkpoint that is the sole writer of
 * TimedOut. Cancelling is honored via the prepare guard + conditional writes:
 * a cancelled row never advances to Running here. */
export class EchoWorkflow extends WorkflowEntrypoint<Bindings, ExecutionParams> {
  async run(event: WorkflowEvent<ExecutionParams>, step: WorkflowStep): Promise<EchoInput> {
    const id = event.payload.executionId;
    if (
      this.env.LAB_ENABLED !== "true" ||
      typeof id !== "string" ||
      !EXECUTION_ID.test(id) ||
      id !== event.instanceId
    ) {
      throw new NonRetryableError("Invalid local Execution invocation.");
    }
    let expectedFailure: SafeError | undefined;
    let timedOut = false;
    try {
      const prepared = await step.do(
        "prepare-input-v1",
        {
          retries: { limit: stepRetryLimit("prepare-input-v1"), delay: "1 second" },
          timeout: "10 seconds",
        },
        async () => {
          const row = await this.env.DB.prepare("SELECT * FROM executions WHERE id=?").bind(id).first<ExecutionRow>();
          if (!row || row.saga_id !== echoSaga.id || row.saga_revision !== echoSaga.revision) {
            throw new NonRetryableError("Unknown Saga revision.");
          }
          if (row.status === "Cancelling" || row.status === "Cancelled") {
            throw new NonRetryableError("Execution was cancelled.");
          }
          const input = parseInput(JSON.parse(row.input_json));
          await this.env.DB.prepare(
            "UPDATE executions SET status='Running',started_at=COALESCE(started_at,?) WHERE id=? AND status='Pending'",
          )
            .bind(new Date().toISOString(), id)
            .run();
          await beginOperation(this.env.DB, id, "prepare-input-v1", 0);
          await finishOperation(this.env.DB, id, "prepare-input-v1", input);
          return { input, orgId: row.org_id };
        },
      );
      const outcome = await step.do(
        "echo-http-v1",
        {
          retries: { limit: stepRetryLimit("echo-http-v1"), delay: "1 second" },
          timeout: "10 seconds",
        },
        async () => {
          await beginOperation(this.env.DB, id, "echo-http-v1", 1);
          const connection = await this.env.DB.prepare(
            "SELECT endpoint FROM connections WHERE org_id=? AND integration_id=?",
          )
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
            result = await echo(connection, prepared.input, `${id}-echo-http-v1`);
          } catch (error) {
            const safe =
              error instanceof Fault
                ? { code: error.code, message: error.message }
                : { code: "ECHO_INTEGRATION_FAILED", message: "The echo Integration could not complete." };
            return { ok: false as const, error: safe };
          }
          await finishOperation(this.env.DB, id, "echo-http-v1", result);
          return { ok: true as const, result };
        },
      );
      if (!outcome.ok) {
        expectedFailure = outcome.error;
        timedOut = outcome.error.code === "ECHO_VENDOR_TIMEOUT";
        if (timedOut) {
          // Explicit timeout step: the sole writer of TimedOut. The vendor
          // deadline fired inside echo-http-v1; nothing here is inferred from
          // native Workflow introspection. The shared catch below skips its
          // Failed checkpoint once this marker has persisted.
          const failure: SafeError = outcome.error;
          await step.do(
            "timeout-mark-v1",
            {
              retries: { limit: stepRetryLimit("timeout-mark-v1"), delay: "1 second" },
              timeout: "10 seconds",
            },
            () => failExecution(this.env.DB, id, failure, "TimedOut"),
          );
        }
        throw new NonRetryableError(expectedFailure.code);
      }
      const output = outcome.result;
      // Native wait primitive (verified in worker-configuration.d.ts:
      // WorkflowStep.sleep(name, duration)). Deliberately not a product
      // Operation: not every infrastructure checkpoint is ExecutionHistory.
      await step.sleep("settle-wait-v1", "1 second");
      await step.do(
        "persist-success-v1",
        {
          retries: { limit: stepRetryLimit("persist-success-v1"), delay: "1 second" },
          timeout: "10 seconds",
        },
        async () => {
          await this.env.DB.prepare(
            "UPDATE executions SET status='Succeeded',completed_at=?,result_json=? WHERE id=? AND status='Running'",
          )
            .bind(new Date().toISOString(), JSON.stringify(output), id)
            .run();
        },
      );
      return output;
    } catch {
      // Expected failures are serialized step results, not Error subclasses transported by Workflows.
      const safe: SafeError = expectedFailure ?? {
        code: "EXECUTION_FAILED",
        message: "The Execution could not complete. Inspect local runtime diagnostics.",
      };
      if (!timedOut) {
        await step.do(
          "persist-failure-v1",
          {
            retries: { limit: stepRetryLimit("persist-failure-v1"), delay: "1 second" },
            timeout: "10 seconds",
          },
          () => failExecution(this.env.DB, id, safe),
        );
      }
      throw new NonRetryableError(safe.code);
    }
  }
}

/** Native Workflow implementation of the stable ninjaone-orgs Saga. Read-only.
 * Same retry gate as EchoWorkflow: vendor step retries 0; D1 checkpoints ≤2. */
export class NinjaOrgsWorkflow extends WorkflowEntrypoint<Bindings, ExecutionParams> {
  async run(event: WorkflowEvent<ExecutionParams>, step: WorkflowStep): Promise<NinjaOrgsResult> {
    const id = event.payload.executionId;
    if (
      this.env.LAB_ENABLED !== "true" ||
      typeof id !== "string" ||
      !EXECUTION_ID.test(id) ||
      id !== event.instanceId
    ) {
      throw new NonRetryableError("Invalid local Execution invocation.");
    }
    let expectedFailure: SafeError | undefined;
    try {
      const prepared = await step.do(
        "prepare-input-v1",
        {
          retries: { limit: stepRetryLimit("prepare-input-v1"), delay: "1 second" },
          timeout: "10 seconds",
        },
        async () => {
          const row = await this.env.DB.prepare("SELECT * FROM executions WHERE id=?").bind(id).first<ExecutionRow>();
          if (!row || row.saga_id !== ninjaSaga.id || row.saga_revision !== ninjaSaga.revision) {
            throw new NonRetryableError("Unknown Saga revision.");
          }
          if (row.status === "Cancelling" || row.status === "Cancelled") {
            throw new NonRetryableError("Execution was cancelled.");
          }
          parseNinjaOrgsInput(JSON.parse(row.input_json));
          await this.env.DB.prepare(
            "UPDATE executions SET status='Running',started_at=COALESCE(started_at,?) WHERE id=? AND status='Pending'",
          )
            .bind(new Date().toISOString(), id)
            .run();
          await beginOperation(this.env.DB, id, "prepare-input-v1", 0);
          await finishOperation(this.env.DB, id, "prepare-input-v1", {});
          return { orgId: row.org_id };
        },
      );
      const outcome = await step.do(
        "ninja-list-orgs-v1",
        {
          retries: { limit: stepRetryLimit("ninja-list-orgs-v1"), delay: "1 second" },
          timeout: "10 seconds",
        },
        async () => {
          await beginOperation(this.env.DB, id, "ninja-list-orgs-v1", 1);
          const connection = await this.env.DB.prepare(
            "SELECT endpoint FROM connections WHERE org_id=? AND integration_id=?",
          )
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
          const { NINJA_CLIENT_ID: clientId, NINJA_CLIENT_SECRET: clientSecret } = this.env;
          if (!clientId || !clientSecret)
            return {
              ok: false as const,
              error: { code: "NINJA_NOT_CONFIGURED", message: "NinjaOne credentials are not configured." },
            };
          let result: NinjaOrgsResult;
          try {
            result = await listOrganizations(connection, { clientId, clientSecret });
          } catch (error) {
            const safe =
              error instanceof Fault
                ? { code: error.code, message: error.message }
                : { code: "NINJA_INTEGRATION_FAILED", message: "The NinjaOne Integration could not complete." };
            return { ok: false as const, error: safe };
          }
          await finishOperation(this.env.DB, id, "ninja-list-orgs-v1", result);
          return { ok: true as const, result };
        },
      );
      if (!outcome.ok) {
        expectedFailure = outcome.error;
        throw new NonRetryableError(expectedFailure.code);
      }
      const output = outcome.result;
      await step.do(
        "persist-success-v1",
        {
          retries: { limit: stepRetryLimit("persist-success-v1"), delay: "1 second" },
          timeout: "10 seconds",
        },
        async () => {
          await this.env.DB.prepare(
            "UPDATE executions SET status='Succeeded',completed_at=?,result_json=? WHERE id=? AND status='Running'",
          )
            .bind(new Date().toISOString(), JSON.stringify(output), id)
            .run();
        },
      );
      return output;
    } catch {
      // Expected failures are serialized step results, not Error subclasses transported by Workflows.
      const safe: SafeError = expectedFailure ?? {
        code: "EXECUTION_FAILED",
        message: "The Execution could not complete. Inspect local runtime diagnostics.",
      };
      await step.do(
        "persist-failure-v1",
        {
          retries: { limit: stepRetryLimit("persist-failure-v1"), delay: "1 second" },
          timeout: "10 seconds",
        },
        () => failExecution(this.env.DB, id, safe),
      );
      throw new NonRetryableError(safe.code);
    }
  }
}

/** Native Workflow implementation of the stable system.smoke Saga. Loopback-free:
 * D1-only Operations plus a pure transform — zero external vendor dependency,
 * no Connection lookup, no secrets, no fetch. Same retry gate as the other
 * Sagas: D1 checkpoint steps only may use retries up to the operator ceiling 2;
 * expected failures throw NonRetryableError. Cancelling/Scheduled deferred. */
export class SmokeWorkflow extends WorkflowEntrypoint<Bindings, ExecutionParams> {
  async run(event: WorkflowEvent<ExecutionParams>, step: WorkflowStep): Promise<SmokeResult> {
    const id = event.payload.executionId;
    if (
      this.env.LAB_ENABLED !== "true" ||
      typeof id !== "string" ||
      !EXECUTION_ID.test(id) ||
      id !== event.instanceId
    ) {
      throw new NonRetryableError("Invalid local Execution invocation.");
    }
    const startedMs = Date.now();
    let expectedFailure: SafeError | undefined;
    try {
      const prepared = await step.do(
        "prepare-input-v1",
        {
          retries: { limit: stepRetryLimit("prepare-input-v1"), delay: "1 second" },
          timeout: "10 seconds",
        },
        async () => {
          const row = await this.env.DB.prepare("SELECT * FROM executions WHERE id=?").bind(id).first<ExecutionRow>();
          if (!row || row.saga_id !== smokeSaga.id || row.saga_revision !== smokeSaga.revision) {
            throw new NonRetryableError("Unknown Saga revision.");
          }
          if (row.status === "Cancelling" || row.status === "Cancelled") {
            throw new NonRetryableError("Execution was cancelled.");
          }
          parseSmokeInput(JSON.parse(row.input_json));
          await this.env.DB.prepare(
            "UPDATE executions SET status='Running',started_at=COALESCE(started_at,?) WHERE id=? AND status='Pending'",
          )
            .bind(new Date().toISOString(), id)
            .run();
          await beginOperation(this.env.DB, id, "prepare-input-v1", 0);
          await finishOperation(this.env.DB, id, "prepare-input-v1", {});
          return { orgId: row.org_id };
        },
      );
      const written = await step.do(
        "smoke-write-v1",
        {
          retries: { limit: stepRetryLimit("smoke-write-v1"), delay: "1 second" },
          timeout: "10 seconds",
        },
        async () => {
          // D1 write verification: durable probe row, then read it back in-step.
          await beginOperation(this.env.DB, id, "smoke-write-v1", 1);
          await finishOperation(this.env.DB, id, "smoke-write-v1", { probe: `smoke_${id.slice(0, 8)}` });
          const probe = await this.env.DB.prepare("SELECT result_json FROM operations WHERE execution_id=? AND name=?")
            .bind(id, "smoke-write-v1")
            .first<{ result_json: string | null }>();
          if (!probe?.result_json || !probe.result_json.includes("smoke_")) {
            return {
              ok: false as const,
              error: { code: "SMOKE_WRITE_UNVERIFIED", message: "The smoke D1 write could not be verified." },
            };
          }
          return { ok: true as const, result: { probe: probe.result_json } };
        },
      );
      if (!written.ok) {
        expectedFailure = written.error;
        throw new NonRetryableError(written.error.code);
      }
      const verified = await step.do(
        "smoke-verify-v1",
        {
          retries: { limit: stepRetryLimit("smoke-verify-v1"), delay: "1 second" },
          timeout: "10 seconds",
        },
        async () => {
          // D1 read verification + pure transform: confirm the Execution row and
          // all Operation rows, then shape the bounded summary. No I/O besides D1.
          await beginOperation(this.env.DB, id, "smoke-verify-v1", 2);
          const execution = await this.env.DB.prepare("SELECT id,status,org_id FROM executions WHERE id=?")
            .bind(id)
            .first<{ id: string; status: string; org_id: string }>();
          const operations = await this.env.DB.prepare(
            "SELECT name,status FROM operations WHERE execution_id=? ORDER BY position,name",
          )
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
          await finishOperation(this.env.DB, id, "smoke-verify-v1", result);
          return { ok: true as const, result: { shaped: result, orgId: execution.org_id } };
        },
      );
      if (!verified.ok) {
        expectedFailure = verified.error;
        throw new NonRetryableError(verified.error.code);
      }
      const output: SmokeResult = verified.result.shaped;
      await step.do(
        "persist-success-v1",
        {
          retries: { limit: stepRetryLimit("persist-success-v1"), delay: "1 second" },
          timeout: "10 seconds",
        },
        async () => {
          await this.env.DB.prepare(
            "UPDATE executions SET status='Succeeded',completed_at=?,result_json=? WHERE id=? AND status='Running'",
          )
            .bind(new Date().toISOString(), JSON.stringify(output), id)
            .run();
          const count = await this.env.DB.prepare("SELECT COUNT(*) AS n FROM operations WHERE execution_id=?")
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
            durationMs: Date.now() - startedMs,
          });
          logUsage(usage);
          await persistUsage(this.env.DB, id, usage);
        },
      );
      return output;
    } catch {
      const safe: SafeError = expectedFailure ?? {
        code: "EXECUTION_FAILED",
        message: "The Execution could not complete. Inspect local runtime diagnostics.",
      };
      await step.do(
        "persist-failure-v1",
        {
          retries: { limit: stepRetryLimit("persist-failure-v1"), delay: "1 second" },
          timeout: "10 seconds",
        },
        () => failExecution(this.env.DB, id, safe),
      );
      throw new NonRetryableError(safe.code);
    }
  }
}
