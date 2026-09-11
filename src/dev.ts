// SPDX-License-Identifier: AGPL-3.0
// DEV-02 (issue #141): no-registration local Saga preview, source
// sync/conflict handling, Git target selection, dependency lock/build
// validation, and the Python-dependency compatibility inventory.
//
// Design (ADR 016): preview is read-only by construction. previewLocal runs
// the authoritative server parse against the static Git-owned Catalog with no
// D1 writes and no Workflow dispatch; the opt-in environment section only
// SELECTs Connection presence for the caller's own Organization. Sync, Git,
// lock, and deploy checks are pure offline functions over snapshots the
// caller supplies — Git, npm, and wrangler stay the transports, never a
// hosted Git/package service and never arbitrary runtime shell execution in
// a Worker. Arbitrary upstream Python execution is an explicit blocker.
import { Fault, UUID } from "./domain";
import type { CatalogEntry } from "./saga";

// --- No-registration local preview -------------------------------------------

export interface PreviewEnvEntry {
  readonly integrationId: string;
  readonly configured: boolean;
  readonly detail: string;
}

export interface PreviewSagaMeta {
  readonly id: string;
  readonly name: string;
  readonly revision: string;
  readonly description: string;
}

export interface PreviewResult {
  readonly saga: PreviewSagaMeta;
  /** The authoritatively parsed input (server parse stays authoritative). */
  readonly input: unknown;
  /** True only when the caller explicitly opted into the environment check. */
  readonly environmentChecked: boolean;
  readonly environment: readonly PreviewEnvEntry[];
  /** Structural proof of read-only preview: never persisted, never dispatched. */
  readonly persisted: false;
  readonly dispatched: false;
}

/** Parse and shape one preview request against the static Catalog. Pure:
// no D1, no Workflow, no vendor fetch. Throws Fault INVALID_SUBMISSION,
// UNKNOWN_SAGA, or INVALID_INPUT (via the Saga parse function). */
export function previewLocal(
  catalog: readonly CatalogEntry[],
  parsers: ReadonlyMap<string, (value: unknown) => unknown>,
  sagaId: unknown,
  input: unknown,
): { meta: PreviewSagaMeta; parsed: unknown; requiredIntegrations: readonly string[] } {
  if (typeof sagaId !== "string" || !UUID.test(sagaId)) {
    throw new Fault(400, "INVALID_SUBMISSION", "Preview needs a stable Saga UUID and its input only.");
  }
  const entry = catalog.find((candidate) => candidate.id.toLowerCase() === sagaId.toLowerCase());
  if (!entry) throw new Fault(400, "UNKNOWN_SAGA", "No Saga with that stable id in the Catalog.");
  const parse = parsers.get(entry.id);
  if (!parse) throw new Fault(400, "UNKNOWN_SAGA", "No Saga with that stable id in the Catalog.");
  let parsed: unknown;
  try {
    parsed = parse(input);
  } catch (error) {
    if (error instanceof Fault) throw error;
    throw new Fault(400, "INVALID_INPUT", "The preview input failed Saga validation.");
  }
  return {
    meta: { id: entry.id, name: entry.name, revision: entry.revision, description: entry.description },
    parsed,
    requiredIntegrations: entry.requiredIntegrations,
  };
}

/** Read-only environment check: one SELECT per declared Integration for the
 * caller's own Organization. Missing rows are reported, never fabricated;
 * secret values are never selected or returned. */
export async function previewEnvironment(
  db: D1Database,
  orgId: string,
  requiredIntegrations: readonly string[],
): Promise<readonly PreviewEnvEntry[]> {
  const entries: PreviewEnvEntry[] = [];
  for (const integrationId of requiredIntegrations) {
    const row = await db
      .prepare("SELECT id FROM connections WHERE org_id = ? AND integration_id = ?")
      .bind(orgId, integrationId)
      .first<{ id: string }>();
    entries.push(
      row
        ? {
            integrationId,
            configured: true,
            detail: "A Connection is configured for this Organization.",
          }
        : {
            integrationId,
            configured: false,
            detail: "No Connection for this Organization; submit would fail 424.",
          },
    );
  }
  return Object.freeze(entries);
}

// --- Stable identity across edits --------------------------------------------

export interface RemapRecord {
  readonly fromId: string;
  readonly toId: string;
  readonly reason: string;
}

/** Ordinary source edits keep the stable UUID. A changed id mints a
 * DIFFERENT Saga (ADR 002): callers must supply an explicit remap record. */
export function checkStableIdentity(previousId: string, nextId: string): { readonly same: true } {
  if (previousId.toLowerCase() !== nextId.toLowerCase()) {
    throw new Fault(
      409,
      "STABLE_IDENTITY_REMAP_REQUIRED",
      "The Saga id changed: ordinary edits keep it. Record an explicit remap (remapIdentity) or keep the previous id.",
    );
  }
  return { same: true as const };
}

