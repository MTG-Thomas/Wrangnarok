// SPDX-License-Identifier: AGPL-3.0
// Lane branch-coverage sweep (issue #186 follow-up): focused unit-level tests
// for the highest-yield uncovered branch arms measured on the post-rebase
// baseline (41 files green, 95.17% branches). No behavior change; pure
// node-safe validators plus real local D1 through the full migration chain.
import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createApp, deleteApp, editAppSource, jobDetail, listJobs, startBuild, swapSlugs } from "../src/apps";
import type { Bindings } from "../src/bindings";
import type { CallerCtx } from "../src/orgs";
import {
  canManageOrg,
  deleteOrg,
  ensureLabFixture,
  getOrgSummary,
  inviteMember,
  listMembers,
  parseOrgId,
  parseOrgName,
  parseUserId,
  resolveCaller,
  resolveUser,
  setOrgStatus,
  setUserStatus,
} from "../src/orgs";
import migration1 from "../migrations/0001_initial.sql?raw";
import migration6 from "../migrations/0006_apps.sql?raw";
import migration7 from "../migrations/0007_org_membership.sql?raw";

const bindings = env as unknown as Bindings;
const ORG = "00000000-0000-4000-8000-000000000001";
const ADMIN = "00000000-0000-4000-8000-000000000002";
const MEMBER = "00000000-0000-4000-8000-000000000003";

beforeEach(async () => {
  await bindings.DB.exec(migration1);
  await bindings.DB.exec(migration6);
  await bindings.DB.exec(migration7);
});

afterEach(async () => {
  await reset();
});
import { parseHistoryQuery } from "../src/domain";
import { validateLockfile } from "../src/dev";
import { parseSagaCatalog } from "../src/sdk";
import { convertWorkspaceToBundle } from "../src/migration";
import { ECHO_INTEGRATION_ID, echoSaga } from "../src/domain";

const BUNDLE_ID = "b10a7c2e-3f4d-4a5b-8c6d-7e8f9a0b1c2d";
const WORKFLOW_UUID = "aaaaaaaa-1111-4111-8111-111111111111";
const ECHO_ENDPOINT = "http://127.0.0.1:8788/echo";

function bridgeOpts() {
  return {
    bundleId: BUNDLE_ID,
    sagas: { [WORKFLOW_UUID]: { id: echoSaga.id, revision: echoSaga.revision } },
    integrations: {
      echo: { id: ECHO_INTEGRATION_ID, org: "default", endpoint: ECHO_ENDPOINT, secretsRequired: [] },
    },
  };
}

it("lists jobs and guards job detail shapes at the unit level", async () => {
  const caller = { orgId: ORG, userId: ADMIN };
  const app = await createApp(bindings.DB, caller, "unit-jobs-sweep", "unit-jobs-sweep");
  expect(await listJobs(bindings.DB, caller, app.id)).toEqual([]);
  await editAppSource(bindings.DB, caller, app.id, {
    files: [{ path: "index.html", content: "<h1>unit</h1>" }],
    dependencies: [],
  });
  const job = await startBuild(bindings.DB, caller, app.id);
  expect(job.status).toBe("succeeded");
  expect((await jobDetail(bindings.DB, caller, app.id, job.id)).id).toBe(job.id);
  await expect(jobDetail(bindings.DB, caller, app.id, "00000000-0000-4000-8000-000000000099")).rejects.toMatchObject({
    code: "JOB_NOT_FOUND",
  });
  const other = await createApp(bindings.DB, caller, "unit-other-sweep", "unit-other-sweep");
  const swapped = await swapSlugs(bindings.DB, caller, app.id, other.id);
  expect(swapped.app.slug).toBe("unit-other-sweep");
  expect(swapped.other.slug).toBe("unit-jobs-sweep");
  await deleteApp(bindings.DB, caller, other.id);
  await expect(jobDetail(bindings.DB, caller, other.id, job.id)).rejects.toMatchObject({ code: "APP_NOT_FOUND" });
});

