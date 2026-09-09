// SPDX-License-Identifier: AGPL-3.0
import { boundedJson, ECHO_INTEGRATION_ID, Fault, parseInput } from "../domain";
import type { EchoInput } from "../domain";
export const echoIntegration = Object.freeze({ id: ECHO_INTEGRATION_ID, name: "echo" });
export interface EchoConnection { endpoint: string }
/** Fixture-only Action: POST echoes data without mutating any external resource. */
export async function echo(connection: EchoConnection, input: EchoInput, operationId: string): Promise<EchoInput> {
  // The first slice supports only this local vendor fixture, not arbitrary user URLs.
  if (connection.endpoint !== "http://127.0.0.1:8788/echo") {
    throw new Fault(500, "INVALID_CONNECTION", "The echo Integration requires its local fixture endpoint.");
  }
  try {
    const response = await fetch(connection.endpoint, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(5000),
      headers: { "Content-Type": "application/json", "Idempotency-Key": operationId },
      body: JSON.stringify(input),
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error("echo_http_failure"); }
    const output = parseInput(await boundedJson(response.body));
    if (output.message !== input.message) throw new Error("echo_output_mismatch");
    return output;
  } catch {
    // Never persist a vendor response body, URL, request headers, or raw exception.
    throw new Fault(502, "ECHO_INTEGRATION_FAILED", "The local echo Integration did not return the expected response.");
  }
}
