// SPDX-License-Identifier: AGPL-3.0
// Integration vs Connection split (ADR 003, Proposed): the registry holds
// portable provider definitions; per-Organization state never appears here.
// Pure unit tests — no D1, no Workflow bindings.
import { describe, expect, it } from "vitest";
import {
  defineIntegration,
  echoIntegrationDef,
  INTEGRATION_DEFINITIONS,
  integrationById,
  ninjaIntegrationDef,
} from "../src/integrations";
import { ECHO_INTEGRATION_ID, NINJA_INTEGRATION_ID } from "../src/domain";

describe("Integration registry (ADR 003)", () => {
  it("registers the built-in Integrations with stable identity", () => {
    expect(INTEGRATION_DEFINITIONS).toHaveLength(2);
    expect(echoIntegrationDef).toMatchObject({ id: ECHO_INTEGRATION_ID, name: "echo", secretFields: [] });
    expect(ninjaIntegrationDef).toMatchObject({
      id: NINJA_INTEGRATION_ID,
      name: "ninjaone",
      secretFields: ["clientSecret"],
    });
    expect(integrationById(ECHO_INTEGRATION_ID)).toBe(echoIntegrationDef);
    expect(integrationById(NINJA_INTEGRATION_ID)).toBe(ninjaIntegrationDef);
    expect(integrationById("00000000-0000-4000-8000-000000000000")).toBeUndefined();
  });
  it("keeps stable IDs and names unique and frozen", () => {
    const ids = INTEGRATION_DEFINITIONS.map((entry) => entry.id);
    const names = INTEGRATION_DEFINITIONS.map((entry) => entry.name);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(names).size).toBe(names.length);
    expect(Object.isFrozen(INTEGRATION_DEFINITIONS)).toBe(true);
    for (const entry of INTEGRATION_DEFINITIONS) {
      expect(Object.isFrozen(entry)).toBe(true);
      expect(Object.isFrozen(entry.secretFields)).toBe(true);
    }
  });
  it("rejects malformed Integration definitions", () => {
    const base = {
      id: "aaaaaaaa-1111-4111-8111-111111111111",
      name: "probe",
      description: "Contract probe Integration.",
      secretFields: [] as string[],
    };
    expect(() => defineIntegration({ ...base, id: "not-a-uuid" })).toThrow(/stable UUID/);
    expect(() => defineIntegration({ ...base, name: "Not A Slug!" })).toThrow(/slug/);
    expect(() => defineIntegration({ ...base, description: "" })).toThrow(/description/);
    expect(() => defineIntegration({ ...base, secretFields: "clientSecret" as never })).toThrow(/secretFields/);
  });
});
