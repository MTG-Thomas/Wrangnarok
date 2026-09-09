// SPDX-License-Identifier: AGPL-3.0
import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import type { Bindings } from "./bindings";
import { echoSaga, ECHO_INTEGRATION_ID, Fault, EXECUTION_ID, ninjaSaga, NINJA_INTEGRATION_ID, parseInput, parseNinjaOrgsInput } from "./domain";
import type { EchoInput, ExecutionParams, NinjaOrgsResult, SafeError } from "./domain";
import { beginOperation, failExecution, finishOperation } from "./executions";
import type { ExecutionRow } from "./executions";
import { echo } from "./integrations/echo";
import { listOrganizations } from "./integrations/ninjaone";

/** Native Workflow implementation of the stable echo Saga. No portability runtime.
 * Retry gate (ADR 001 #15, upstream finding 14): Integration/vendor steps use
 * retries 0 unless destination-side idempotency is proven; idempotent D1
 * checkpoint steps only may use retries up to the operator ceiling 2; all
 * business/expected failures throw NonRetryableError so the engine never
 * retries a non-idempotent mutation. Cancelling/Scheduled deferred (see ADR). */
export class EchoWorkflow extends WorkflowEntrypoint<Bindings, ExecutionParams> {
  async run(event: WorkflowEvent<ExecutionParams>, step: WorkflowStep): Promise<EchoInput> {
    const id = event.payload.executionId;
    if (this.env.LAB_ENABLED !== "true" || typeof id !== "string" ||
        !EXECUTION_ID.test(id) || id !== event.instanceId) {
      throw new NonRetryableError("Invalid local Execution invocation.");
    }
    let expectedFailure: SafeError | undefined;
    try {
      const prepared = await step.do("prepare-input-v1", {
        retries: { limit: 2, delay: "1 second" }, timeout: "10 seconds",
      }, async () => {
        const row = await this.env.DB.prepare("SELECT * FROM executions WHERE id=?").bind(id).first<ExecutionRow>();
        if (!row || row.saga_id !== echoSaga.id || row.saga_revision !== echoSaga.revision) {
          throw new NonRetryableError("Unknown Saga revision.");
        }
        const input = parseInput(JSON.parse(row.input_json));
        await this.env.DB.prepare("UPDATE executions SET status='Running',started_at=COALESCE(started_at,?) WHERE id=? AND status='Pending'")
          .bind(new Date().toISOString(), id).run();
        await beginOperation(this.env.DB, id, "prepare-input-v1", 0);
        await finishOperation(this.env.DB, id, "prepare-input-v1", input);
        return { input, orgId: row.org_id };
      });
      const outcome = await step.do("echo-http-v1", {
        retries: { limit: 0, delay: "1 second" }, timeout: "10 seconds",
      }, async () => {
        await beginOperation(this.env.DB, id, "echo-http-v1", 1);
        const connection = await this.env.DB.prepare("SELECT endpoint FROM connections WHERE org_id=? AND integration_id=?")
          .bind(prepared.orgId, ECHO_INTEGRATION_ID).first<{ endpoint: string }>();
        if (!connection) return { ok: false as const, error: { code: "CONNECTION_NOT_CONFIGURED", message: "No echo Connection is configured for this Organization." } };
        let result: EchoInput;
        try { result = await echo(connection, prepared.input, `${id}-echo-http-v1`); }
        catch (error) {
          const safe = error instanceof Fault ? { code: error.code, message: error.message }
            : { code: "ECHO_INTEGRATION_FAILED", message: "The echo Integration could not complete." };
          return { ok: false as const, error: safe };
        }
        await finishOperation(this.env.DB, id, "echo-http-v1", result);
        return { ok: true as const, result };
      });
      if (!outcome.ok) {
        expectedFailure = outcome.error;
        throw new NonRetryableError(expectedFailure.code);
      }
      const output = outcome.result;
      await step.do("persist-success-v1", {
        retries: { limit: 2, delay: "1 second" }, timeout: "10 seconds",
      }, async () => {
        await this.env.DB.prepare("UPDATE executions SET status='Succeeded',completed_at=?,result_json=? WHERE id=? AND status='Running'")
          .bind(new Date().toISOString(), JSON.stringify(output), id).run();
      });
      return output;
    } catch {
      // Expected failures are serialized step results, not Error subclasses transported by Workflows.
      const safe: SafeError = expectedFailure ?? {
        code: "EXECUTION_FAILED", message: "The Execution could not complete. Inspect local runtime diagnostics.",
      };
      await step.do("persist-failure-v1", {
        retries: { limit: 2, delay: "1 second" }, timeout: "10 seconds",
      }, () => failExecution(this.env.DB, id, safe));
      throw new NonRetryableError(safe.code);
    }
  }
}