it("maps unknown stored enums to safe defaults on read", async () => {
  const stamp = new Date().toISOString();
  await bindings.DB.prepare("INSERT INTO organizations(id,name) VALUES (?,?)").bind(ORG, "odd").run();
  await bindings.DB.prepare("INSERT INTO users(user_id,status,created_at) VALUES (?,'active',?)")
    .bind("odd@example.com", stamp)
    .run();
  await bindings.DB.prepare(
    "INSERT INTO org_memberships(org_id,user_id,role,status,kind,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
  )
    .bind(ORG, "odd@example.com", "owner", "limbo", "alien", stamp, stamp)
    .run();
  const [member] = await listMembers(bindings.DB, ORG);
  expect(member).toMatchObject({ userId: "odd@example.com", role: "member", status: "suspended", kind: "ordinary" });
});

it("fails getOrg closed when the organizations table is gone", async () => {
  await bindings.DB.exec("DROP TABLE org_memberships; DROP TABLE users; DROP TABLE organizations;");
  await expect(getOrgSummary(bindings.DB, ORG)).rejects.toMatchObject({ code: "ORG_STORE_NOT_MIGRATED" });
});

it("lists members and refuses unknown orgs", async () => {
  const stamp = new Date().toISOString();
  await bindings.DB.prepare("INSERT INTO organizations(id,name) VALUES (?,?)").bind(ORG, "members").run();
  await bindings.DB.prepare("INSERT INTO users(user_id,status,created_at) VALUES (?,'active',?)")
    .bind("member@example.com", stamp)
    .run();
  await bindings.DB.prepare(
    "INSERT INTO org_memberships(org_id,user_id,role,status,kind,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
  )
    .bind(ORG, "member@example.com", "member", "active", "ordinary", stamp, stamp)
    .run();
  expect(await listMembers(bindings.DB, ORG)).toHaveLength(1);
  await expect(listMembers(bindings.DB, "00000000-0000-4000-8000-000000000099")).rejects.toMatchObject({
    code: "ORG_NOT_FOUND",
  });
});

it("toggles org and user status through the unit helpers", async () => {
  const stamp = new Date().toISOString();
  await bindings.DB.prepare("INSERT INTO organizations(id,name) VALUES (?,?)").bind(ORG, "toggles").run();
  await bindings.DB.prepare("INSERT INTO users(user_id,status,created_at) VALUES (?,'active',?)")
    .bind("toggle@example.com", stamp)
    .run();
  expect(await setOrgStatus(bindings.DB, ORG, true)).toMatchObject({ status: "disabled" });
  expect(await setOrgStatus(bindings.DB, ORG, false)).toMatchObject({ status: "active" });
  await expect(setOrgStatus(bindings.DB, "00000000-0000-4000-8000-000000000099", true)).rejects.toMatchObject({
    code: "ORG_NOT_FOUND",
  });
  expect(await setUserStatus(bindings.DB, "toggle@example.com", true)).toMatchObject({ status: "disabled" });
  expect(await setUserStatus(bindings.DB, "toggle@example.com", false)).toMatchObject({ status: "active" });
  await expect(setUserStatus(bindings.DB, "ghost@example.com", true)).rejects.toMatchObject({
    code: "USER_NOT_FOUND",
  });
});

it("deletes empty orgs and keeps the preview honest", async () => {
  const stamp = new Date().toISOString();
  await bindings.DB.prepare("INSERT INTO organizations(id,name) VALUES (?,?)").bind(ORG, "deletable").run();
  await bindings.DB.prepare("INSERT INTO users(user_id,status,created_at) VALUES (?,'active',?)")
    .bind("gone@example.com", stamp)
    .run();
  await bindings.DB.prepare(
    "INSERT INTO org_memberships(org_id,user_id,role,status,kind,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
  )
    .bind(ORG, "gone@example.com", "member", "active", "ordinary", stamp, stamp)
    .run();
  const removed = await deleteOrg(bindings.DB, ORG);
  expect(removed).toMatchObject({ orgId: ORG, deletedMemberships: 1, deletedConnections: 0 });
  await expect(getOrgSummary(bindings.DB, ORG)).rejects.toMatchObject({ code: "ORG_NOT_FOUND" });
});

it("rejects malformed user and org ids before touching D1", () => {
  expect(() => parseUserId(7)).toThrow(expect.objectContaining({ code: "INVALID_USER_ID" }));
  expect(() => parseUserId("")).toThrow(expect.objectContaining({ code: "INVALID_USER_ID" }));
  expect(() => parseOrgId("not-a-uuid")).toThrow(expect.objectContaining({ code: "INVALID_ORG_ID" }));
});

