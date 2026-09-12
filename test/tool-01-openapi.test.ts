// SPDX-License-Identifier: AGPL-3.0
// TOOL-01 (issue #170): Code Mode engine unit tests. Pure TypeScript — no
// D1, no Workflows, no vendor HTTP. Pins the ADR 022 invariants: contract
// validation, progressive search/inspect, deny-by-default policy, and origin
// allowlist enforcement independent of spec `servers` entries.
import { describe, expect, it } from "vitest";
import { Fault } from "../src/domain";

function codeOf(fn: () => void): string | null {
  try {
    fn();
  } catch (error) {
    return error instanceof Fault ? error.code : `threw:${String(error)}`;
  }
  return null;
}
import {
  authorizeOperation,
  digestTextSync,
  indexOperations,
  inspectOperation,
  pinContract,
  resolveRequestUrl,
  searchOperations,
  validateContractDocument,
} from "../src/openapi";
import type { OpenApiDocument } from "../src/openapi";

const SPEC: OpenApiDocument = {
  openapi: "3.0.3",
  info: { version: "lab-1", title: "Lab" },
  servers: [{ url: "https://evil.example.com" }],
  paths: {
    "/api/Tickets": {
      get: { operationId: "Ticket_Search", summary: "Search tickets." },
    },
    "/api/Tickets/{id}": {
      get: { operationId: "Ticket_Get", summary: "Get one ticket." },
      delete: { operationId: "Ticket_Delete", summary: "Delete one ticket." },
    },
    "/api/Tickets/{id}/Notes": {
      post: { operationId: "Ticket_AddNote", summary: "Add a note." },
    },
  },
};

const CLASSIFICATIONS = {
  Ticket_Get: "read",
  Ticket_Search: "read",
  Ticket_AddNote: "mutation",
  Ticket_Delete: "destructive",
} as const;

const POLICY = {
  enabledOperations: ["Ticket_AddNote"],
  deniedOperations: [],
  enabledRisks: ["mutation"] as const,
};

describe("contract validation (pin path)", () => {
  it("accepts a well-formed contract and reports version and count", () => {
    expect(validateContractDocument(SPEC)).toEqual({ operationCount: 4, version: "lab-1" });
  });
  it("rejects non-3.x, versionless, pathless, and id-less contracts", () => {
    expect(codeOf(() => validateContractDocument({ openapi: "2.0", info: { version: "x" }, paths: {} }))).toBe(
      "OPENAPI_CONTRACT_INVALID",
    );
    expect(codeOf(() => validateContractDocument({ openapi: "3.0.0", info: {}, paths: {} }))).toBe(
      "OPENAPI_CONTRACT_INVALID",
    );
    expect(codeOf(() => validateContractDocument({ openapi: "3.0.0", info: { version: "x" } }))).toBe(
      "OPENAPI_CONTRACT_INVALID",
    );
    expect(() =>
      validateContractDocument({
        openapi: "3.0.0",
        info: { version: "x" },
        paths: { "/a": { get: { summary: "no id" } } },
      }),
    );
    expect(
      codeOf(() =>
        validateContractDocument({
          openapi: "3.0.0",
          info: { version: "x" },
          paths: { "/a": { get: { summary: "no id" } } },
        }),
      ),
    ).toBe("OPENAPI_CONTRACT_INVALID");
    expect(() =>
      validateContractDocument({
        openapi: "3.0.0",
        info: { version: "x" },
        paths: { "/a": { get: { operationId: "Dup" } }, "/b": { get: { operationId: "Dup" } } },
      }),
    );
    expect(
      codeOf(() =>
        validateContractDocument({
          openapi: "3.0.0",
          info: { version: "x" },
          paths: { "/a": { get: { operationId: "Dup" } }, "/b": { get: { operationId: "Dup" } } },
        }),
      ),
    ).toBe("OPENAPI_CONTRACT_INVALID");
  });
  it("pins with a digest and the configured allowlist, not spec servers", async () => {
    const pinned = await pinContract({ id: "halo", name: "halo" }, JSON.stringify(SPEC), ["https://halo.example.com"]);
    expect(pinned.specVersion).toBe("lab-1");
    expect(pinned.specDigest).toBe(await digestTextSync(JSON.stringify(SPEC)));
    expect(pinned.allowedOrigins).toEqual(["https://halo.example.com"]);
    await expect(
      pinContract({ id: "h", name: "h" }, "x".repeat(3 * 1024 * 1024), ["https://h.example.com"]),
    ).rejects.toMatchObject({
      code: "OPENAPI_CONTRACT_TOO_LARGE",
    });
    await expect(pinContract({ id: "h", name: "h" }, JSON.stringify(SPEC), [])).rejects.toMatchObject({
      code: "OPENAPI_CONTRACT_INVALID",
    });
  });
});

