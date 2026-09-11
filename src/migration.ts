// SPDX-License-Identifier: AGPL-3.0
// Workspace-to-bundle bridge (issue #116, MIG-01).
//
// Converts a workspace-style solution definition (`bifrost.solution.yaml`
// descriptor plus `.bifrost/*.yaml` entity manifests) into a Wrangnarok
// `solution.manifest.json` install manifest, or fails loudly with the gap.
//
// Upstream evidence (all pins at gobifrost/bifrost@3543c7e):
// - `api/bifrost/solution_descriptor.py`: descriptor carries slug/name/version
//   only; install scope is deploy-time choice, never a descriptor field.
// - `api/src/models/contracts/solutions.py`: SolutionCreate derives kind from
//   organization_id; Solution carryies slug identity plus version bookkeeping.
// - `api/src/services/solutions/zip_install.py`: workspace parsers are the CLI
//   collectors in `bifrost.commands.solution` (`_collect_workflows`,
//   `_collect_tables`, `_collect_apps`, `_collect_forms`, `_collect_agents`,
//   `_collect_claims`, `_collect_config_schemas`, `_collect_connection_schemas`,
//   `_collect_events`); deploy remaps every entity id per install via
//   `uuid5(install_id, manifest_id)`.
// - `api/bifrost/decorators.py`: decorator params are identity-only
//   (name/description/category/tags); decorator id metadata is NOT a stable
//   registered identity. Stable identity only exists after registration as a
//   Workflow row; install rows carry the per-install remapped id.
//
// Mapping contract (documented field by field):
// - slug -> bundle.name verbatim (definition identity, portable).
// - version -> bundle.version verbatim (PEP 440 free-form upstream; semver
//   enforced locally by parseBundleManifest).
// - descriptor has NO bundle UUID: the bridge caller supplies the stable
//   bundle.id explicitly, so a slug rename never silently re-identifies data.
// - workflows (`.bifrost/workflows.yaml` keyed by manifest UUID) -> sagas pins
//   [{id, revision}]. The manifest UUID is the *source* identity only: it
//   must resolve against the operator-supplied saga map (manifest UUID ->
//   registered Saga {id, revision}), because Python source is never executed
//   here and revision pins must match deployed code (REVISION_MISMATCH).
// - config declarations (`.bifrost/configs.yaml`) -> manifest config entries.
//   Declarations carry no values by design; the bridge only converts entries
//   that carry an explicit non-secret value and refuses credential-shaped
//   values with CREDENTIAL_IN_MANIFEST. Secret values are never accepted.
// - connection schemas (`.bifrost/connections.yaml`, integration_name +
//   template) -> integrations entries with org connections. Templates are
//   environment-free skeletons; endpoints and secretsRequired resolve through
//   the operator-supplied integration map (integration name -> {id, endpoint,
//   secretsRequired}), never from workspace defaults.
// - Environment exclusion: install scope (org vs global), config VALUES,
//   secrets.enc payloads, table rows, file bytes, execution state, git
//   wiring, logos, and READMEs never enter the converted manifest.
//
// Actionable unsupported-feature results: every skipped or refused workspace
// feature returns a machine-readable UNSUPPORTED_* reason naming the source
// file and the operator decision (map it, drop it, or follow up). Tables,
// forms, apps, agents, claims, events, and file policies convert to explicit
// follow-up gaps, never to silent drops.
//
// This module imports only node-safe dependencies (domain): it runs in plain
// node tests and CI without a Cloudflare binding.
import { Fault, object, UUID } from "./domain";

const SLUG = /^[a-z0-9][a-z0-9._-]*$/i;
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
/** Manifests must never carry credential values (ADR 011 structural
 * exclusion): any config key shaped like a credential fails validation. */
const CREDENTIAL_KEY =
  /(secret|token|password|passwd|credential|api[_-]?key|private[_-]?key|access[_-]?key|client[_-]?secret|auth)/i;

function invalid(code: string, message: string, status = 400): Fault {
  return new Fault(status, code, message);
}

/** One workspace workflow manifest entry (`.bifrost/workflows.yaml`). */
export interface WorkspaceWorkflowEntry {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly functionName: string;
}

/** One workspace config declaration (`.bifrost/configs.yaml`). */
export interface WorkspaceConfigEntry {
  readonly key: string;
  readonly type?: string;
  readonly required?: boolean;
  readonly description?: string;
  /** Non-secret default carried for conversion only. Absent = declaration
   * without a portable value; the bridge emits a follow-up gap, not a row. */
  readonly value?: string;
}