/** Explicit remap for a move/rename: both ids are stable UUIDs and the
 * reason is 1-280 chars of operator justification. */
export function remapIdentity(fromId: string, toId: string, reason: string): RemapRecord {
  if (!UUID.test(fromId) || !UUID.test(toId)) {
    throw new Fault(400, "STABLE_IDENTITY_REMAP_REQUIRED", "A remap needs two stable Saga UUIDs.");
  }
  if (fromId.toLowerCase() === toId.toLowerCase()) {
    throw new Fault(400, "STABLE_IDENTITY_REMAP_REQUIRED", "A remap needs two different Saga ids.");
  }
  if (typeof reason !== "string" || reason.length === 0 || reason.length > 280) {
    throw new Fault(400, "STABLE_IDENTITY_REMAP_REQUIRED", "A remap needs 1-280 chars of justification.");
  }
  return Object.freeze({ fromId, toId, reason });
}

// --- Source pull/push/watch conflict handling --------------------------------

export interface SourceSnapshot {
  readonly sagaId: string;
  readonly revision: string;
  readonly contentHash: string;
}

export type SyncPlan =
  | { readonly action: "up-to-date" }
  | { readonly action: "push"; readonly detail: string }
  | { readonly action: "pull"; readonly detail: string }
  | { readonly action: "conflict"; readonly detail: string };

function sameSnapshot(a: SourceSnapshot, b: SourceSnapshot): boolean {
  return a.revision === b.revision && a.contentHash === b.contentHash;
}

/** Three-way sync plan over content snapshots. Identity is compared first:
 * different Saga ids are different Sagas, never an auto-merge. Diverged
 * edits are an explicit conflict — never silently merged, never pushed over.
 * `base` is the last synced snapshot; null base with both sides present is
 * a conflict unless the sides already agree. */
export function planSync(local: SourceSnapshot, remote: SourceSnapshot | null, base: SourceSnapshot | null): SyncPlan {
  if (local.sagaId.toLowerCase() !== (remote?.sagaId ?? local.sagaId).toLowerCase()) {
    throw new Fault(409, "SYNC_CONFLICT", "Local and remote snapshots name different Saga ids; remap explicitly.");
  }
  if (remote === null) return { action: "push", detail: "Remote has no snapshot; push the local source." };
  if (sameSnapshot(local, remote)) return { action: "up-to-date" };
  if (base !== null) {
    if (sameSnapshot(base, remote)) {
      return { action: "push", detail: "Remote is unchanged since the last sync; push the local edit." };
    }
    if (sameSnapshot(base, local)) {
      return { action: "pull", detail: "Local is unchanged since the last sync; pull the remote edit." };
    }
  }
  return {
    action: "conflict",
    detail:
      "Both sides changed since the last sync (or no common base exists). Resolve explicitly: keep one side, then sync again. Nothing was pushed or pulled.",
  };
}

/** Watch is a poll loop around planSync: any non-clean plan halts the loop
 * for an operator decision. There is no auto-merge and no silent push. */
export function nextWatchAction(plan: SyncPlan): "idle" | "push" | "pull" | "halt" {
  switch (plan.action) {
    case "up-to-date":
      return "idle";
    case "push":
      return "push";
    case "pull":
      return "pull";
    case "conflict":
      return "halt";
  }
}

/** FNV-1a 32-bit content hash for change detection (not security): cheap,
 * synchronous, and stable across checkouts for identical source text. */
export function contentHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i) as number;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

// --- Git authentication and branch selection ---------------------------------

export interface GitTarget {
  /** Remote URL. Echoed back in errors (not a secret). */
  readonly remoteUrl: string;
  readonly branch: string;
  /** Environment variable naming the token. The token value never appears in
   * source, errors, or logs — only this name travels. */
  readonly authEnvVar: string;
}

const GIT_BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
/** Token material travels by environment reference only, never inline. */
const ENV_VAR = /^[A-Z][A-Z0-9_]{0,63}$/;
const CREDENTIAL_KEYS = ["token", "password", "secret", "auth", "key"] as const;

/** Validate a Git pull/push target. Branch selection is explicit (no
 * default-branch guessing); credentials arrive by env-var reference and any
 * inline credential key is rejected without echoing its value. */
