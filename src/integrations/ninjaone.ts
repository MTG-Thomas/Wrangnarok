// SPDX-License-Identifier: AGPL-3.0
import {
  boundedJson,
  Fault,
  NINJA_INTEGRATION_ID,
  NINJA_ORGS_MAX,
  NINJA_ORGS_PATH,
  NINJA_SCOPE,
  NINJA_TIMEOUT_MS,
  NINJA_TOKEN_PATH,
} from "../domain";
import type { NinjaOrgSummary, NinjaOrgsResult } from "../domain";
export const ninjaIntegration = Object.freeze({ id: NINJA_INTEGRATION_ID, name: "ninjaone" });
export interface NinjaConnection {
  endpoint: string;
}
export interface NinjaCredentials {
  clientId: string;
  clientSecret: string;
}
/** Credential handle as the Saga sees it: presence is NOT guaranteed. The
 * Action owns the presence check below, so Saga steps never branch on
 * credentials — they pass the handle through the Integration boundary and
 * map the resulting Fault like any other downstream error. */
export interface NinjaSecrets {
  readonly clientId?: string;
  readonly clientSecret?: string;
}

/** Read-only Action: census NinjaOne organizations. Never persists secrets.
 * Credential presence is enforced here, behind the Action boundary: a Saga
 * step passes its secret handle straight through and maps NINJA_NOT_CONFIGURED
 * like any other structured downstream error. */
export async function listOrganizations(connection: NinjaConnection, secrets: NinjaSecrets): Promise<NinjaOrgsResult> {
  const { clientId, clientSecret } = secrets;
  if (!clientId || !clientSecret) {
    throw new Fault(502, "NINJA_NOT_CONFIGURED", "NinjaOne credentials are not configured.");
  }
  // Token stays a transient local: fetched, used, dropped. It must never
  // reach D1, ExecutionHistory, logs, or Workflow persisted state.
  const token = await fetchToken(connection, { clientId, clientSecret });
  // Explicit deadline, same posture as echo: a vendor that is slow (abort
  // fires) or merely late (resolves after the deadline because the transport
  // ignored the abort) surfaces NINJA_VENDOR_TIMEOUT.
  const started = Date.now();
  const timedOut = () => Date.now() - started >= NINJA_TIMEOUT_MS;
  let response: Response;
  try {
    response = await fetch(`${connection.endpoint}${NINJA_ORGS_PATH}`, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(NINJA_TIMEOUT_MS),
      headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
    });
  } catch (error) {
    throwIfNinjaTimeout(error);
    throw error;
  }
  if (timedOut()) {
    await response.body?.cancel();
    throw new Fault(504, "NINJA_VENDOR_TIMEOUT", "NinjaOne exceeded its deadline.");
  }
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    throw new Fault(502, "NINJA_VENDOR_FAILED", "NinjaOne redirected the request.");
  }
  if (response.status === 401) {
    await response.body?.cancel();
    throw new Fault(502, "NINJA_UNAUTHORIZED", "NinjaOne rejected the credentials.");
  }
  if (response.status === 429) {
    await response.body?.cancel();
    throw new Fault(502, "NINJA_RATE_LIMITED", "NinjaOne rate-limited the request.");
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Fault(502, "NINJA_VENDOR_FAILED", "NinjaOne did not return organizations.");
  }
  // Transport cap is generous: real tenants return tens of KB. What persists
  // is still the shaped summary under the D1 result CHECK bound.
  const value = await boundedJson(response.body, 262144);
  if (!Array.isArray(value))
    throw new Fault(502, "NINJA_BAD_RESPONSE", "NinjaOne returned an unexpected organization list.");
  const organizations: NinjaOrgSummary[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Fault(502, "NINJA_BAD_RESPONSE", "NinjaOne returned an unexpected organization list.");
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.id !== "number" || typeof record.name !== "string") {
      throw new Fault(502, "NINJA_BAD_RESPONSE", "NinjaOne returned an unexpected organization list.");
    }
    if (organizations.length < NINJA_ORGS_MAX) organizations.push({ id: record.id, name: record.name });
  }
  return { organizationCount: value.length, organizations };
}

async function fetchToken(connection: NinjaConnection, credentials: NinjaCredentials): Promise<string> {
  // Regional token host derived from the Connection endpoint, so an EU/OC
  // Connection authenticates against its own region with no code change.
  // Scope is pinned read-only; the M2M app carries nothing broader.
  const tokenUrl = new URL(NINJA_TOKEN_PATH, connection.endpoint).toString();
  let response: Response;
  try {
    response = await fetch(tokenUrl, {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(NINJA_TIMEOUT_MS),
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: credentials.clientId,
        client_secret: credentials.clientSecret,
        scope: NINJA_SCOPE,
      }).toString(),
    });
  } catch (error) {
    throwIfNinjaTimeout(error);
    throw error;
  }
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    throw new Fault(502, "NINJA_AUTH_FAILED", "NinjaOne redirected the token request.");
  }
  if (response.status === 401) {
    await response.body?.cancel();
    throw new Fault(502, "NINJA_UNAUTHORIZED", "NinjaOne rejected the credentials.");
  }
  if (response.status === 429) {
    await response.body?.cancel();
    throw new Fault(502, "NINJA_RATE_LIMITED", "NinjaOne rate-limited the token request.");
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Fault(502, "NINJA_AUTH_FAILED", "NinjaOne did not issue a token.");
  }
  const value = await boundedJson(response.body);
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    typeof (value as Record<string, unknown>).access_token !== "string" ||
    ((value as Record<string, unknown>).access_token as string).length === 0
  ) {
    throw new Fault(502, "NINJA_BAD_RESPONSE", "NinjaOne returned an unexpected token response.");
  }
  return (value as Record<string, unknown>).access_token as string;
}

/** A slow vendor is an actionable deadline, not a generic vendor failure:
 * map abort/timeout rejections onto NINJA_VENDOR_TIMEOUT so Sagas can route
 * them to the explicit timeout checkpoint. Any other transport error
 * propagates raw and the Saga maps it to NINJA_INTEGRATION_FAILED. */
function throwIfNinjaTimeout(error: unknown): void {
  if (error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError")) {
    throw new Fault(504, "NINJA_VENDOR_TIMEOUT", "NinjaOne exceeded its deadline.");
  }
}