describe("progressive search/inspect", () => {
  const operations = indexOperations(SPEC, CLASSIFICATIONS);
  it("indexes with method defaults refined by classification", () => {
    expect(operations.find((entry) => entry.operationId === "Ticket_Get")).toMatchObject({
      method: "get",
      risk: "read",
    });
    expect(operations.find((entry) => entry.operationId === "Ticket_AddNote")).toMatchObject({
      method: "post",
      risk: "mutation",
    });
  });
  it("searches case-insensitively and caps results; empty queries match nothing", () => {
    expect(
      searchOperations(operations, "ticket")
        .map((entry) => entry.operationId)
        .sort(),
    ).toEqual(["Ticket_AddNote", "Ticket_Delete", "Ticket_Get", "Ticket_Search"]);
    expect(searchOperations(operations, "TICKET_GET")).toHaveLength(1);
    expect(searchOperations(operations, "   ")).toEqual([]);
    expect(searchOperations(operations, "", 1)).toEqual([]);
  });
  it("inspects exact operations and fails unknown closed", () => {
    expect(inspectOperation(operations, "Ticket_Get").path).toBe("/api/Tickets/{id}");
    expect(codeOf(() => inspectOperation(operations, "Ticket_Invented"))).toBe("OPENAPI_UNKNOWN_OPERATION");
  });
});

describe("deny-by-default policy", () => {
  const operations = indexOperations(SPEC, CLASSIFICATIONS);
  it("lets reads through and enabled mutations through", () => {
    expect(() => authorizeOperation(inspectOperation(operations, "Ticket_Get"), POLICY)).not.toThrow();
    expect(() => authorizeOperation(inspectOperation(operations, "Ticket_AddNote"), POLICY)).not.toThrow();
  });
  it("denies destructive operations and unlisted mutations", () => {
    expect(codeOf(() => authorizeOperation(inspectOperation(operations, "Ticket_Delete"), POLICY))).toBe(
      "OPENAPI_OPERATION_DENIED",
    );
    const noMutation = { enabledOperations: [], deniedOperations: [], enabledRisks: [] as const };
    expect(codeOf(() => authorizeOperation(inspectOperation(operations, "Ticket_AddNote"), noMutation))).toBe(
      "OPENAPI_OPERATION_NOT_ENABLED",
    );
  });
  it("lets explicit denies win over enables", () => {
    const denied = { ...POLICY, deniedOperations: ["Ticket_AddNote"] };
    expect(codeOf(() => authorizeOperation(inspectOperation(operations, "Ticket_AddNote"), denied))).toBe(
      "OPENAPI_OPERATION_DENIED",
    );
  });
});

describe("origin allowlist enforcement", () => {
  it("resolves against the allowlist and rejects traversal and escape", async () => {
    const pinned = await pinContract({ id: "halo", name: "halo" }, JSON.stringify(SPEC), ["https://halo.example.com"]);
    const operations = indexOperations(SPEC, CLASSIFICATIONS);
    const get = inspectOperation(operations, "Ticket_Get");
    expect(resolveRequestUrl(pinned, get, { path: { id: "42" } })).toBe("https://halo.example.com/api/Tickets/42");
    expect(codeOf(() => resolveRequestUrl(pinned, get, { path: { id: "../admin" } }))).toBe("OPENAPI_INVALID_PARAMS");
    expect(codeOf(() => resolveRequestUrl(pinned, get, { path: { id: "" } }))).toBe("OPENAPI_INVALID_PARAMS");
    // A spec whose servers entry names an evil host never moves egress: the
    // allowlist is the only authority.
    const evil = await pinContract({ id: "halo", name: "halo" }, JSON.stringify(SPEC), ["https://evil.example.com"]);
    expect(resolveRequestUrl(evil, get, { path: { id: "7" } }).startsWith("https://evil.example.com/")).toBe(true);
    expect(resolveRequestUrl(pinned, get, { path: { id: "7" } })).not.toContain("evil");
  });
});