export function parseGitTarget(value: unknown): GitTarget {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Fault(400, "INVALID_GIT_TARGET", "A Git target needs remoteUrl, branch, and authEnvVar.");
  }
  const record = value as Record<string, unknown>;
  for (const key of CREDENTIAL_KEYS) {
    if (key in record) {
      throw new Fault(
        400,
        "INVALID_GIT_TARGET",
        `A Git target must not carry inline credential material (${key}); pass authEnvVar naming the environment variable instead.`,
      );
    }
  }
  const { remoteUrl, branch, authEnvVar } = record;
  if (
    typeof remoteUrl !== "string" ||
    !(remoteUrl.startsWith("https://") || remoteUrl.startsWith("git@")) ||
    remoteUrl.length > 512
  ) {
    throw new Fault(400, "INVALID_GIT_TARGET", "remoteUrl must be an https:// or git@ remote (max 512 chars).");
  }
  if (typeof branch !== "string" || !GIT_BRANCH.test(branch)) {
    throw new Fault(400, "INVALID_GIT_TARGET", "branch must be an explicit valid Git ref (no default guessing).");
  }
  if (typeof authEnvVar !== "string" || !ENV_VAR.test(authEnvVar)) {
    throw new Fault(400, "INVALID_GIT_TARGET", "authEnvVar must name the environment variable holding the token.");
  }
  return Object.freeze({ remoteUrl, branch, authEnvVar });
}

// --- Dependency lock and build validation ------------------------------------

export interface LockCheck {
  readonly ok: boolean;
  readonly problems: readonly string[];
}

const NONPORTABLE_PREFIXES = ["git+", "github:", "http://", "https://", "file:", "link:"] as const;

function lockProblems(packageJson: Record<string, unknown>): string[] {
  const problems: string[] = [];
  for (const section of ["dependencies", "devDependencies"] as const) {
    const deps = packageJson[section];
    if (deps === undefined) continue;
    if (deps === null || typeof deps !== "object" || Array.isArray(deps)) {
      problems.push(`${section} must be an object of pinned versions.`);
      continue;
    }
    for (const [name, spec] of Object.entries(deps as Record<string, unknown>)) {
      if (typeof spec !== "string") {
        problems.push(`${section}.${name} must be a version string.`);
        continue;
      }
      if (spec === "*" || spec === "latest" || spec === "") {
        problems.push(`${section}.${name} is unpinned (${spec === "" ? "empty" : spec}); pin an exact version.`);
        continue;
      }
      if (NONPORTABLE_PREFIXES.some((prefix) => spec.startsWith(prefix))) {
        problems.push(
          `${section}.${name} uses a non-registry spec (${spec.split(/[:+]/)[0]}); use a registry version.`,
        );
        continue;
      }
      if (/^[\^~]/.test(spec) || /[<>=|&*x]/.test(spec)) {
        problems.push(`${section}.${name} uses a range (${spec}); pin an exact version.`);
      }
    }
  }
  return problems;
}

/** Validate the dependency closure before any build: exact pinned versions,
 * a lockfile present, and no private-registry indirection. Package
 * installation happens in CI or local npm — validateDeploy rejects any
 * Worker-runtime build venue. */
export function validateLockfile(input: {
  packageJson: unknown;
  lockPresent: boolean;
  registryUrl?: string;
}): LockCheck {
  const problems: string[] = [];
  if (input.packageJson === null || typeof input.packageJson !== "object" || Array.isArray(input.packageJson)) {
    return { ok: false, problems: Object.freeze(["package.json must be an object."]) };
  }
  problems.push(...lockProblems(input.packageJson as Record<string, unknown>));
  if (!input.lockPresent) problems.push("No lockfile present; npm ci has nothing reproducible to install.");
  if (
    typeof input.registryUrl === "string" &&
    input.registryUrl.length > 0 &&
    !/^https:\/\/registry\.npmjs\.org\/?$/.test(input.registryUrl)
  ) {
    problems.push(
      "A non-default registry is configured: private registries are an explicit blocker (see docs/dev-compatibility.md).",
    );
  }
  return { ok: problems.length === 0, problems: Object.freeze(problems) };
}

// --- Python-dependency compatibility inventory -------------------------------

export type CompatDisposition = "supported" | "http-alternative" | "blocker";

export interface CompatRow {
  readonly category: string;
  readonly examples: readonly string[];
  readonly disposition: CompatDisposition;
  readonly path: string;
}

/** Compatibility inventory for upstream Python dependencies. Every row names
 * a supported TypeScript replacement, a bounded HTTP alternative, or an
 * explicit blocker. Arbitrary upstream Python execution is always a
 * blocker: it is outside the accepted architecture, never a queued TODO. */
