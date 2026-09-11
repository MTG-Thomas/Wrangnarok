// SPDX-License-Identifier: AGPL-3.0
// Solutions install (ADR 011, Accepted): manifest-driven install with
// owned/loose enforcement.
//
// A bundle is one JSON manifest plus the Git tree it points at. installBundle
// validates the manifest, runs preflight (catalog resolution, revision pins,
// secret-schema membership, secret availability, ownership, downgrade) before
// the first write, then reconciles each declared Connection row
// independently: INSERT missing managed rows, UPDATE drifted managed rows,
// never touch executions/operations/usage_blocks or managed_by-NULL rows.
// Re-running converges instead of forking (deterministic Connection IDs,
// idempotent per-row ops), so an interrupted activation restarts safely.
//
// Owned vs loose: connections rows carry managed_by = <bundle_id>@<version>.
// The installer below is the sole writer of managed rows. Ordinary
// application paths must go through updateConnectionEndpoint, which rejects
// managed-row writes with MANAGED_RESOURCE.
//
// This module imports only node-safe dependencies (domain, integrations
// index): src/sagas/index pulls the cloudflare:workers/workflow runtime, so
// the local runner (scripts/install-local.mjs, plain node) could not bundle
// it. The saga pins below reuse the same domain constants the Saga
// definitions are built from; test/solutions-install.test.ts asserts they
// stay in agreement with the static code Catalog.
import { digestSaga, echoSaga, Fault, hash, helloSaga, ninjaSaga, object, smokeSaga, UUID } from "./domain";
import { integrationById } from "./integrations";
import { scrubTextWithSecrets } from "./secrets";

interface CatalogSaga {
  readonly id: string;
  readonly name: string;
  readonly revision: string;
}

/** Static code Catalog as seen by the installer: the same stable IDs and
 * revision pins the Saga definitions are built from (ADR 002). */
const CODE_SAGAS: readonly CatalogSaga[] = [echoSaga, ninjaSaga, digestSaga, smokeSaga, helloSaga];

export interface ManifestSagaPin {
  readonly id: string;
  readonly revision: string;
}

export interface ManifestConnection {
  readonly org: string;
  readonly config: Readonly<Record<string, string>>;
  readonly secretsRequired: readonly string[];
}

export interface ManifestIntegration {
  readonly id: string;
  readonly connections: readonly ManifestConnection[];
}

export interface ManifestConfigEntry {
  readonly key: string;
  readonly value: string;
}

/** Validated bundle manifest (ADR 011 section 1, v1 slice). Manifests carry
 * declarations only: secretsRequired names, never credential values. */
export interface BundleManifest {
  readonly manifestVersion: 1;
  readonly bundle: { readonly id: string; readonly name: string; readonly version: string };
  readonly sagas: readonly ManifestSagaPin[];
  readonly integrations: readonly ManifestIntegration[];
  readonly config: readonly ManifestConfigEntry[];
}

export interface InstallOptions {
  /** Secret values keyed by secretsRequired name, resolved by the caller
   * from env/Secrets Store per ADR 005. Only presence is checked here;
   * values are never persisted, logged, or returned. */
  readonly secrets?: Readonly<Record<string, string>>;
  /** Downgrades (older bundle version over a newer install record) refuse
   * without this flag. Rollback = reinstalling the older manifest with
   * force: true through the same path. */
  readonly force?: boolean;
  /** Plan only: run validation and preflight, return the drift report,
   * write nothing. */
  readonly dryRun?: boolean;
  /** Scope reconciliation to one manifest org name (used by the local
   * runner). Unset installs every declared org. */
  readonly orgName?: string;
}

export interface DriftReport {
  readonly created: number;
  readonly updated: number;
  readonly skipped: number;
}

export interface InstallResult {
  readonly bundleId: string;
  readonly version: string;
  readonly manifestHash: string;
  readonly orgIds: readonly string[];
  readonly drift: DriftReport;
  readonly dryRun: boolean;
}

const BUNDLE_NAME = /^[a-z0-9][a-z0-9.-]*$/i;
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
/** Manifests must never carry credential values (ADR 011 structural
 * exclusion): any config key shaped like a credential fails validation. */
