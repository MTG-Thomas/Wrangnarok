import { describe, expect, it } from "vitest";
import { boundedJson, echoSaga, journeyId, parseInput, parseSubmission } from "../src/domain";

describe("First Acorn contracts", () => {
  it("uses a stable Saga UUID rather than a class or file name", () => {
    expect(echoSaga.id).toBe("720b9ebf-9b6a-4eac-bae9-6ed22c970401");
    expect(parseSubmission({ sagaId: echoSaga.id, input: { message: "hello" } })).toEqual({ message: "hello" });
  });
  it("rejects submitted Grove overrides and unexpected input", () => {
    expect(() => parseSubmission({ sagaId: echoSaga.id, groveId: "other", input: { message: "x" } })).toThrow();
    expect(() => parseInput({ message: "x", token: "secret" })).toThrow();
    expect(() => parseInput({ message: "🌰".repeat(257) })).toThrow();
  });
  it("scopes idempotency to the requester and Grove", async () => {
    const principal = { groveId: "grove-a", userId: "user-a" };
    const id = await journeyId(principal, "first-acorn-key-001");
    expect(await journeyId(principal, "first-acorn-key-001")).toBe(id);
    expect(await journeyId({ ...principal, userId: "other" }, "first-acorn-key-001")).not.toBe(id);
    expect(await journeyId({ ...principal, groveId: "other" }, "first-acorn-key-001")).not.toBe(id);
  });
  it("counts actual streamed bytes before parsing JSON", async () => {
    const body = new Response(" ".repeat(4097)).body;
    await expect(boundedJson(body)).rejects.toMatchObject({ status: 413 });
  });
});
