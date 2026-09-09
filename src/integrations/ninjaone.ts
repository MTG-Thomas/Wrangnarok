// SPDX-License-Identifier: AGPL-3.0
import {
  boundedJson,
  Fault,
  NINJA_INTEGRATION_ID,
  NINJA_ORGS_MAX,
  NINJA_ORGS_PATH,
  NINJA_SCOPE,
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

/** Read-only Action: census NinjaOne organizations. Never persists secrets. */
export async function listOrganizations(
  connection: NinjaConnection,
  credentials: NinjaCredentials,
): Promise<NinjaOrgsResult> {
  // Token stays a transient local: fetched, used, dropped. It must never
  // reach D1, ExecutionHistory, logs, or Workflow persisted state.
  const token = await fetchToken(connection, credentials);
  const response = await fetch(`${connection.endpoint}${NINJA_ORGS_PATH}`, {
    method: "GET",
    redirect: "manual",
    signal: AbortSignal.timeout(5000),
    headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
  });
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
  const response = await fetch(tokenUrl, {
    method: "POST",
    redirect: "manual",
    signal: AbortSignal.timeout(5000),
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      scope: NINJA_SCOPE,
    }).toString(),
  });
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    throw new Fault(502, "NINJA_AUTH_FAILED", "NinjaOne redirected the token request.");
  }
  if (response.status === 401) {
    await response.body?.cancel();
    throw new Fault(502, "NINJA_UNAUTHORIZED", "NinjaOne rejected the credentials.");
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
