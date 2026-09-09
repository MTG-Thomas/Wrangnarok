// SPDX-License-Identifier: AGPL-3.0
import { describe, expect, it } from "vitest";
import {
  MailboxFault,
  MailboxMessage,
  buildMessage,
  findReply,
  formatLine,
  formatPushBlock,
  markStatus,
  parseLine,
  peekPushable,
  unread,
  unreadSummary,
  validAlias,
} from "../.opencode/plugins/mailbox-store";

function faultCode(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof MailboxFault) return error.code;
    throw error;
  }
  throw new Error("expected MailboxFault");
}

function note(overrides: Partial<MailboxMessage> = {}): MailboxMessage {
  return {
    id: "m1",
    from: "ses-a",
    to: "ses-b",
    ts: "2026-09-09T00:00:00.000Z",
    kind: "note",
    priority: "standard",
    body: "hello",
    status: "queued",
    ...overrides,
  };
}

describe("mailbox send validation", () => {
  it("defaults kind note and standard priority", () => {
    const m = buildMessage("ses-a", { to: "ses-b", body: "hi" }, "id-1", "ts");
    expect(m).toMatchObject({ kind: "note", priority: "standard", status: "queued", from: "ses-a" });
  });
  it("steer defaults to high priority but rejects standard steer", () => {
    expect(buildMessage("s", { to: "t", kind: "steer", body: "x" }, "i", "ts").priority).toBe("high");
    expect(() => buildMessage("s", { to: "t", kind: "steer", priority: "standard", body: "x" }, "i", "ts")).toThrowError(
      MailboxFault,
    );
  });
  it("reply requires replyTo, rejects bad kind/priority and bounds", () => {
    expect(faultCode(() => buildMessage("s", { to: "t", kind: "reply", body: "x" }, "i", "ts"))).toBe("REPLY_NO_TARGET");
    expect(faultCode(() => buildMessage("s", { to: "t", kind: "yell", body: "x" }, "i", "ts"))).toBe("BAD_KIND");
    expect(faultCode(() => buildMessage("s", { to: "t", body: "" }, "i", "ts"))).toBe("BODY_EMPTY");
    expect(faultCode(() => buildMessage("s", { to: "t", body: "x".repeat(4097) }, "i", "ts"))).toBe("BODY_TOO_LARGE");
    expect(faultCode(() => buildMessage("s", { to: "  ", body: "x" }, "i", "ts"))).toBe("BAD_ADDRESS");
  });
});

describe("mailbox JSONL round-trip", () => {
  it("formats and parses, skipping malformed lines", () => {
    const m = note({ subject: "s", replyTo: "r", fromAlias: "a" });
    expect(parseLine(formatLine(m))).toEqual(m);
    expect(parseLine("{nope")).toBeNull();
    expect(parseLine(JSON.stringify({ ...m, kind: "yell" }))).toBeNull();
    expect(parseLine(JSON.stringify({ ...m, status: "lost" }))).toBeNull();
  });
});

describe("mailbox status machine", () => {
  const inbox = [note({ id: "a" }), note({ id: "b", priority: "high" }), note({ id: "c", status: "read" })];
  it("never regresses and gates delivered from queued only", () => {
    expect(markStatus(inbox, ["a"], "delivered").find((m) => m.id === "a")?.status).toBe("delivered");
    expect(markStatus(inbox, ["c"], "delivered").find((m) => m.id === "c")?.status).toBe("read");
    expect(markStatus(inbox, ["c"], "queued").find((m) => m.id === "c")?.status).toBe("read");
    expect(markStatus(inbox, ["a"], "acked").find((m) => m.id === "a")?.status).toBe("acked");
  });
  it("unread covers queued+delivered, push peeks undelivered high only", () => {
    expect(unread(inbox).map((m) => m.id)).toEqual(["a", "b"]);
    expect(peekPushable(inbox).map((m) => m.id)).toEqual(["b"]);
    const after = markStatus(inbox, ["b"], "delivered");
    expect(peekPushable(after)).toEqual([]);
    expect(unread(after).map((m) => m.id)).toEqual(["a", "b"]);
  });
  it("finds replies by request id", () => {
    const box = [note({ id: "q", kind: "request" }), note({ id: "r", kind: "reply", replyTo: "q" })];
    expect(findReply(box, "q")?.id).toBe("r");
    expect(findReply(box, "nope")).toBeNull();
  });
});

describe("mailbox presentation", () => {
  it("validates aliases and formats push/summary", () => {
    expect(validAlias("lane-one_2")).toBe(true);
    expect(validAlias("Has space")).toBe(false);
    expect(formatPushBlock([note({ id: "b", priority: "high" })])).toMatch(/MAILBOX_HIGH_PRIORITY/);
    expect(unreadSummary([note(), note({ id: "b", priority: "high" })])).toMatch(/2 unread \(1 high-priority\)/);
    expect(unreadSummary([])).toBe("Mailbox: empty.");
  });
});
