import { describe, expect, it } from "vitest";
import { boundedJson, echoSaga, executionId, ninjaSaga, parseInput, parseSubmission } from "../src/domain";

describe("MVP slice contracts", () => {
  it("uses a stable Saga UUID rather than a class or file name", () => {
    expect(echoSaga.id).toBe("720b9ebf-9b6a-4eac-bae9-6ed22c970401");
    expect(parseSubmission({ sagaId: echoSaga.id, input: { message: "hello" } })).toEqual({
      saga: expect.objectContaining({ id: echoSaga.id }), input: { message: "hello" },
    });
    expect(ninjaSaga.id).toBe("2c79a880-f1ac-4183-b324-d05daffc321a");
    expect(parseSubmission({ sagaId: ninjaSaga.id, input: {} })).toEqual({
      saga: expect.objectContaining({ id: ninjaSaga.id }), input: {},
    });
  });
  it("rejects submitted Organization overrides and unexpected input", () => {
    expect(() => parseSubmission({ sagaId: echoSaga.id, orgId: "other", input: { message: "x" } })).toThrow();
    expect(() => parseInput({ message: "x", token: "secret" })).toThrow();
    expect(() => parseInput({ message: "🎃".repeat(257) })).toThrow();
  });
  it("scopes idempotency to the requester and Organization", async () => {
    const principal = { orgId: "organization-a", userId: "user-a" };
    const id = await executionId(principal, "mvp-slice-key-001");
    expect(await executionId(principal, "mvp-slice-key-001")).toBe(id);
    expect(await executionId({ ...principal, userId: "other" }, "mvp-slice-key-001")).not.toBe(id);
    expect(await executionId({ ...principal, orgId: "other" }, "mvp-slice-key-001")).not.toBe(id);
  });
  it("counts actual streamed bytes before parsing JSON", async () => {
    const body = new Response(" ".repeat(4097)).body;
    await expect(boundedJson(body)).rejects.toMatchObject({ status: 413 });
  });
});