/** Native Workflow implementation of the stable ninjaone-orgs Saga. Read-only.
 * Same retry gate as EchoWorkflow: vendor step retries 0; D1 checkpoints ≤2. */
export class NinjaOrgsWorkflow extends WorkflowEntrypoint<Bindings, ExecutionParams> {
  async run(event: WorkflowEvent<ExecutionParams>, step: WorkflowStep): Promise<NinjaOrgsResult> {
    const id = event.payload.executionId;
    if (this.env.LAB_ENABLED !== "true" || typeof id !== "string" ||
        !EXECUTION_ID.test(id) || id !== event.instanceId) {
      throw new NonRetryableError("Invalid local Execution invocation.");
    }
    let expectedFailure: SafeError | undefined;
    try {
      const prepared = await step.do("prepare-input-v1", {
        retries: { limit: 2, delay: "1 second" }, timeout: "10 seconds",
      }, async () => {
        const row = await this.env.DB.prepare("SELECT * FROM executions WHERE id=?").bind(id).first<ExecutionRow>();
        if (!row || row.saga_id !== ninjaSaga.id || row.saga_revision !== ninjaSaga.revision) {
          throw new NonRetryableError("Unknown Saga revision.");
        }
        parseNinjaOrgsInput(JSON.parse(row.input_json));
        await this.env.DB.prepare("UPDATE executions SET status='Running',started_at=COALESCE(started_at,?) WHERE id=? AND status='Pending'")
          .bind(new Date().toISOString(), id).run();
        await beginOperation(this.env.DB, id, "prepare-input-v1", 0);
        await finishOperation(this.env.DB, id, "prepare-input-v1", {});
        return { orgId: row.org_id };
      });
      const outcome = await step.do("ninja-list-orgs-v1", {
        retries: { limit: 0, delay: "1 second" }, timeout: "10 seconds",
      }, async () => {
        await beginOperation(this.env.DB, id, "ninja-list-orgs-v1", 1);
        const connection = await this.env.DB.prepare("SELECT endpoint FROM connections WHERE org_id=? AND integration_id=?")
          .bind(prepared.orgId, NINJA_INTEGRATION_ID).first<{ endpoint: string }>();
        if (!connection) return { ok: false as const, error: { code: "CONNECTION_NOT_CONFIGURED", message: "No NinjaOne Connection is configured for this Organization." } };
        // Local-only credential posture (documented Rung 1 deviation): the
        // client secret lives in env, never in D1. ADR 005 envelope before
        // any second Organization.
        const { NINJA_CLIENT_ID: clientId, NINJA_CLIENT_SECRET: clientSecret } = this.env;
        if (!clientId || !clientSecret) return { ok: false as const, error: { code: "NINJA_NOT_CONFIGURED", message: "NinjaOne credentials are not configured." } };
        let result: NinjaOrgsResult;
        try { result = await listOrganizations(connection, { clientId, clientSecret }); }
        catch (error) {
          const safe = error instanceof Fault ? { code: error.code, message: error.message }
            : { code: "NINJA_INTEGRATION_FAILED", message: "The NinjaOne Integration could not complete." };
          return { ok: false as const, error: safe };
        }
        await finishOperation(this.env.DB, id, "ninja-list-orgs-v1", result);
        return { ok: true as const, result };
      });
      if (!outcome.ok) {
        expectedFailure = outcome.error;
        throw new NonRetryableError(expectedFailure.code);
      }
      const output = outcome.result;
      await step.do("persist-success-v1", {
        retries: { limit: 2, delay: "1 second" }, timeout: "10 seconds",
      }, async () => {
        await this.env.DB.prepare("UPDATE executions SET status='Succeeded',completed_at=?,result_json=? WHERE id=? AND status='Running'")
          .bind(new Date().toISOString(), JSON.stringify(output), id).run();
      });
      return output;
    } catch {
      // Expected failures are serialized step results, not Error subclasses transported by Workflows.
      const safe: SafeError = expectedFailure ?? {
        code: "EXECUTION_FAILED", message: "The Execution could not complete. Inspect local runtime diagnostics.",
      };
      await step.do("persist-failure-v1", {
        retries: { limit: 2, delay: "1 second" }, timeout: "10 seconds",
      }, () => failExecution(this.env.DB, id, safe));
      throw new NonRetryableError(safe.code);
    }
  }
}
