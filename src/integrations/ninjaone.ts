// SPDX-License-Identifier: AGPL-3.0
import { boundedJson, Fault, NINJA_INTEGRATION_ID, NINJA_ORGS_MAX, NINJA_ORGS_PATH, NINJA_TOKEN_URL } from "../domain";
import type { NinjaOrgSummary, NinjaOrgsResult } from "../domain";
export const ninjaIntegration = Object.freeze({ id: NINJA_INTEGRATION_ID, name: "ninjaone" });
export interface NinjaConnection { endpoint: string }
export interface NinjaCredentials { clientId: string; clientSecret: string }

/** Read-only Action: census NinjaOne organizations. Never persists secrets. */
export async function listOrganizations(
  connection: NinjaConnection, credentials: NinjaCredentials,
): Promise<NinjaOrgsResult> {
  // Token stays a transient local: fetched, used, dropped. It must never
  // reach D1, ExecutionHistory, logs, or Workflow persisted state.
  const token = await fetchToken(credentials);
  const response = await fetch(`${connection.endpoint}${NINJA_ORGS_PATH}`, {
    method: "GET", redirect: "error", signal: AbortSignal.timeout(5000),
    headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
  });
  if (response.status === 401) { await response.body?.cancel(); throw new Fault(502, "NINJA_UNAUTHORIZED", "NinjaOne rejected the credentials."); }
  if (response.status === 429) { await response.body?.cancel(); throw new Fault(502, "NINJA_RATE_LIMITED", "NinjaOne rate-limited the request."); }
  if (!response.ok) { await response.body?.cancel(); throw new Fault(502, "NINJA_VENDOR_FAILED", "NinjaOne did not return organizations."); }
  const value = await boundedJson(response.body);
  if (!Array.isArray(value)) throw new Fault(502, "NINJA_BAD_RESPONSE", "NinjaOne returned an unexpected organization list.");
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

async function fetchToken(credentials: NinjaCredentials): Promise<string> {
  // Token host differs from the regional API host; both are constants
  // verified live 2026-09-09 (no creds). Re-verify with real credentials.
  const response = await fetch(NINJA_TOKEN_URL, {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(5000),
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
    }).toString(),
  });
  if (response.status === 401) { await response.body?.cancel(); throw new Fault(502, "NINJA_UNAUTHORIZED", "NinjaOne rejected the credentials."); }
  if (!response.ok) { await response.body?.cancel(); throw new Fault(502, "NINJA_AUTH_FAILED", "NinjaOne did not issue a token."); }
  const value = await boundedJson(response.body);
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
      typeof (value as Record<string, unknown>).access_token !== "string" ||
      ((value as Record<string, unknown>).access_token as string).length === 0) {
    throw new Fault(502, "NINJA_BAD_RESPONSE", "NinjaOne returned an unexpected token response.");
  }
  return (value as Record<string, unknown>).access_token as string;
}
