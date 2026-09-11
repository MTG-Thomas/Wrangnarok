// SPDX-License-Identifier: AGPL-3.0
// AUTH-01 (issue #142, ADR 015): Organization and user lifecycle through the
// public APIs. Multi-org allowed/denied matrices for ordinary/admin/external
// users, deactivation, scope selection, cascading-delete previews with
// retained ExecutionHistory, and in-flight job visibility after revocation.
// Runs in real workerd with a real D1 binding; the only doubles are LAB
// fixture identities (distinct LAB_USER_ID per caller) and the admin list.
import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, beforeEach, expect, it } from "vitest";
import worker from "../src/index";
import type { Bindings } from "../src/bindings";
import { echoSaga } from "../src/domain";
import migration1 from "../migrations/0001_initial.sql?raw";
import migration2 from "../migrations/0002_cancelling.sql?raw";
import migration3 from "../migrations/0003_usage_blocks.sql?raw";
import migration4 from "../migrations/0004_solutions_install.sql?raw";
import migration5 from "../migrations/0005_forms.sql?raw";
import migration6 from "../migrations/0006_org_membership.sql?raw";
import migration7 from "../migrations/0007_executions_org_fk.sql?raw";
import seed from "../scripts/seed-local.sql?raw";

const bindings = env as unknown as Bindings;
const TOKEN = "a".repeat(64);
const ORG_A = "00000000-0000-4000-8000-000000000001";
const USER_ADMIN = "00000000-0000-4000-8000-000000000002";
const USER_ORDINARY = "00000000-0000-4000-8000-000000000003";
const USER_EXTERNAL = "00000000-0000-4000-8000-000000000004";
const USER_STRANGER = "00000000-0000-4000-8000-000000000005";

function authed(path: string, method: string, body?: unknown, orgId?: string) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${TOKEN}`,
    ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    ...(orgId === undefined ? {} : { "X-Organization-Id": orgId }),
  };
  return new Request(`http://local.test${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function asUser(userId: string): Bindings {
  return { ...bindings, LAB_USER_ID: userId, LAB_FIXTURE_USER_ID: USER_ADMIN, ADMIN_USER_IDS: USER_ADMIN };
}

