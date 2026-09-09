// SPDX-License-Identifier: AGPL-3.0
import type { LabAuth } from "./auth";
import type { JourneyParams } from "./domain";
export interface Bindings extends LabAuth {
  DB: D1Database;
  ECHO_WORKFLOW: Workflow<JourneyParams>;
}
