// SPDX-License-Identifier: AGPL-3.0
// Shared thin-platform glue for the per-saga modules: translate one Saga
// definition onto the native Workflow contract. No Saga behavior lives here;
// each module under src/sagas owns its definition plus its Workflow adapter.
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import type { Bindings } from "../bindings";
import { EXECUTION_ID } from "../domain";
import type { ExecutionParams } from "../domain";
import { assertJsonSerializable, bindSagaStep } from "../saga";
import type { SagaDefinition, SagaEventContext } from "../saga";
import { clearExecutionSecrets, registerExecutionSecrets, scrubExecutionText, scrubExecutionValue } from "../secrets";
import { echo } from "../integrations/echo";
import { listOrganizations } from "../integrations/ninjaone";

export async function executeSaga<TOutput>(
  env: Bindings,
  event: WorkflowEvent<ExecutionParams>,
  step: WorkflowStep,
  def: SagaDefinition<TOutput>,
): Promise<TOutput> {
  const id = event.payload.executionId;
  if (env.LAB_ENABLED !== "true" || typeof id !== "string" || !EXECUTION_ID.test(id) || id !== event.instanceId) {
    throw new NonRetryableError("Invalid local Execution invocation.");
  }
  // The Workflow isolate registers deployment credentials up front so every
  // checkpoint below scrubs them by substring, including tokens the Action
  // registers mid-run. Cleared on every exit path — a reused isolate never
  // carries one Execution's secrets into the next.
  registerExecutionSecrets(id, [env.NINJA_CLIENT_ID, env.NINJA_CLIENT_SECRET]);
  try {
    const ctx: SagaEventContext = {
      executionId: id,
      integrations: { echo: { echo }, ninjaone: { listOrganizations } },
      db: env.DB,
      secrets: { clientId: env.NINJA_CLIENT_ID, clientSecret: env.NINJA_CLIENT_SECRET },
    };
    const output = await def.run(ctx, bindSagaStep(step));
    assertJsonSerializable(output, `${def.name} output`);
    // Workflow terminal value is an outward path: a secret-bearing transform
    // result would otherwise ride the native status API out unscrubbed.
    return scrubExecutionValue(output, id);
  } catch (error) {
    // A secret substring in a thrown exception string must not escape via the
    // native errored status. NonRetryableError carries only the safe code.
    if (error instanceof NonRetryableError) throw error;
    if (error instanceof Error) throw new NonRetryableError(scrubExecutionText(id, error.message));
    throw error;
  } finally {
    clearExecutionSecrets(id);
  }
}