async function call(
  path: string,
  method: string,
  userId: string,
  body?: unknown,
  orgId?: string,
  adminIds = USER_ADMIN,
) {
  const b = {
    ...bindings,
    LAB_USER_ID: userId,
    LAB_FIXTURE_USER_ID: USER_ADMIN,
    ADMIN_USER_IDS: adminIds,
  };
  const res = await worker.fetch(authed(path, method, body, orgId), b);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function seedSecondOrg(): Promise<string> {
  // Instance admin creates org B, then invites the matrix: the fixture
  // caller (also instance admin) plus an ordinary and an external member.
  const created = await call("/api/orgs", "POST", USER_ADMIN, { name: "second-org" });
  expect(created.status).toBe(201);
  const orgB = created.body.id as string;
  // The creator holds no membership yet (instance admin bypasses it): invite
  // them as admin so last-admin and membership tests have a real row.
  expect(
    await call(`/api/orgs/${orgB}/members`, "POST", USER_ADMIN, { userId: USER_ADMIN, role: "admin" }),
  ).toMatchObject({
    status: 201,
  });
  expect(await call(`/api/orgs/${orgB}/members`, "POST", USER_ADMIN, { userId: USER_ORDINARY })).toMatchObject({
    status: 201,
  });
  expect(
    await call(`/api/orgs/${orgB}/members`, "POST", USER_ADMIN, { userId: USER_EXTERNAL, kind: "external" }),
  ).toMatchObject({ status: 201 });
  // Activate all three invitations through one verified request each.
  expect(await call("/api/sagas", "GET", USER_ADMIN, undefined, orgB)).toMatchObject({ status: 200 });
  expect(await call("/api/sagas", "GET", USER_ORDINARY, undefined, orgB)).toMatchObject({ status: 200 });
  expect(await call("/api/sagas", "GET", USER_EXTERNAL, undefined, orgB)).toMatchObject({ status: 200 });
  return orgB;
}

beforeEach(async () => {
  await bindings.DB.exec(migration1);
  await bindings.DB.exec(migration2);
  await bindings.DB.exec(migration3);
  await bindings.DB.exec(migration4);
  await bindings.DB.exec(seed);
  await bindings.DB.exec(migration5);
  await bindings.DB.exec(migration6);
  await bindings.DB.exec(migration7);
  // Fixture caller bootstraps to admin of org A inside authenticate; the
  // ordinary identity holds org-A membership too (member), so collection
  // routes gate cleanly. External/stranger stay strangers until invited.
  for (const user of [USER_ORDINARY, USER_EXTERNAL, USER_STRANGER]) {
    await bindings.DB.prepare("INSERT INTO users(user_id,status,created_at) VALUES (?,'active',?)")
      .bind(user, new Date().toISOString())
      .run();
  }
  await bindings.DB.prepare(
    "INSERT INTO org_memberships(org_id,user_id,role,status,kind,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
  )
    .bind(ORG_A, USER_ORDINARY, "member", "active", "ordinary", new Date().toISOString(), new Date().toISOString())
    .run();
});

afterEach(async () => {
  await reset();
});

it("creates orgs as instance admin and refuses ordinary callers", async () => {
  const created = await call("/api/orgs", "POST", USER_ADMIN, { name: "acme" });
  expect(created.status).toBe(201);
  expect(created.body).toMatchObject({ name: "acme", status: "active" });
  // Duplicate names conflict, even across case-insensitive identical input.
  expect(await call("/api/orgs", "POST", USER_ADMIN, { name: "acme" })).toMatchObject({
    status: 409,
    body: { error: { code: "ORG_EXISTS" } },
  });
  // An authenticated member without instance admin cannot create orgs.
  expect(await call("/api/orgs", "POST", USER_ORDINARY, { name: "nope" })).toMatchObject({
    status: 403,
    body: { error: { code: "ADMIN_ONLY" } },
  });
  // Bad names fail closed before touching D1.
  expect(await call("/api/orgs", "POST", USER_ADMIN, { name: "" })).toMatchObject({
    status: 400,
    body: { error: { code: "INVALID_ORG_NAME" } },
  });
});

it("runs the multi-org allowed/denied matrix for ordinary/admin/external users", async () => {
  const orgB = await seedSecondOrg();
  // Instance admin sees both orgs; ordinary member of B sees only B;
  // stranger (no membership anywhere) sees none.
  expect(((await call("/api/orgs", "GET", USER_ADMIN)).body.orgs as unknown[]).length).toBe(2);
  expect(await call("/api/orgs", "GET", USER_ORDINARY)).toMatchObject({ status: 200 });
  // Ordinary holds org A bootstrap membership plus the org B invite.
  expect(
    ((await call("/api/orgs", "GET", USER_ORDINARY)).body.orgs as { id: string }[]).map((o) => o.id).sort(),
  ).toEqual([ORG_A, orgB].sort());
  expect(await call("/api/orgs", "GET", USER_STRANGER)).toMatchObject({ status: 200, body: { orgs: [] } });
  // Ordinary member reads catalog and submits in their own org…
  expect(await call("/api/sagas", "GET", USER_ORDINARY, undefined, orgB)).toMatchObject({ status: 200 });
  const submit = await worker.fetch(
    new Request("http://local.test/api/executions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
        "Idempotency-Key": "auth01-matrix-0001",
        "X-Organization-Id": orgB,
      },
      body: JSON.stringify({ sagaId: echoSaga.id, input: { message: "matrix" } }),
    }),
    asUser(USER_ORDINARY),
  );
  expect(submit.status).toBe(202);
  // …but a true stranger cannot touch org A at all: no scope, no leak
  // (404, never 403).
  expect(await call("/api/sagas", "GET", USER_STRANGER, undefined, ORG_A)).toMatchObject({
    status: 404,
    body: { error: { code: "ORG_NOT_FOUND" } },
  });
  // External member reads and executes like an ordinary member…
  expect(await call("/api/sagas", "GET", USER_EXTERNAL, undefined, orgB)).toMatchObject({ status: 200 });
  // …but can never be promoted to admin through either path.
  expect(
    await call(`/api/orgs/${orgB}/members`, "POST", USER_ADMIN, {
      userId: "ext2@example.com",
      role: "admin",
      kind: "external",
    }),
  ).toMatchObject({ status: 400, body: { error: { code: "INVALID_MEMBERSHIP" } } });
  expect(
    await call(`/api/orgs/${orgB}/members/${USER_EXTERNAL}`, "PATCH", USER_ADMIN, { role: "admin" }),
  ).toMatchObject({ status: 400, body: { error: { code: "INVALID_MEMBERSHIP" } } });
  // Ordinary member reaches no admin route.
  expect(await call(`/api/orgs/${orgB}/members`, "GET", USER_ORDINARY)).toMatchObject({
    status: 403,
    body: { error: { code: "ADMIN_ONLY" } },
  });
  // Stranger cannot select into org B either (selection is not elevation).
  expect(await call("/api/sagas", "GET", USER_STRANGER, undefined, orgB)).toMatchObject({
    status: 404,
    body: { error: { code: "ORG_NOT_FOUND" } },
  });
});