/** One workspace connection schema (`.bifrost/connections.yaml`). */
export interface WorkspaceConnectionSchema {
  readonly integrationName: string;
  readonly template?: string;
  readonly position?: number;
}

/** Workspace-style solution definition: descriptor plus entity manifests. */
export interface WorkspaceSolution {
  readonly slug: string;
  readonly name: string;
  readonly version?: string;
  readonly workflows?: readonly WorkspaceWorkflowEntry[];
  readonly configs?: readonly WorkspaceConfigEntry[];
  readonly connections?: readonly WorkspaceConnectionSchema[];
  /** Entity kinds the v1 manifest cannot own yet (tables/forms/apps/agents/
   * claims/events/file policies). Listed so the result can name follow-ups. */
  readonly extraEntities?: Readonly<Record<string, number>>;
}

/** Operator-supplied Saga resolution: manifest UUID -> registered Saga pin. */
export interface BridgeSagaPin {
  readonly id: string;
  readonly revision: string;
}

/** Operator-supplied Integration resolution: integration name -> install wiring. */
export interface BridgeIntegrationBinding {
  readonly id: string;
  readonly org: string;
  readonly endpoint: string;
  readonly secretsRequired?: readonly string[];
}

/** One actionable unsupported-feature result. */
export interface BridgeGap {
  /** Machine-readable reason: UNSUPPORTED_TABLES, UNSUPPORTED_FORMS,
   * UNSUPPORTED_APPS, UNSUPPORTED_AGENTS, UNSUPPORTED_CLAIMS,
   * UNSUPPORTED_EVENTS, UNSUPPORTED_FILE_POLICIES, UNMAPPED_WORKFLOW,
   * UNMAPPED_INTEGRATION, SECRET_VALUE_EXCLUDED, DECLARATION_WITHOUT_VALUE. */
  readonly reason: string;
  /** Human-actionable detail: source file plus the operator decision. */
  readonly detail: string;
}

/** Converted bundle manifest (ADR 011 v1 shape, unvalidated here). */
export interface BridgeManifest {
  readonly manifestVersion: 1;
  readonly bundle: { readonly id: string; readonly name: string; readonly version: string };
  readonly sagas: readonly { readonly id: string; readonly revision: string }[];
  readonly integrations: readonly {
    readonly id: string;
    readonly connections: readonly {
      readonly org: string;
      readonly config: Readonly<Record<string, string>>;
      readonly secretsRequired: readonly string[];
    }[];
  }[];
  readonly config: readonly { readonly key: string; readonly value: string }[];
}

export interface BridgeResult {
  readonly manifest: BridgeManifest;
  /** Follow-up gaps: present-but-unconverted workspace features. */
  readonly gaps: readonly BridgeGap[];
}

/** Documented field mapping (issue #116 exit: slug/version/functions/config/
 * secrets derivation). Kept next to the converter so docs and code cannot
 * drift: docs/migration-bridge.md links here. */
export const WORKSPACE_TO_BUNDLE_MAPPING: ReadonlyArray<{ readonly workspace: string; readonly bundle: string }> =
  Object.freeze([
    { workspace: "bifrost.solution.yaml slug", bundle: "bundle.name (verbatim definition identity)" },
    { workspace: "bifrost.solution.yaml version", bundle: "bundle.version (verbatim; semver enforced locally)" },
    { workspace: "bifrost.solution.yaml (no UUID field)", bundle: "bundle.id (operator-supplied stable UUID)" },
    { workspace: ".bifrost/workflows.yaml entry id", bundle: "source identity only; sagas[].id via sagaMap" },
    { workspace: ".bifrost/workflows.yaml entry name/path::fn", bundle: "operator sagaMap key; revision via sagaMap" },
    { workspace: ".bifrost/configs.yaml declaration", bundle: "config[] entry only when a non-secret value is given" },
    { workspace: ".bifrost/connections.yaml integration_name", bundle: "integrations[].id via integrationMap" },
    {
      workspace: "connection template skeleton",
      bundle: "config.endpoint via integrationMap; secretsRequired names only",
    },
    {
      workspace: "install scope / config values / secrets.enc / table rows / file bytes",
      bundle: "excluded (never converted)",
    },
  ]);

export interface BridgeOptions {
  /** Stable bundle UUID for the converted manifest (slug renames must never
   * silently re-identify installed data). */
  readonly bundleId: string;
  readonly sagas: Readonly<Record<string, BridgeSagaPin>>;
  readonly integrations: Readonly<Record<string, BridgeIntegrationBinding>>;
}