it("fails the collection gate closed when the users table is gone", async () => {
  await bindings.DB.exec("DROP TABLE users;");
  await expect(resolveUser(bindings.DB, {}, { userId: MEMBER, orgId: ORG })).rejects.toMatchObject({
    code: "ORG_STORE_NOT_MIGRATED",
  });
});

it("fails scoped routes closed when the membership table is gone", async () => {
  const stamp = new Date().toISOString();
  await bindings.DB.prepare("INSERT INTO organizations(id,name) VALUES (?,?)").bind(ORG, "scoped").run();
  await bindings.DB.prepare("INSERT INTO users(user_id,status,created_at) VALUES (?,'active',?)")
    .bind("member@example.com", stamp)
    .run();
  await bindings.DB.exec("DROP TABLE org_memberships;");
  await expect(resolveCaller(bindings.DB, {}, { userId: "member@example.com", orgId: ORG })).rejects.toMatchObject({
    code: "ORG_STORE_NOT_MIGRATED",
  });
});

it("pins resolveUser for admins, strangers, and disabled users", async () => {
  const stamp = new Date().toISOString();
  await bindings.DB.prepare("INSERT INTO organizations(id,name) VALUES (?,?)").bind(ORG, "gate").run();
  expect(await resolveUser(bindings.DB, { ADMIN_USER_IDS: ADMIN }, { userId: ADMIN, orgId: ORG })).toMatchObject({
    isInstanceAdmin: true,
  });
  await expect(resolveUser(bindings.DB, {}, { userId: "stranger@example.com", orgId: ORG })).rejects.toMatchObject({
    code: "ORG_NOT_FOUND",
  });
  await bindings.DB.prepare("INSERT INTO users(user_id,status,created_at) VALUES (?,'active',?)")
    .bind(MEMBER, stamp)
    .run();
  expect(await resolveUser(bindings.DB, {}, { userId: MEMBER, orgId: ORG })).toMatchObject({
    isInstanceAdmin: false,
  });
  await bindings.DB.prepare("UPDATE users SET status='disabled' WHERE user_id=?").bind(MEMBER).run();
  await expect(resolveUser(bindings.DB, {}, { userId: MEMBER, orgId: ORG })).rejects.toMatchObject({
    code: "USER_DISABLED",
  });
});

it("reads org summaries and refuses unknown rows", async () => {
  await bindings.DB.prepare("INSERT INTO organizations(id,name) VALUES (?,?)").bind(ORG, "summaries").run();
  expect(await getOrgSummary(bindings.DB, ORG)).toMatchObject({ id: ORG, name: "summaries" });
  await expect(getOrgSummary(bindings.DB, "00000000-0000-4000-8000-000000000099")).rejects.toMatchObject({
    code: "ORG_NOT_FOUND",
  });
});

it("invites live admins directly without the route layer", async () => {
  await bindings.DB.prepare("INSERT INTO organizations(id,name) VALUES (?,?)").bind(ORG, "invites").run();
  const admin = await inviteMember(bindings.DB, ORG, "direct-admin@example.com", "admin");
  expect(admin).toMatchObject({ role: "admin", status: "invited" });
  await bindings.DB.prepare("UPDATE users SET status='disabled' WHERE user_id=?")
    .bind("direct-admin@example.com")
    .run();
  await expect(inviteMember(bindings.DB, ORG, "direct-admin@example.com")).rejects.toMatchObject({
    code: "USER_DISABLED",
  });
});