it("deactivates users, orgs, and memberships with immediate effect and no redeploy", async () => {
  const orgB = await seedSecondOrg();
  // Revoked membership fails at the gate on the very next request.
  expect(
    await call(`/api/orgs/${orgB}/members/${USER_ORDINARY}`, "PATCH", USER_ADMIN, { status: "revoked" }),
  ).toMatchObject({
    status: 200,
    body: { status: "revoked" },
  });
  expect(await call("/api/sagas", "GET", USER_ORDINARY, undefined, orgB)).toMatchObject({
    status: 403,
    body: { error: { code: "MEMBERSHIP_REVOKED" } },
  });
  // Suspended external member is denied distinctly.
  expect(
    await call(`/api/orgs/${orgB}/members/${USER_EXTERNAL}`, "PATCH", USER_ADMIN, { status: "suspended" }),
  ).toMatchObject({
    status: 200,
  });
  expect(await call("/api/sagas", "GET", USER_EXTERNAL, undefined, orgB)).toMatchObject({
    status: 403,
    body: { error: { code: "MEMBERSHIP_SUSPENDED" } },
  });
  // Globally disabled user is denied in every org, even with live membership.
  // (A second, non-admin identity proves the denial; the instance admin
  // itself stays recoverable by design, tested below.)
  await bindings.DB.prepare(
    "INSERT INTO org_memberships(org_id,user_id,role,status,kind,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
  )
    .bind(orgB, USER_STRANGER, "member", "active", "ordinary", new Date().toISOString(), new Date().toISOString())
    .run();
  expect(await call(`/api/users/${USER_STRANGER}/disable`, "POST", USER_ADMIN)).toMatchObject({ status: 200 });
  expect(await call("/api/sagas", "GET", USER_STRANGER, undefined, orgB)).toMatchObject({
    status: 403,
    body: { error: { code: "USER_DISABLED" } },
  });
  expect(await call(`/api/users/${USER_STRANGER}/enable`, "POST", USER_ADMIN)).toMatchObject({ status: 200 });
  expect(await call("/api/sagas", "GET", USER_STRANGER, undefined, orgB)).toMatchObject({ status: 200 });
  // Disabled org denies members but stays recoverable by instance admin.
  expect(await call(`/api/orgs/${orgB}/disable`, "POST", USER_ADMIN)).toMatchObject({
    status: 200,
    body: { status: "disabled" },
  });
  expect(await call("/api/sagas", "GET", USER_EXTERNAL, undefined, orgB)).toMatchObject({
    status: 403,
    body: { error: { code: "ORG_DISABLED" } },
  });
  // Instance admin still reaches the disabled org (recovery path).
  expect(await call(`/api/orgs/${orgB}/delete-preview`, "GET", USER_ADMIN)).toMatchObject({ status: 200 });
  expect(await call(`/api/orgs/${orgB}/enable`, "POST", USER_ADMIN)).toMatchObject({
    status: 200,
    body: { status: "active" },
  });
});

