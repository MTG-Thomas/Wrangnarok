import { describe, expect, it } from "vitest";
import { boundedJson, canTransition, echoSaga, executionId, ninjaSaga, parseInput, parseSubmission, STEP_RETRY_CEILING, stepRetryLimit } from "../src/domain";

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
  it("gates step retries to engine-loss-only with an operator ceiling", () => {
    // Vendor/Integration steps never auto-retry; only idempotent D1
    // checkpoints may retry, up to the ceiling. Unknown names fail closed.
    expect(stepRetryLimit("echo-http-v1")).toBe(0);
    expect(stepRetryLimit("ninja-list-orgs-v1")).toBe(0);
    expect(stepRetryLimit("prepare-input-v1")).toBe(STEP_RETRY_CEILING);
    expect(stepRetryLimit("persist-success-v1")).toBe(STEP_RETRY_CEILING);
    expect(stepRetryLimit("persist-failure-v1")).toBe(STEP_RETRY_CEILING);
    expect(stepRetryLimit("timeout-mark-v1")).toBe(STEP_RETRY_CEILING);
    expect(STEP_RETRY_CEILING).toBe(2);
    expect(stepRetryLimit("some-future-mutation-v1")).toBe(0);
  });
  it("restricts execution transitions to the canonical table", () => {
    expect(canTransition("Pending", "Running")).toBe(true);
    expect(canTransition("Pending", "Cancelling")).toBe(true);
    expect(canTransition("Running", "Succeeded")).toBe(true);
    expect(canTransition("Running", "Failed")).toBe(true);
    expect(canTransition("Running", "TimedOut")).toBe(true);
    expect(canTransition("Running", "Cancelling")).toBe(true);
    expect(canTransition("Cancelling", "Cancelled")).toBe(true);
    for (const terminal of ["Succeeded", "Failed", "TimedOut", "Cancelled"] as const) {
      for (const next of ["Pending", "Running", "Succeeded", "Failed", "TimedOut", "Cancelling", "Cancelled"] as const) {
        expect(canTransition(terminal, next)).toBe(false);
      }
    }
    expect(canTransition("Pending", "Succeeded")).toBe(false);
    expect(canTransition("Pending", "Cancelled")).toBe(false);
    expect(canTransition("Cancelling", "Succeeded")).toBe(false);
  });
});
