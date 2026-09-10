// SPDX-License-Identifier: AGPL-3.0
// Integration vs Connection split (ADR 003, Proposed).
//
// An Integration is code: a reusable, typed provider definition with a stable
// machine identifier, discovery metadata, and identification of which config
// fields are secret. It never owns tenant credentials or mutable tokens.
// A Connection is environment state: a configured instance of an Integration
// for one Organization. The D1 row carries the stable IDs plus the
// non-secret endpoint; decrypted material only ever exists transiently
// inside server-side execution (see ADR 005, Proposed).
import { ECHO_INTEGRATION_ID, NINJA_INTEGRATION_ID, UUID } from "../domain";

/** Reusable provider definition. Source declaration only — never endpoints,
 * credentials, or per-Organization state. */
export interface IntegrationDefinition {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  /** Config field names treated as secret (never persisted in plaintext,
   * never logged, never returned through discovery or history APIs). */
  readonly secretFields: readonly string[];
}

const INTEGRATION_NAME = /^[a-z0-9][a-z0-9.-]*$/i;

export function defineIntegration(def: IntegrationDefinition): IntegrationDefinition {
  if (!UUID.test(def.id)) {
    throw new Error(
      `Invalid Integration definition "${def.name}": id "${def.id}" must be a stable UUID; changing it mints a different Integration.`,
    );
  }
  if (!INTEGRATION_NAME.test(def.name)) {
    throw new Error(`Invalid Integration definition id ${def.id}: name "${def.name}" must be a simple slug.`);
  }
  if (typeof def.description !== "string" || def.description.length === 0 || def.description.length > 280) {
    throw new Error(`Invalid Integration definition "${def.name}": description must be 1-280 chars.`);
  }
  if (
    !Array.isArray(def.secretFields) ||
    def.secretFields.some((field) => typeof field !== "string" || field.length === 0)
  ) {
    throw new Error(
      `Invalid Integration definition "${def.name}": secretFields must be an explicit list (empty when none).`,
    );
  }
  return Object.freeze({ ...def, secretFields: Object.freeze([...def.secretFields]) });
}

export const echoIntegrationDef = defineIntegration({
  id: ECHO_INTEGRATION_ID,
  name: "echo",
  description: "Local fixture HTTP echo: POST echoes data without external mutation.",
  secretFields: [],
});

export const ninjaIntegrationDef = defineIntegration({
  id: NINJA_INTEGRATION_ID,
  name: "ninjaone",
  description: "Read-only NinjaOne organization census over client-credentials OAuth.",
  secretFields: ["clientSecret"],
});

/** All Integration definitions, in canonical order. Add new Integrations here. */
export const INTEGRATION_DEFINITIONS: readonly IntegrationDefinition[] = Object.freeze([
  echoIntegrationDef,
  ninjaIntegrationDef,
]);

export function integrationById(id: string): IntegrationDefinition | undefined {
  return INTEGRATION_DEFINITIONS.find((entry) => entry.id === id);
}

/** Configured instance of an Integration for one Organization. Environment
 * state, never portable source: IDs plus non-secret config only. Secret
 * material is referenced transiently at execution time, never stored here. */
export interface Connection {
  readonly id: string;
  readonly integrationId: string;
  readonly orgId: string;
  readonly endpoint: string;
}
