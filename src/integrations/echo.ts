// SPDX-License-Identifier: AGPL-3.0
import { boundedJson, ECHO_INTEGRATION_ID, Fault, parseInput, VENDOR_TIMEOUT_MS } from "../domain";
import type { EchoInput } from "../domain";
export const echoIntegration = Object.freeze({ id: ECHO_INTEGRATION_ID, name: "echo" });
/** Local fixture URL: the only loopback endpoint the echo Integration serves.
 * Portable default for local deployments only — non-local deployments must
 * configure an explicit HTTPS endpoint (issue #239). */
export const ECHO_FIXTURE_ENDPOINT = "http://127.0.0.1:8788/echo";
/** True for the local fixture URL. Anything else must be explicit HTTPS. */
export function isEchoFixtureEndpoint(endpoint: string): boolean {
  return endpoint === ECHO_FIXTURE_ENDPOINT;
}
/** True for explicit non-local echo endpoints: HTTPS with a non-loopback host. */
export function isEchoHttpsEndpoint(endpoint: string): boolean {
  if (!endpoint.startsWith("https://")) return false;
  const host = endpoint.slice("https://".length).split("/")[0]?.toLowerCase() ?? "";
  return host.length > 0 && host !== "localhost" && !host.startsWith("127.") && host !== "[::1]" && host !== "0.0.0.0";
}
export interface EchoConnection {
  endpoint: string;
}
/** Fixture-only Action: POST echoes data without mutating any external resource.
 * Enforces its own explicit deadline: a vendor that is slow (abort fires) or
 * merely late (resolves after the deadline because the transport ignored the
 * abort) surfaces ECHO_VENDOR_TIMEOUT. The Saga maps that code onto the
 * explicit timeout-mark-v1 checkpoint; TimedOut is never inferred. */
export async function echo(
  connection: EchoConnection,
  input: EchoInput,
  operationId: string,
  timeoutMs = VENDOR_TIMEOUT_MS,
): Promise<EchoInput> {
  // Fixture-only by default, explicit HTTPS elsewhere (issue #239): the
  // local fixture URL serves local development; any other endpoint must be
  // an explicit non-loopback HTTPS URL so transport is never cleartext past
  // loopback. Connection writes enforce the same rule per environment.
  if (!isEchoFixtureEndpoint(connection.endpoint) && !isEchoHttpsEndpoint(connection.endpoint)) {
    throw new Fault(
      500,
      "INVALID_CONNECTION",
      "The echo Integration requires its local fixture endpoint or explicit HTTPS.",
    );
  }
  const started = Date.now();
  const timedOut = () => Date.now() - started >= timeoutMs;
  try {
    const response = await fetch(connection.endpoint, {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "Content-Type": "application/json", "Idempotency-Key": operationId },
      body: JSON.stringify(input),
    });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new Error("echo_http_redirect");
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("echo_http_failure");
    }
    const output = parseInput(await boundedJson(response.body));
    if (output.message !== input.message) throw new Error("echo_output_mismatch");
    if (timedOut()) throw new Fault(504, "ECHO_VENDOR_TIMEOUT", "The echo Integration exceeded its deadline.");
    return output;
  } catch (error) {
    // Never persist a vendor response body, URL, request headers, or raw exception.
    if (error instanceof Fault) throw error;
    if (
      timedOut() ||
      (error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError"))
    ) {
      throw new Fault(504, "ECHO_VENDOR_TIMEOUT", "The echo Integration exceeded its deadline.");
    }
    throw new Fault(502, "ECHO_INTEGRATION_FAILED", "The local echo Integration did not return the expected response.");
  }
}