export const DEV_COMPATIBILITY: readonly CompatRow[] = Object.freeze([
  {
    category: "python-only-package",
    examples: Object.freeze(["pandas", "numpy", "pydantic", "httpx", "jinja2"]),
    disposition: "supported",
    path: "Re-author the transform as typed TypeScript in the Saga or a shared module; validate inputs with the Saga parse function. Do not shell out to Python.",
  },
  {
    category: "native-extension",
    examples: Object.freeze(["numpy native wheels", "Pillow", "lxml", "cryptography bindings"]),
    disposition: "blocker",
    path: "Native binaries cannot run on Workers. Redesign around a bounded vendor HTTP call or drop the dependency; record the decision in the Saga.",
  },
  {
    category: "process-execution",
    examples: Object.freeze(["subprocess", "multiprocessing", "os.system", "worker process pools"]),
    disposition: "blocker",
    path: "Arbitrary process execution is outside the accepted architecture. Use Workflow step.do Operations for durable work and Queue/Cron only when a concrete requirement earns them via ADR.",
  },
  {
    category: "filesystem-access",
    examples: Object.freeze(["open()/pathlib reads", "tempfile", "local disk caches"]),
    disposition: "http-alternative",
    path: "Workers have no local disk. Keep small state in D1 rows; managed files belong to FILE-01 (R2) when that issue lands. Until then, bounded inline payloads only.",
  },
  {
    category: "private-registry",
    examples: Object.freeze(["private PyPI indexes", "private npm registries", "git+ssh dependencies"]),
    disposition: "blocker",
    path: "Private registries break reproducible CI installs and are an explicit blocker: vendor the source under an AGPL-compatible license or use the public registry.",
  },
  {
    category: "bounded-http-vendor",
    examples: Object.freeze(["requests/httpx vendor calls", "webhook delivery", "OAuth token fetch"]),
    disposition: "http-alternative",
    path: "Call the vendor over bounded fetch from an Integration Action with an explicit deadline and a typed error envelope (see src/integrations/). Never expose raw vendor bytes to callers.",
  },
]);

/** Classify one dependency specifier. Unknown specifiers are blockers
 * pending explicit review — never silently supported. */
export function classifyDependency(spec: string): CompatRow {
  const lowered = spec.toLowerCase();
  for (const row of DEV_COMPATIBILITY) {
    if (row.examples.some((example) => lowered.includes(example.toLowerCase().split(" ")[0] as string))) {
      return row;
    }
  }
  if (/\.py$|python|pip|subprocess|multiprocessing|os\.system|fork|exec\(/.test(lowered)) {
    return DEV_COMPATIBILITY.find((row) => row.category === "process-execution") as CompatRow;
  }
  return {
    category: "unclassified",
    examples: Object.freeze([spec]),
    disposition: "blocker",
    path: "Unclassified dependency: explicit review required before any build may include it.",
  };
}

// --- Deployment validation ---------------------------------------------------

export type DeployEnvironment = "local" | "dev" | "preview";
export type BuildVenue = "github-actions" | "local-npm";

const DEPLOY_ENVIRONMENTS: readonly string[] = ["local", "dev", "preview"];
const BUILD_VENUES: readonly string[] = ["github-actions", "local-npm"];

/** Validate a deployment before it happens. Production is intentionally
 * unconfigured (ADR 004): naming it fails closed. Package installation and
 * builds run in CI or local npm — a Worker-runtime venue is rejected, so no
 * deployment can smuggle arbitrary shell execution into the Worker. */
export function validateDeploy(input: {
  environment: string;
  buildVenue: string;
  lock: LockCheck;
  sagaIds: readonly string[];
}): { readonly ok: true; readonly environment: DeployEnvironment; readonly buildVenue: BuildVenue } {
  if (!DEPLOY_ENVIRONMENTS.includes(input.environment)) {
    if (input.environment === "production") {
      throw new Fault(
        409,
        "DEPLOY_BLOCKED",
        "Production is intentionally unconfigured (ADR 004). Deploy to local, dev, or preview only.",
      );
    }
    throw new Fault(409, "DEPLOY_BLOCKED", "Deploy to local, dev, or preview only.");
  }
  if (!BUILD_VENUES.includes(input.buildVenue)) {
    throw new Fault(
      409,
      "DEPLOY_BLOCKED",
      "Package installation and builds run in CI (github-actions) or local npm only — never in a Worker runtime.",
    );
  }
  if (!input.lock.ok) {
    throw new Fault(409, "DEPLOY_BLOCKED", `Dependency lock is not reproducible: ${input.lock.problems.join("; ")}`);
  }
  if (input.sagaIds.length === 0 || input.sagaIds.some((id) => !UUID.test(id))) {
    throw new Fault(409, "DEPLOY_BLOCKED", "A deployment names at least one stable Saga UUID.");
  }
  return Object.freeze({
    ok: true as const,
    environment: input.environment as DeployEnvironment,
    buildVenue: input.buildVenue as BuildVenue,
  });
}