const CREDENTIAL_KEY =
  /(secret|token|password|passwd|credential|api[_-]?key|private[_-]?key|access[_-]?key|client[_-]?secret|auth)/i;

function invalid(code: string, message: string, status = 400): Fault {
  return new Fault(status, code, message);
}

/** Hand-rolled manifest validator, mirroring the src/saga.ts validation
 * style: explicit checks, descriptive errors, no new dependencies. Throws
 * Faults with machine-readable codes; writes nothing. */
export function parseBundleManifest(value: unknown): BundleManifest {
  if (!object(value)) throw invalid("INVALID_MANIFEST", "The bundle manifest must be a JSON object.");
  if (value.manifestVersion !== 1) {
    throw invalid("INVALID_MANIFEST", "The bundle manifest manifestVersion must be 1.");
  }
  const bundle = value.bundle;
  if (!object(bundle) || typeof bundle.id !== "string" || !UUID.test(bundle.id)) {
    throw invalid("INVALID_MANIFEST", "The bundle manifest bundle.id must be a stable UUID.");
  }
  if (!object(bundle) || typeof bundle.name !== "string" || !BUNDLE_NAME.test(bundle.name)) {
    throw invalid("INVALID_MANIFEST", "The bundle manifest bundle.name must be a simple slug.");
  }
  if (!object(bundle) || typeof bundle.version !== "string" || !SEMVER.test(bundle.version)) {
    throw invalid("INVALID_MANIFEST", "The bundle manifest bundle.version must be major.minor.patch.");
  }
  const sagas = value.sagas;
  if (!Array.isArray(sagas) || sagas.length === 0) {
    throw invalid("INVALID_MANIFEST", "The bundle manifest must declare at least one saga.");
  }
  const pins: ManifestSagaPin[] = sagas.map((entry: unknown) => {
    if (!object(entry) || typeof entry.id !== "string" || !UUID.test(entry.id)) {
      throw invalid("INVALID_MANIFEST", "Every manifest saga id must be a stable Saga UUID.");
    }
    // ADR 011 section 6 / ADR 010 open question (deliberately unresolved in
    // v1): the manifest pins saga revisions while Saga source declares
    // requiredIntegrations, and the two must agree. Which side is
    // authoritative when they disagree is Phase 3+; v1 only fails closed on
    // revision mismatch and never rewrites requirements.
    const catalog = CODE_SAGAS.find((saga) => saga.id === entry.id);
    if (!catalog) throw invalid("UNKNOWN_SAGA", `Unknown saga id ${entry.id}: not in the static code catalog.`);
    if (typeof entry.revision !== "string" || entry.revision !== catalog.revision) {
      throw invalid(
        "REVISION_MISMATCH",
        `Saga "${catalog.name}" pins revision "${entry.revision}" but deployed code is "${catalog.revision}".`,
        409,
      );
    }
    return { id: entry.id, revision: entry.revision };
  });
  const integrations = value.integrations;
  if (!Array.isArray(integrations)) {
    throw invalid("INVALID_MANIFEST", "The bundle manifest integrations must be a list.");
  }
  const declared: ManifestIntegration[] = integrations.map((entry: unknown) => {
    if (!object(entry) || typeof entry.id !== "string" || !UUID.test(entry.id)) {
      throw invalid("INVALID_MANIFEST", "Every manifest integration id must be a stable Integration UUID.");
    }
    const def = integrationById(entry.id);
    if (!def) {
      throw invalid("UNKNOWN_INTEGRATION", `Unknown integration id ${entry.id}: not in the static code catalog.`);
    }
    if (!Array.isArray(entry.connections) || entry.connections.length === 0) {
      throw invalid("INVALID_MANIFEST", `Integration "${def.name}" must declare at least one connection when listed.`);
    }
    const connections: ManifestConnection[] = entry.connections.map((conn: unknown) => {
      if (!object(conn) || typeof conn.org !== "string" || conn.org.length === 0 || conn.org.length > 128) {
        throw invalid("INVALID_MANIFEST", "Every manifest connection needs an org name of 1-128 chars.");
      }
      if (!object(conn.config)) {
        throw invalid("INVALID_MANIFEST", "Every manifest connection needs a config object.");
      }
      const config: Record<string, string> = {};
      for (const [key, val] of Object.entries(conn.config)) {
        if (CREDENTIAL_KEY.test(key)) {
          throw invalid(
            "CREDENTIAL_IN_MANIFEST",
            `Manifest connection config key "${key}" looks like a credential: manifests carry secretsRequired names only, never values.`,
          );
        }
        if (typeof val !== "string" || val.length === 0) {
          throw invalid("INVALID_MANIFEST", `Manifest connection config "${key}" must be a non-empty string.`);
        }
        config[key] = val;
      }
      if (typeof config.endpoint !== "string") {
        throw invalid("INVALID_MANIFEST", "Every manifest connection config needs a non-secret endpoint string.");
      }
      if (!Array.isArray(conn.secretsRequired) || conn.secretsRequired.some((n) => typeof n !== "string")) {
        throw invalid("INVALID_MANIFEST", "Every manifest connection needs an explicit secretsRequired string list.");
      }
      for (const name of conn.secretsRequired as string[]) {
        if (!def.secretFields.includes(name)) {
          throw invalid(
            "SECRET_SCHEMA_MISMATCH",
            `Secret "${name}" is not in the "${def.name}" Integration secret schema (${def.secretFields.join(", ") || "none"}).`,
          );
        }
      }
      return { org: conn.org, config, secretsRequired: Object.freeze([...(conn.secretsRequired as string[])]) };
    });
    return { id: entry.id, connections: Object.freeze(connections) };
  });
  const config = value.config;
  if (!Array.isArray(config)) {
    throw invalid("INVALID_MANIFEST", "The bundle manifest config must be a list.");
  }
  const entries: ManifestConfigEntry[] = config.map((entry: unknown) => {
    if (!object(entry) || typeof entry.key !== "string" || entry.key.length === 0) {
      throw invalid("INVALID_MANIFEST", "Every manifest config entry needs a non-empty key.");
    }
    if (typeof entry.value !== "string") {
      throw invalid("INVALID_MANIFEST", `Manifest config "${entry.key}" must carry a string value.`);
    }
    if (CREDENTIAL_KEY.test(entry.key)) {
      throw invalid(
        "CREDENTIAL_IN_MANIFEST",
        `Manifest config key "${entry.key}" looks like a credential: manifests never carry values for secrets.`,
      );
    }
    return { key: entry.key, value: entry.value };
  });
  return Object.freeze({
    manifestVersion: 1 as const,
    bundle: Object.freeze({ id: bundle.id as string, name: bundle.name as string, version: bundle.version as string }),
    sagas: Object.freeze(pins),
    integrations: Object.freeze(declared),
    config: Object.freeze(entries),
  });
}