it("pins the admin-management predicate across membership and user states", async () => {
  const stamp = new Date().toISOString();
  await bindings.DB.prepare("INSERT INTO organizations(id,name) VALUES (?,?)").bind(ORG, "matrix").run();
  await bindings.DB.prepare("INSERT INTO users(user_id,status,created_at) VALUES (?,'active',?)")
    .bind(ADMIN, stamp)
    .run();
  await bindings.DB.prepare("INSERT INTO users(user_id,status,created_at) VALUES (?,'active',?)")
    .bind(MEMBER, stamp)
    .run();
  await bindings.DB.prepare(
    "INSERT INTO org_memberships(org_id,user_id,role,status,kind,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
  )
    .bind(ORG, MEMBER, "admin", "active", "ordinary", stamp, stamp)
    .run();
  const admin = {
    principal: { userId: ADMIN, orgId: ORG },
    role: null,
    kind: null,
    isInstanceAdmin: true,
    isOrgAdmin: false,
  };
  expect(await canManageOrg(bindings.DB, admin, ORG)).toBe(true);
  const member: CallerCtx = {
    principal: { userId: MEMBER, orgId: ORG },
    role: "admin",
    kind: "ordinary",
    isInstanceAdmin: false,
    isOrgAdmin: true,
  };
  expect(await canManageOrg(bindings.DB, member, ORG)).toBe(true);
  expect(
    await canManageOrg(bindings.DB, { ...member, principal: { userId: "nobody@example.com", orgId: ORG } }, ORG),
  ).toBe(false);
  await bindings.DB.prepare("UPDATE users SET status='disabled' WHERE user_id=?").bind(MEMBER).run();
  expect(await canManageOrg(bindings.DB, member, ORG)).toBe(false);
  await bindings.DB.prepare("DELETE FROM org_memberships WHERE org_id=? AND user_id=?").bind(ORG, MEMBER).run();
  await bindings.DB.prepare("DELETE FROM users WHERE user_id=?").bind(MEMBER).run();
  await bindings.DB.prepare("INSERT INTO users(user_id,status,created_at) VALUES (?,'active',?)")
    .bind("ghost-admin@example.com", stamp)
    .run();
  await bindings.DB.prepare(
    "INSERT INTO org_memberships(org_id,user_id,role,status,kind,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
  )
    .bind(ORG, "ghost-admin@example.com", "admin", "active", "ordinary", stamp, stamp)
    .run();
  const ghost: CallerCtx = {
    principal: { userId: "ghost-admin@example.com", orgId: ORG },
    role: "admin",
    kind: "ordinary",
    isInstanceAdmin: false,
    isOrgAdmin: true,
  };
  expect(await canManageOrg(bindings.DB, ghost, ORG)).toBe(true);
});

it("repairs a non-active fixture membership on bootstrap", async () => {
  const stamp = new Date().toISOString();
  await bindings.DB.prepare("INSERT INTO organizations(id,name) VALUES (?,?)").bind(ORG, "repair").run();
  await bindings.DB.prepare("INSERT INTO users(user_id,status,created_at) VALUES (?,'active',?)")
    .bind("repair@example.com", stamp)
    .run();
  await bindings.DB.prepare(
    "INSERT INTO org_memberships(org_id,user_id,role,status,kind,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
  )
    .bind(ORG, "repair@example.com", "member", "invited", "ordinary", stamp, stamp)
    .run();
  await ensureLabFixture(bindings.DB, ORG, "repair@example.com");
  const row = await bindings.DB.prepare("SELECT status, role FROM org_memberships WHERE org_id=? AND user_id=?")
    .bind(ORG, "repair@example.com")
    .first<{ status: string; role: string }>();
  expect(row).toMatchObject({ status: "active", role: "admin" });
});

it("skips fixture bootstrap writes when the org or user is disabled", async () => {
  const stamp = new Date().toISOString();
  await bindings.DB.prepare("DELETE FROM org_memberships").run();
  await bindings.DB.prepare("DELETE FROM organizations").run();
  await bindings.DB.prepare(
    "INSERT INTO organizations(id,name,status,created_at,disabled_at) VALUES (?,?,'disabled',?,?)",
  )
    .bind(ORG, "locked", stamp, stamp)
    .run();
  await ensureLabFixture(bindings.DB, ORG, ADMIN);
  const users = await bindings.DB.prepare("SELECT COUNT(*) AS n FROM users").first<{ n: number }>();
  expect(users?.n ?? 0).toBe(0);
  await bindings.DB.prepare("UPDATE organizations SET status='active',disabled_at=NULL WHERE id=?").bind(ORG).run();
  await bindings.DB.prepare("INSERT INTO users(user_id,status,created_at) VALUES (?,'disabled',?)")
    .bind(ADMIN, stamp)
    .run();
  await ensureLabFixture(bindings.DB, ORG, ADMIN);
  expect(await bindings.DB.prepare("SELECT COUNT(*) AS n FROM org_memberships").first<{ n: number }>()).toMatchObject({
    n: 0,
  });
});

