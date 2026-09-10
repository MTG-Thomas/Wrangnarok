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
