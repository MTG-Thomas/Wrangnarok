// SPDX-License-Identifier: AGPL-3.0
// Integration vs Connection split (ADR 003): the registry holds portable
// provider definitions (schema, defaults, required-secret names, health);
// per-Organization state never appears here.
// Pure unit tests — no D1, no Workflow bindings.
import { describe, expect, it } from "vitest";
import {
  defineIntegration,
  echoIntegrationDef,
  INTEGRATION_DEFINITIONS,
  integrationById,
  integrationByName,
  ninjaIntegrationDef,
  validateConnectionConfig,
} from "../src/integrations";
import { ECHO_INTEGRATION_ID, NINJA_INTEGRATION_ID } from "../src/domain";

const BASE = {
  id: "aaaaaaaa-1111-4111-8111-111111111111",
  name: "probe",
  description: "Contract probe Integration.",
  secretFields: [] as string[],
  configSchema: [{ name: "endpoint", type: "string" as const, required: true, description: "Probe endpoint." }],
  requiredSecrets: [] as string[],
  secretEnvVars: {},
  health: { testHint: "Probe the endpoint.", remediation: "Check the endpoint and retry." },
};

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
    expect(integrationByName("echo")).toBe(echoIntegrationDef);
    expect(integrationByName("NINJAONE")).toBe(ninjaIntegrationDef);
    expect(integrationByName("ghost")).toBeUndefined();
  });
  it("declares schema, defaults, required secrets, and health per Integration", () => {
    expect(echoIntegrationDef.configSchema).toMatchObject([{ name: "endpoint", required: true }]);
    expect(echoIntegrationDef.requiredSecrets).toEqual([]);
    expect(ninjaIntegrationDef.requiredSecrets).toEqual(["clientSecret"]);
    expect(ninjaIntegrationDef.secretEnvVars).toMatchObject({ clientSecret: "NINJA_CLIENT_SECRET" });
    for (const entry of INTEGRATION_DEFINITIONS) {
      expect(entry.health.testHint.length).toBeGreaterThan(0);
      expect(entry.health.remediation.length).toBeGreaterThan(0);
      expect(entry.configSchema.some((field) => field.name === "endpoint")).toBe(true);
    }
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
      expect(Object.isFrozen(entry.configSchema)).toBe(true);
      expect(Object.isFrozen(entry.requiredSecrets)).toBe(true);
    }
  });
  it("rejects malformed Integration definitions", () => {
    expect(() => defineIntegration({ ...BASE, id: "not-a-uuid" })).toThrow(/stable UUID/);
    expect(() => defineIntegration({ ...BASE, name: "Not A Slug!" })).toThrow(/slug/);
    expect(() => defineIntegration({ ...BASE, description: "" })).toThrow(/description/);
    expect(() => defineIntegration({ ...BASE, secretFields: "clientSecret" as never })).toThrow(/secretFields/);
    expect(() => defineIntegration({ ...BASE, configSchema: [] })).toThrow(/configSchema/);
    expect(() =>
      defineIntegration({
        ...BASE,
        configSchema: [{ name: "clientSecret", type: "string" as const, required: false, description: "Leak." }],
      }),
    ).toThrow(/secret/);
    expect(() =>
      defineIntegration({
        ...BASE,
        secretFields: ["clientSecret"],
        requiredSecrets: ["clientSecret"],
        secretEnvVars: {},
      }),
    ).toThrow(/env var/);
    expect(() => defineIntegration({ ...BASE, health: { testHint: "", remediation: "" } })).toThrow(/health/);
  });
});

describe("Connection config validation (CON-01)", () => {
  it("applies the echo default endpoint when omitted", () => {
    expect(validateConnectionConfig(echoIntegrationDef, {})).toMatchObject({
      endpoint: "http://127.0.0.1:8788/echo",
    });
  });
  it("rejects unknown fields, missing required, and credential-shaped keys", () => {
    expect(() => validateConnectionConfig(echoIntegrationDef, { endpoint: "https://x.test", token: "abc" })).toThrow(
      expect.objectContaining({ code: "CONNECTION_SCHEMA_INVALID" }),
    );
    try {
      validateConnectionConfig(ninjaIntegrationDef, {});
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({ code: "CONNECTION_SCHEMA_INVALID" });
    }
    try {
      validateConnectionConfig(echoIntegrationDef, { endpoint: "https://x.test", apiKey: "hunter2" });
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({ code: "CONNECTION_SCHEMA_INVALID" });
    }
  });
});