/**
 * Convert a workspace-style solution definition into a bundle manifest.
 * Throws Faults with machine-readable codes on malformed input or credential
 * leaks; returns gaps for present-but-unconvertible features (never silent).
 */
export function convertWorkspaceToBundle(solution: unknown, opts: BridgeOptions): BridgeResult {
  if (!object(solution)) throw invalid("INVALID_WORKSPACE", "The workspace solution must be an object.");
  const slug = solution.slug;
  if (typeof slug !== "string" || !SLUG.test(slug)) {
    throw invalid("INVALID_WORKSPACE", "The workspace descriptor slug must be a simple slug.");
  }
  const name = solution.name;
  if (typeof name !== "string" || name.length === 0 || name.length > 255) {
    throw invalid("INVALID_WORKSPACE", "The workspace descriptor needs a display name of 1-255 chars.");
  }
  const rawVersion = solution.version;
  const version = rawVersion === undefined ? "0.1.0" : rawVersion;
  if (typeof version !== "string" || !SEMVER.test(version)) {
    throw invalid("INVALID_WORKSPACE", "The workspace version must be major.minor.patch to convert.");
  }
  if (!UUID.test(opts.bundleId)) {
    throw invalid("INVALID_WORKSPACE", "The bridge bundleId must be a stable UUID supplied by the operator.");
  }
  const raw = solution as Record<string, unknown>;
  // Scope leakage fails closed: install kind is deploy-time choice upstream
  // (organization_id), never a descriptor field. A workspace that tries to
  // pin scope/org into portable source is refused, not carried.
  for (const key of ["scope", "organization_id", "organizationId", "org", "org_id"]) {
    if (key in raw) {
      throw invalid(
        "SCOPE_IN_WORKSPACE",
        `Workspace key "${key}" pins install scope into portable source: scope is a deploy-time choice, never converted.`,
      );
    }
  }
  if ("secrets" in raw || "configValues" in raw || "config_values" in raw || "secretsEnc" in raw) {
    throw invalid(
      "CREDENTIAL_IN_WORKSPACE",
      "The workspace carries secret values: manifests carry secretsRequired names only, never values.",
    );
  }

  const gaps: BridgeGap[] = [];
  const sagas: { id: string; revision: string }[] = [];
  const workflows = raw.workflows;
  if (workflows !== undefined) {
    if (!Array.isArray(workflows)) throw invalid("INVALID_WORKSPACE", "Workspace workflows must be a list.");
    for (const entry of workflows) {
      if (!object(entry) || typeof entry.id !== "string" || !UUID.test(entry.id)) {
        throw invalid("INVALID_WORKSPACE", "Every workspace workflow needs a manifest UUID id.");
      }
      const pin = opts.sagas[entry.id];
      if (!pin) {
        gaps.push({
          reason: "UNMAPPED_WORKFLOW",
          detail: `workflows.yaml ${entry.id} ("${typeof entry.name === "string" ? entry.name : "?"}") has no sagaMap entry: map the manifest UUID to a registered Saga pin or record a follow-up.`,
        });
        continue;
      }
      if (!UUID.test(pin.id) || typeof pin.revision !== "string" || pin.revision.length === 0) {
        throw invalid("INVALID_WORKSPACE", `sagaMap entry for ${entry.id} must carry a Saga UUID and revision.`);
      }
      sagas.push({ id: pin.id, revision: pin.revision });
    }
  }

  const config: { key: string; value: string }[] = [];
  const configs = raw.configs;
  if (configs !== undefined) {
    if (!Array.isArray(configs)) throw invalid("INVALID_WORKSPACE", "Workspace configs must be a list.");
    for (const entry of configs) {
      if (!object(entry) || typeof entry.key !== "string" || entry.key.length === 0) {
        throw invalid("INVALID_WORKSPACE", "Every workspace config needs a non-empty key.");
      }
      const key = entry.key;
      if (CREDENTIAL_KEY.test(key)) {
        throw invalid(
          "CREDENTIAL_IN_MANIFEST",
          `Workspace config key "${key}" looks like a credential: manifests carry secretsRequired names only, never values.`,
        );
      }
      const value = entry.value;
      if (value === undefined) {
        gaps.push({
          reason: "DECLARATION_WITHOUT_VALUE",
          detail: `configs.yaml "${key}" declares a value-less requirement: satisfy it at install time via secretsRequired/Connection config, not here.`,
        });
        continue;
      }
      if (typeof value !== "string" || value.length === 0) {
        throw invalid("INVALID_WORKSPACE", `Workspace config "${key}" must carry a non-empty string value to convert.`);
      }
      config.push({ key, value });
    }
  }

  const byIntegration = new Map<
    string,
    { id: string; connections: { org: string; config: Record<string, string>; secretsRequired: string[] }[] }
  >();
  const connections = raw.connections;
  if (connections !== undefined) {
    if (!Array.isArray(connections)) throw invalid("INVALID_WORKSPACE", "Workspace connections must be a list.");
    for (const entry of connections) {
      if (!object(entry) || typeof entry.integrationName !== "string" || entry.integrationName.length === 0) {
        throw invalid("INVALID_WORKSPACE", "Every workspace connection needs an integrationName.");
      }
      const binding = opts.integrations[entry.integrationName];
      if (!binding) {
        gaps.push({
          reason: "UNMAPPED_INTEGRATION",
          detail: `connections.yaml "${entry.integrationName}" has no integrationMap entry: bind it to an Integration UUID plus endpoint/secretsRequired, or record a follow-up.`,
        });
        continue;
      }
      if (!UUID.test(binding.id)) {
        throw invalid(
          "INVALID_WORKSPACE",
          `integrationMap "${entry.integrationName}" must carry a stable Integration UUID.`,
        );
      }
      if (typeof binding.org !== "string" || binding.org.length === 0 || binding.org.length > 128) {
        throw invalid(
          "INVALID_WORKSPACE",
          `integrationMap "${entry.integrationName}" needs an org name of 1-128 chars.`,
        );
      }
      if (typeof binding.endpoint !== "string" || binding.endpoint.length === 0) {
        throw invalid(
          "INVALID_WORKSPACE",
          `integrationMap "${entry.integrationName}" needs a non-secret endpoint string.`,
        );
      }
      if (CREDENTIAL_KEY.test(binding.endpoint)) {
        throw invalid("CREDENTIAL_IN_MANIFEST", "Integration endpoints must never embed credentials.");
      }
      const secretsRequired = binding.secretsRequired ?? [];
      if (!Array.isArray(secretsRequired) || secretsRequired.some((n) => typeof n !== "string")) {
        throw invalid(
          "INVALID_WORKSPACE",
          `integrationMap "${entry.integrationName}" secretsRequired must be a string list.`,
        );
      }
      let group = byIntegration.get(binding.id);
      if (!group) {
        group = { id: binding.id, connections: [] };
        byIntegration.set(binding.id, group);
      }
      group.connections.push({
        org: binding.org,
        config: { endpoint: binding.endpoint },
        secretsRequired: [...secretsRequired],
      });
    }
  }

  const extra = raw.extraEntities;
  if (extra !== undefined) {
    if (!object(extra)) throw invalid("INVALID_WORKSPACE", "Workspace extraEntities must be a kind-to-count map.");
    const labels: Readonly<Record<string, string>> = {
      tables: "UNSUPPORTED_TABLES",
      forms: "UNSUPPORTED_FORMS",
      apps: "UNSUPPORTED_APPS",
      agents: "UNSUPPORTED_AGENTS",
      claims: "UNSUPPORTED_CLAIMS",
      events: "UNSUPPORTED_EVENTS",
      filePolicies: "UNSUPPORTED_FILE_POLICIES",
    };
    for (const [kind, count] of Object.entries(extra)) {
      if (typeof count !== "number" || count <= 0) continue;
      const reason = labels[kind] ?? "UNSUPPORTED_ENTITY";
      gaps.push({
        reason,
        detail: `${kind} (${count}) present in the workspace but not convertible to the v1 manifest: record a follow-up (Tables #117, Forms #118, or a Solutions follow-up), do not silently drop.`,
      });
    }
  }

  if (sagas.length === 0) {
    throw invalid(
      "NO_CONVERTIBLE_SAGAS",
      "No workspace workflow resolved to a registered Saga pin: supply sagaMap entries or record the pilot as hand-pinned.",
    );
  }

  return {
    manifest: {
      manifestVersion: 1,
      bundle: { id: opts.bundleId, name: slug, version },
      sagas: sagas.map((pin) => ({ ...pin })),
      integrations: [...byIntegration.values()].map((group) => ({
        id: group.id,
        connections: group.connections.map((conn) => ({
          org: conn.org,
          config: { ...conn.config },
          secretsRequired: [...conn.secretsRequired],
        })),
      })),
      config: config.map((entry) => ({ ...entry })),
    },
    gaps,
  };
}
