// SPDX-License-Identifier: AGPL-3.0
export const echoSaga = Object.freeze({
  id: "720b9ebf-9b6a-4eac-bae9-6ed22c970401",
  name: "echo",
  revision: "echo-v1",
  description: "First Acorn: prepare input and call the local HTTP echo Realm",
});
export const ECHO_REALM_ID = "720b9ebf-9b6a-4eac-bae9-6ed22c970402";
export const BODY_LIMIT = 4096;
export const RECOVERY_WINDOW_MS = 15 * 60 * 1000;
export const JOURNEY_ID = /^[a-f0-9]{64}$/;
export const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export type JourneyStatus = "Pending" | "Running" | "Succeeded" | "Failed" | "TimedOut" | "Cancelled";
export interface Principal { readonly userId: string; readonly groveId: string }
export interface EchoInput { message: string }
export interface JourneyParams { journeyId: string }
export interface SafeError { code: string; message: string }

export class Fault extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "Fault";
  }
}
export function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function parseInput(value: unknown): EchoInput {
  if (!object(value) || Object.keys(value).some((key) => key !== "message") ||
      typeof value.message !== "string" || value.message.length === 0 ||
      new TextEncoder().encode(value.message).length > 1024) {
    throw new Fault(400, "INVALID_INPUT", "Expected one message of 1 to 1024 UTF-8 bytes.");
  }
  return { message: value.message };
}
export function parseSubmission(value: unknown): EchoInput {
  if (!object(value) || Object.keys(value).some((key) => !["sagaId", "input"].includes(key)) ||
      value.sagaId !== echoSaga.id) {
    throw new Fault(400, "INVALID_SUBMISSION", "Provide the built-in Saga ID and its input only.");
  }
  return parseInput(value.input);
}
export function parseKey(key: string | null): string {
  if (key === null || !/^[a-zA-Z0-9._:-]{16,128}$/.test(key)) {
    throw new Fault(400, "INVALID_IDEMPOTENCY_KEY", "An Idempotency-Key of 16 to 128 safe characters is required.");
  }
  return key;
}
export async function hash(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
export function journeyId(principal: Principal, key: string): Promise<string> {
  return hash(JSON.stringify(["wrangnarok.journey.v1", principal.groveId, principal.userId, parseKey(key)]));
}

/** Shared byte bound, also used before parsing an external Realm response. */
export async function boundedJson(body: ReadableStream<Uint8Array> | null): Promise<unknown> {
  if (body === null) throw new Fault(400, "INVALID_JSON", "A JSON body is required.");
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > BODY_LIMIT) {
        await reader.cancel();
        throw new Fault(413, "BODY_TOO_LARGE", "The body exceeds 4096 bytes.");
      }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new Fault(400, "INVALID_JSON", "The body must be valid UTF-8 JSON."); }
}