it("guards the last admin and refuses to strand a tenant", async () => {
  const orgB = await seedSecondOrg();
  // Only the fixture caller is admin of org B: demotion is refused…
  expect(await call(`/api/orgs/${orgB}/members/${USER_ADMIN}`, "PATCH", USER_ADMIN, { role: "member" })).toMatchObject({
    status: 409,
    body: { error: { code: "LAST_ADMIN" } },
  });
  // …as are suspension and revocation of the last admin.
  expect(
    await call(`/api/orgs/${orgB}/members/${USER_ADMIN}`, "PATCH", USER_ADMIN, { status: "revoked" }),
  ).toMatchObject({
    status: 409,
    body: { error: { code: "LAST_ADMIN" } },
  });
  // Promote a second admin, then the first may step down (the newly
  // promoted admin authorizes the demotion).
  expect(
    await call(`/api/orgs/${orgB}/members/${USER_ORDINARY}`, "PATCH", USER_ADMIN, { role: "admin" }),
  ).toMatchObject({
    status: 200,
    body: { role: "admin" },
  });
  expect(
    await call(`/api/orgs/${orgB}/members/${USER_ADMIN}`, "PATCH", USER_ORDINARY, { role: "member" }),
  ).toMatchObject({
    status: 200,
    body: { role: "member" },
  });
});

it("previews cascading deletes with retained ExecutionHistory and refuses managed rows", async () => {
  const created = await call("/api/orgs", "POST", USER_ADMIN, { name: "doomed" });
  const orgD = created.body.id as string;
  await call(`/api/orgs/${orgD}/members`, "POST", USER_ADMIN, { userId: USER_ORDINARY });
  await call("/api/sagas", "GET", USER_ORDINARY, undefined, orgD);
  const id = "d".repeat(64);
  await bindings.DB.prepare(
    "INSERT INTO executions(id,saga_id,saga_name,saga_revision,org_id,user_id,input_json,dispatched,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
  )
    .bind(
      id,
      echoSaga.id,
      echoSaga.name,
      echoSaga.revision,
      orgD,
      USER_ORDINARY,
      JSON.stringify({ message: "kept" }),
      1,
      "Succeeded",
      new Date().toISOString(),
    )
    .run();
  await bindings.DB.prepare("INSERT INTO operations(execution_id,name,position,status,started_at) VALUES (?,?,?,?,?)")
    .bind(id, "echo-http-v1", 1, "Running", new Date().toISOString())
    .run();
  const preview = await call(`/api/orgs/${orgD}/delete-preview`, "GET", USER_ADMIN);
  expect(preview.status).toBe(200);
  expect(preview.body).toMatchObject({
    executions: 1,
    operations: 1,
    connectionsLoose: 0,
    connectionsManaged: 0,
    memberships: 1,
    retained: ["executions", "operations"],
    canDelete: true,
  });
  // Authenticated members hitting instance-admin routes are denied (403):
  // the gate passes on the path-target membership, the admin check refuses.
  expect(await call(`/api/orgs/${orgD}/delete-preview`, "GET", USER_ORDINARY)).toMatchObject({ status: 403 });
  const deleted = await call(`/api/orgs/${orgD}`, "DELETE", USER_ADMIN);
  expect(deleted.status).toBe(200);
  expect(deleted.body).toMatchObject({ orgId: orgD, deletedMemberships: 1 });
  // ExecutionHistory rows survive the delete: still in D1, unreachable via API.
  const exec = await bindings.DB.prepare("SELECT id FROM executions WHERE id=?").bind(id).first<{ id: string }>();
  expect(exec?.id).toBe(id);
  expect(await call("/api/sagas", "GET", USER_ORDINARY, undefined, orgD)).toMatchObject({ status: 404 });
  // A managed Connection blocks deletion until the bundle is uninstalled.
  const created2 = await call("/api/orgs", "POST", USER_ADMIN, { name: "managed" });
  const orgM = created2.body.id as string;
  await bindings.DB.prepare("INSERT INTO connections(id,org_id,integration_id,endpoint,managed_by) VALUES (?,?,?,?,?)")
    .bind(
      "00000000-0000-4000-8000-000000000201",
      orgM,
      "720b9ebf-9b6a-4eac-bae9-6ed22c970402",
      "http://127.0.0.1:8788/echo",
      "bundle@1.0.0",
    )
    .run();
  const blocked = await call(`/api/orgs/${orgM}/delete-preview`, "GET", USER_ADMIN);
  expect(blocked.body).toMatchObject({ canDelete: false, connectionsManaged: 1 });
  expect(await call(`/api/orgs/${orgM}`, "DELETE", USER_ADMIN)).toMatchObject({
    status: 409,
    body: { error: { code: "DELETE_BLOCKED" } },
  });
});

