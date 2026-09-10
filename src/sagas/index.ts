// SPDX-License-Identifier: AGPL-3.0
// Static Git-owned Saga registration (ADR 002, Accepted per issue #57).
//
// Each Saga is a static Git-owned definition: stable UUID identity, discovery
// metadata, and a run(ctx, step) body whose every durable effect flows
// through step.do(...). Per-saga definitions and thin Workflow adapters live
// in ./echo, ./ninjaorgs, ./digest, and ./smoke; shared platform glue lives
// in ./shared. This module only orders the definitions and builds the Catalog.
//
// Retry gate (ADR 001, upstream finding 14): every step.do retry limit is
// resolved by the adapter through stepRetryLimit — vendor steps 0, idempotent
// D1 checkpoints up to the operator ceiling 2; all business/expected failures
// throw NonRetryableError. Resilience (issue #16): native step.sleep wait on
// the echo success path, and an explicit timeout-mark-v1 checkpoint that is
// the sole writer of TimedOut. Cancelling is honored via the prepare guard +
// conditional writes: a cancelled row never advances to Running here.
import { buildCatalog } from "../saga";
import type { CatalogEntry, SagaDefinition } from "../saga";
import { digestSagaDef } from "./digest";
import { echoSagaDef } from "./echo";
import { ninjaOrgsSagaDef } from "./ninjaorgs";
import { smokeSagaDef } from "./smoke";

export { digestSagaDef, NinjaEchoDigestWorkflow } from "./digest";
export { echoSagaDef, EchoWorkflow } from "./echo";
export { ninjaOrgsSagaDef, NinjaOrgsWorkflow } from "./ninjaorgs";
export { smokeSagaDef, SmokeWorkflow } from "./smoke";

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
