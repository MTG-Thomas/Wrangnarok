// SPDX-License-Identifier: AGPL-3.0
import type { AccessEnv } from "./access";
import type { LabAuth } from "./auth";
import type { AdminEnv } from "./orgs";
import type { ExecutionParams } from "./domain";
export interface NinjaCredentials {
  NINJA_CLIENT_ID?: string;
  NINJA_CLIENT_SECRET?: string;
}
export interface Bindings extends LabAuth, AccessEnv, AdminEnv, NinjaCredentials {
  DB: D1Database;
  ECHO_WORKFLOW: Workflow<ExecutionParams>;
  NINJA_WORKFLOW: Workflow<ExecutionParams>;
  DIGEST_WORKFLOW: Workflow<ExecutionParams>;
  SMOKE_WORKFLOW: Workflow<ExecutionParams>;
  HELLO_WORKFLOW: Workflow<ExecutionParams>;
  HELLO_PARENT_WORKFLOW: Workflow<ExecutionParams>;
  ASSETS?: Fetcher;
}