it("keeps in-flight jobs visible to org admins after a member is revoked", async () => {
  const orgB = await seedSecondOrg();
  const submit = await worker.fetch(
    new Request("http://local.test/api/executions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
        "Idempotency-Key": "auth01-inflight-001",
        "X-Organization-Id": orgB,
      },
      body: JSON.stringify({ sagaId: echoSaga.id, input: { message: "inflight" } }),
    }),
    asUser(USER_ORDINARY),
  );
  expect(submit.status).toBe(202);
  const { executionId } = (await submit.json()) as { executionId: string };
  // Revoke the submitter: their own reads fail at the gate…
  expect(
    await call(`/api/orgs/${orgB}/members/${USER_ORDINARY}`, "PATCH", USER_ADMIN, { status: "revoked" }),
  ).toMatchObject({
    status: 200,
  });
  // …but the org admin history surface still shows the in-flight job.
  const adminHistory = await call(`/api/orgs/${orgB}/executions`, "GET", USER_ADMIN);
  expect(adminHistory.status).toBe(200);
  expect(JSON.stringify(adminHistory.body)).toContain(executionId);
  // The revoked member's Execution row is untouched: still Pending/Running.
  const row = await bindings.DB.prepare("SELECT status FROM executions WHERE id=?")
    .bind(executionId)
    .first<{ status: string }>();
  expect(["Pending", "Running"]).toContain(row?.status);
  // Non-admin members never administer, even in their own org (403).
  expect(await call(`/api/orgs/${orgB}/executions`, "GET", USER_EXTERNAL)).toMatchObject({ status: 403 });
});

it("fails closed without migration 0006 and refuses cross-org elevation", async () => {
  // Drop every table to simulate a pre-0006 database, then rebuild only
  // through 0001+seed: the gate answers 503, never open. (D1 has no
  // migration-down; DROP is the local equivalent. This test is last, so no
  // rebuild is needed afterward.)
  await bindings.DB.exec(
    "DROP TABLE IF EXISTS operations; DROP TABLE IF EXISTS executions; DROP TABLE IF EXISTS bundle_installs; DROP TABLE IF EXISTS connections; DROP TABLE IF EXISTS usage_blocks; DROP TABLE IF EXISTS forms; DROP TABLE IF EXISTS org_memberships; DROP TABLE IF EXISTS users; DROP TABLE IF EXISTS organizations;",
  );
  await bindings.DB.exec(migration1);
  await bindings.DB.exec(seed);
  // The old organizations row predates the status column; SELECT * still
  // works and the gate proceeds to the missing users table.
  expect(await call("/api/sagas", "GET", USER_ADMIN)).toMatchObject({
    status: 503,
    body: { error: { code: "ORG_STORE_NOT_MIGRATED" } },
  });
  await bindings.DB.exec(migration6);
  // Re-bootstrap users the DROP removed: fixture admin regains org A via
  // auth bootstrap, strangers stay known-but-powerless.
  for (const user of [USER_ORDINARY, USER_EXTERNAL, USER_STRANGER]) {
    await bindings.DB.prepare("INSERT INTO users(user_id,status,created_at) VALUES (?,'active',?)")
      .bind(user, new Date().toISOString())
      .run();
  }
  const orgB = await seedSecondOrg();
  // Malformed scope headers fail closed.
  const bad = await worker.fetch(
    new Request("http://local.test/api/sagas", {
      headers: { Authorization: `Bearer ${TOKEN}`, "X-Organization-Id": "not-a-uuid" },
    }),
    asUser(USER_ADMIN),
  );
  expect(bad.status).toBe(400);
  expect(await bad.json()).toMatchObject({ error: { code: "INVALID_ORG_ID" } });
  // Unknown-but-valid org UUIDs answer 404, never a leak.
  expect(await call("/api/sagas", "GET", USER_ADMIN, undefined, "aaaaaaaa-1111-4111-8111-111111111111")).toMatchObject({
    status: 404,
  });
  // Admin of B is still a stranger in A for member management.
  expect(await call(`/api/orgs/${ORG_A}/members`, "GET", USER_ORDINARY)).toMatchObject({ status: 404 });
  expect(orgB.length).toBe(36);
});