/** Numeric major.minor.patch compare with a boring prerelease rule (release
 * beats prerelease, prereleases compare lexically). Returns -1, 0, or 1. */
export function compareVersions(a: string, b: string): number {
  const split = (v: string): { core: number[]; pre: string | null } => {
    const dash = v.indexOf("-");
    const core = (dash === -1 ? v : v.slice(0, dash)).split(".").map((n) => {
      const parsed = Number(n);
      return Number.isFinite(parsed) ? parsed : 0;
    });
    return { core, pre: dash === -1 ? null : v.slice(dash + 1) };
  };
  const left = split(a);
  const right = split(b);
  for (let i = 0; i < 3; i++) {
    const l = left.core[i] ?? 0;
    const r = right.core[i] ?? 0;
    if (l !== r) return l < r ? -1 : 1;
  }
  if (left.pre === right.pre) return 0;
  if (left.pre === null) return 1;
  if (right.pre === null) return -1;
  return left.pre < right.pre ? -1 : 1;
}

function managedBy(bundleId: string, version: string): string {
  return `${bundleId}@${version}`;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Deterministic managed Connection identity (ADR 011 section 3): derived
 * from install + manifest identity so reinstalls converge instead of
 * forking duplicates. */
async function managedConnectionId(bundleId: string, orgId: string, integrationId: string): Promise<string> {
  const hex = await hash(JSON.stringify(["wrangnarok.connection.v1", bundleId, orgId, integrationId]));
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

interface DesiredConnection {
  readonly integrationId: string;
  readonly org: string;
  readonly endpoint: string;
  readonly secretsRequired: readonly string[];
}

interface PlannedConnection extends DesiredConnection {
  readonly orgId: string | null;
  readonly action: "create" | "update" | "skip";
  /** Previously persisted managed_by marker, for the fenced reconcile write. */
  readonly expectedManagedBy: string | null;
}

/**
 * Manifest-driven install with owned/loose enforcement (ADR 011 v1 slice):
 * validate, run every preflight check before the first write, then
 * reconcile each declared Connection row independently and append one
 * immutable install record per Organization. Returns a drift report.
 */
export async function installBundle(db: D1Database, raw: unknown, opts: InstallOptions = {}): Promise<InstallResult> {
  const manifest = parseBundleManifest(raw);
  const secrets = opts.secrets ?? {};
  const bundleId = manifest.bundle.id;
  const version = manifest.bundle.version;

  const desired: DesiredConnection[] = [];
  for (const integration of manifest.integrations) {
    for (const conn of integration.connections) {
      if (opts.orgName !== undefined && conn.org !== opts.orgName) continue;
      desired.push({
        integrationId: integration.id,
        org: conn.org,
        endpoint: conn.config.endpoint as string,
        secretsRequired: conn.secretsRequired,
      });
    }
  }
  if (opts.orgName !== undefined && desired.length === 0) {
    throw invalid("ORG_NOT_DECLARED", `Org "${opts.orgName}" declares no connections in this manifest.`);
  }

  // Preflight: every secretsRequired name has a value available (env/Secrets
  // Store). Values are presence-checked only — never persisted, logged, or
  // returned (First-Acorn-must-not per ADR 005).
  for (const conn of desired) {
    for (const name of conn.secretsRequired) {
      if (typeof secrets[name] !== "string" || (secrets[name] as string).length === 0) {
        throw invalid(
          "SECRET_NOT_CONFIGURED",
          `Secret "${name}" is required by this manifest but has no value available: refusing a half-credentialed install.`,
        );
      }
    }
  }

  // Preflight reads (no writes yet): resolve org rows, latest install
  // records, and current Connection ownership.
  const orgNames = [...new Set(desired.map((conn) => conn.org))];
  const orgIds = new Map<string, string>();
  for (const name of orgNames) {
    const row = await db.prepare("SELECT id FROM organizations WHERE name = ?").bind(name).first<{ id: string }>();
    if (row) orgIds.set(name, row.id);
  }
  const plan: PlannedConnection[] = [];
  for (const conn of desired) {
    const orgId = orgIds.get(conn.org) ?? null;
    if (orgId === null) {
      plan.push({ ...conn, orgId: null, action: "create", expectedManagedBy: null });
      continue;
    }
    const latest = await db
      .prepare(
        "SELECT version FROM bundle_installs WHERE bundle_id = ? AND org_id = ? ORDER BY installed_at DESC, id DESC LIMIT 1",
      )
      .bind(bundleId, orgId)
      .first<{ version: string }>();
    if (latest && compareVersions(version, latest.version) < 0 && opts.force !== true) {
      throw invalid(
        "DOWNGRADE_REFUSED",
        `Bundle version ${version} is older than installed ${latest.version}: pass force to roll back.`,
        409,
      );
    }
    const current = await db
      .prepare("SELECT endpoint, managed_by FROM connections WHERE org_id = ? AND integration_id = ?")
      .bind(orgId, conn.integrationId)
      .first<{ endpoint: string; managed_by: string | null }>();
    if (!current) {
      plan.push({ ...conn, orgId, action: "create", expectedManagedBy: null });
    } else if (current.managed_by === null) {
      throw invalid(
        "INSTALL_CONFLICT",
        "A loose Connection already exists for this Organization and Integration: the installer never adopts managed_by-NULL rows.",
        409,
      );
    } else if (!current.managed_by.startsWith(`${bundleId}@`)) {
      // Portable install record: scrub caller-supplied secrets before the
      // marker text leaves (defense-in-depth; markers are IDs, not secrets).
      const marker = scrubTextWithSecrets(current.managed_by, Object.values(secrets));
      throw invalid(
        "INSTALL_CONFLICT",
        `Connection is managed by a different bundle (${marker}): hijack by reinstall is refused.`,
        409,
      );
    } else if (current.endpoint === conn.endpoint) {
      plan.push({ ...conn, orgId, action: "skip", expectedManagedBy: current.managed_by });
    } else {
      plan.push({ ...conn, orgId, action: "update", expectedManagedBy: current.managed_by });
    }
  }

  const drift: DriftReport = {
    created: plan.filter((p) => p.action === "create").length,
    updated: plan.filter((p) => p.action === "update").length,
    skipped: plan.filter((p) => p.action === "skip").length,
  };
  const manifestHash = await hash(canonical(manifest));
  if (opts.dryRun === true) {
    return { bundleId, version, manifestHash, orgIds: [...orgIds.values()], drift, dryRun: true };
  }

  // Reconcile: ensure org rows, then apply each planned row independently.
  // Restart-safe by construction — re-running converges (creates become
  // skips, updates already match).
  const installedAt = new Date().toISOString();
  for (const name of orgNames) {
    if (!orgIds.has(name)) {
      const id = crypto.randomUUID();
      await db.prepare("INSERT INTO organizations(id, name) VALUES (?, ?)").bind(id, name).run();
      orgIds.set(name, id);
    }
  }
  const marker = managedBy(bundleId, version);
  for (const item of plan) {
    const orgId = orgIds.get(item.org) as string;
    if (item.action === "create") {
      const id = await managedConnectionId(bundleId, orgId, item.integrationId);
      await db
        .prepare("INSERT INTO connections(id, org_id, integration_id, endpoint, managed_by) VALUES (?, ?, ?, ?, ?)")
        .bind(id, orgId, item.integrationId, item.endpoint, marker)
        .run();
    } else if (item.action === "update") {
      // Fenced on the preflight marker: a lost race surfaces
      // INSTALL_CONFLICT, never a silent overwrite (ADR 011 section 4).
      const applied = await db
        .prepare(
          "UPDATE connections SET endpoint = ?, managed_by = ? WHERE org_id = ? AND integration_id = ? AND managed_by = ?",
        )
        .bind(item.endpoint, marker, orgId, item.integrationId, item.expectedManagedBy)
        .run();
      if (applied.meta.changes === 0) {
        throw invalid("INSTALL_CONFLICT", "Connection changed under install: refusing silent overwrite.", 409);
      }
    }
  }
  for (const name of orgNames) {
    const orgId = orgIds.get(name) as string;
    await db
      .prepare(
        "INSERT INTO bundle_installs(bundle_id, version, org_id, manifest_hash, installed_at) VALUES (?, ?, ?, ?, ?)",
      )
      .bind(bundleId, version, orgId, manifestHash, installedAt)
      .run();
  }
  return { bundleId, version, manifestHash, orgIds: [...orgIds.values()], drift, dryRun: false };
}

/**
 * Ordinary application/API Connection write path. Managed rows reject with
 * MANAGED_RESOURCE — only the installer writes them. Loose rows
 * (managed_by NULL, created outside install) stay freely writable.
 */
export async function updateConnectionEndpoint(
  db: D1Database,
  orgId: string,
  integrationId: string,
  endpoint: string,
): Promise<void> {
  const row = await db
    .prepare("SELECT managed_by FROM connections WHERE org_id = ? AND integration_id = ?")
    .bind(orgId, integrationId)
    .first<{ managed_by: string | null }>();
  if (!row) throw invalid("CONNECTION_NOT_FOUND", "No Connection exists for this Organization and Integration.", 404);
  if (row.managed_by !== null) {
    // Marker is a bundle ID, not a secret: no secret list exists on this
    // path, so the scrub is a no-op pin keeping exports secret-free.
    throw invalid(
      "MANAGED_RESOURCE",
      `Connection is managed by bundle install ${row.managed_by}: live mutation outside install is rejected.`,
      409,
    );
  }
  await db
    .prepare("UPDATE connections SET endpoint = ? WHERE org_id = ? AND integration_id = ?")
    .bind(endpoint, orgId, integrationId)
    .run();
}