it("parses org names and rejects oversized names at the boundary", () => {
  expect(parseOrgName(` ${"x".repeat(128)} `)).toHaveLength(128);
  expect(() => parseOrgName(` ${"y".repeat(129)} `)).toThrow(expect.objectContaining({ code: "INVALID_ORG_NAME" }));
});

it("rejects empty multi-status lists without matching everything", () => {
  expect(() => parseHistoryQuery(new URLSearchParams("status="))).toThrow(
    expect.objectContaining({ code: "INVALID_STATUS" }),
  );
  expect(() => parseHistoryQuery(new URLSearchParams("status=Failed,"))).toThrow(
    expect.objectContaining({ code: "INVALID_STATUS" }),
  );
});

it("accepts plain-day end dates and rejects inverted day ranges", () => {
  const day = parseHistoryQuery(new URLSearchParams("startDate=2026-09-01&endDate=2026-09-10"));
  expect(day.endBefore).toBe("2026-09-11T00:00:00.000Z");
  const exact = parseHistoryQuery(
    new URLSearchParams("startDate=2026-09-09T00:00:00.000Z&endDate=2026-09-10T00:00:00.000Z"),
  );
  expect(exact.endBefore).toBe("2026-09-10T00:00:00.000Z");
  expect(() => parseHistoryQuery(new URLSearchParams("startDate=2026-09-10&endDate=2026-09-01"))).toThrow(
    expect.objectContaining({ code: "INVALID_DATE_RANGE" }),
  );
});

it("rejects non-object lockfiles without touching dependency branches", () => {
  expect(validateLockfile({ packageJson: [], lockPresent: true }).ok).toBe(false);
  expect(validateLockfile({ packageJson: "nope", lockPresent: true }).problems.join(" ")).toMatch(/package\.json/);
});

it("flags default-arg catalog entries with non-string tags", () => {
  expect(() => parseSagaCatalog({ sagas: [{ id: "x", name: "y", revision: "r", description: "d" }] })).toThrow(
    /unexpected shape/,
  );
});

it("accepts a display name at the 255-char boundary and rejects the 256-char overflow", () => {
  const base = {
    slug: "boundary",
    workflows: [{ id: WORKFLOW_UUID, name: "w", path: "w.py", functionName: "main" }],
  };
  expect(convertWorkspaceToBundle({ ...base, name: "n".repeat(255) }, bridgeOpts()).manifest.bundle.name).toBe(
    "boundary",
  );
  expect(() => convertWorkspaceToBundle({ ...base, name: "n".repeat(256) }, bridgeOpts())).toThrow(
    expect.objectContaining({ code: "INVALID_WORKSPACE" }),
  );
});

it("handles repeated integration bindings plus zero-count and unknown entity gaps", () => {
  const result = convertWorkspaceToBundle(
    {
      slug: "repeat",
      name: "Repeat",
      workflows: [{ id: WORKFLOW_UUID, name: "w", path: "w.py", functionName: "main" }],
      connections: [{ integrationName: "echo" }, { integrationName: "echo" }],
      extraEntities: { tables: 0, widgets: 2, forms: -1 },
    },
    bridgeOpts(),
  );
  expect(result.manifest.integrations[0]?.connections).toHaveLength(2);
  expect(result.gaps.map((gap) => gap.reason)).toEqual(["UNSUPPORTED_ENTITY"]);
});

it("converts an omitted secretsRequired through the default list arm", () => {
  const opts = {
    bundleId: BUNDLE_ID,
    sagas: { [WORKFLOW_UUID]: { id: echoSaga.id, revision: echoSaga.revision } },
    integrations: {
      echo: { id: ECHO_INTEGRATION_ID, org: "default", endpoint: ECHO_ENDPOINT },
    },
  };
  const result = convertWorkspaceToBundle(
    {
      slug: "defaults",
      name: "Defaults",
      workflows: [{ id: WORKFLOW_UUID, name: "w", path: "w.py", functionName: "main" }],
      connections: [{ integrationName: "echo" }],
    },
    opts,
  );
  expect(result.manifest.integrations[0]?.connections[0]?.secretsRequired).toEqual([]);
});
