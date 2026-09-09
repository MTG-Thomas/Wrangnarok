// SPDX-License-Identifier: AGPL-3.0
import { Fault, hash, UUID } from "./domain";
import type { Principal } from "./domain";
export interface LabAuth {
  LAB_ENABLED?: string;
  LAB_TOKEN?: string;
  LAB_ORG_ID?: string;
  LAB_USER_ID?: string;
}
/** Local fixture only. Organization and user never come from request headers or JSON. */
export async function authenticate(request: Request, env: LabAuth): Promise<Principal> {
  if (env.LAB_ENABLED !== "true") throw new Fault(404, "NOT_FOUND", "Not found.");
  if (!env.LAB_TOKEN || !/^[a-f0-9]{64}$/.test(env.LAB_TOKEN) ||
      !env.LAB_ORG_ID || !UUID.test(env.LAB_ORG_ID) ||
      !env.LAB_USER_ID || !UUID.test(env.LAB_USER_ID)) {
    throw new Fault(503, "LOCAL_AUTH_NOT_CONFIGURED", "Run the local setup script.");
  }
  const supplied = request.headers.get("Authorization") ?? "";
  if (supplied.length > 128) throw new Fault(401, "UNAUTHORIZED", "Unauthorized.");
  const [actual, expected] = await Promise.all([hash(supplied), hash(`Bearer ${env.LAB_TOKEN}`)]);
  let difference = 0;
  for (let i = 0; i < expected.length; i++) difference |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  if (difference !== 0) throw new Fault(401, "UNAUTHORIZED", "Unauthorized.");
  return { userId: env.LAB_USER_ID.toLowerCase(), orgId: env.LAB_ORG_ID.toLowerCase() };
}
