# Workspace-to-bundle bridge (issue #116, MIG-01)

Converts a workspace-style solution definition (`bifrost.solution.yaml`
descriptor plus `.bifrost/*.yaml` entity manifests) into a Wrangnarok
`solution.manifest.json` install manifest, or fails loudly with the gap.

Upstream baseline: `gobifrost/bifrost@3543c7e` (`api/bifrost/solution_descriptor.py`,
`api/src/models/contracts/solutions.py`, `api/src/services/solutions/zip_install.py`,
`api/bifrost/decorators.py`, `api/src/services/solutions/deploy.py`).

## Field mapping

| Workspace source | Bundle manifest | Notes |
| --- | --- | --- |
| `bifrost.solution.yaml` slug | `bundle.name` verbatim | Definition identity, portable across installs. |
| `bifrost.solution.yaml` version | `bundle.version` verbatim | Free-form PEP 440 upstream; semver enforced locally. |
| descriptor (no UUID field) | `bundle.id` operator-supplied | Slug renames never silently re-identify installed data. |
| `.bifrost/workflows.yaml` entry id (manifest UUID) | source identity only | Resolves via operator `sagaMap` to a registered Saga pin `{id, revision}`. |
| entry name / `path::function` | `sagaMap` key | Python source is never executed by the bridge. |
| `.bifrost/configs.yaml` declaration | `config[]` only with explicit non-secret value | Value-less declarations become `DECLARATION_WITHOUT_VALUE` gaps for install time. |
| `.bifrost/connections.yaml` `integration_name` | `integrations[].id` via `integrationMap` | Template skeletons carry no endpoint; the operator binds endpoint + org. |
| connection template | `config.endpoint` + `secretsRequired` names | Names only, never credential values. |
| install scope, config values, `secrets.enc`, table rows, file bytes, execution state, git wiring, logos, READMEs | excluded | Deploy-time or runtime state; never converted. |

## Source identity vs registered identity

The `@workflow` decorator carries identity-only metadata
(`name`/`description`/`category`/`tags`); it is not a stable identity. Stable
identity exists only after registration as a Workflow row, and install rows
carry the per-install remapped id (`uuid5(install_id, manifest_id)` per
`deploy.py:solution_entity_id`). The bridge therefore treats every manifest
UUID as source identity and requires the operator to map it to a registered
Saga pin. Unmapped workflows are `UNMAPPED_WORKFLOW` gaps, never silent drops.

## Environment exclusion

Install kind is a deploy-time choice upstream (`organization_id`, NULL for
global scope), never a descriptor field. The bridge refuses workspace keys
that pin scope (`scope`, `organization_id`, `org`, ...) with
`SCOPE_IN_WORKSPACE`, and refuses secret values (`secrets`, `configValues`,
`secrets.enc` refs) with `CREDENTIAL_IN_WORKSPACE`. Credential-shaped config
keys fail with `CREDENTIAL_IN_MANIFEST`, matching the installer.

## Unsupported features

Present-but-unconvertible workspace features return actionable gaps:

- `UNMAPPED_WORKFLOW` / `UNMAPPED_INTEGRATION`: supply the operator map entry.
- `DECLARATION_WITHOUT_VALUE`: satisfy at install time via Connection config.
- `UNSUPPORTED_TABLES` / `UNSUPPORTED_FORMS` / `UNSUPPORTED_APPS` /
  `UNSUPPORTED_AGENTS` / `UNSUPPORTED_CLAIMS` / `UNSUPPORTED_EVENTS` /
  `UNSUPPORTED_FILE_POLICIES`: record a follow-up (Tables #117, Forms #118,
  or a Solutions follow-up). Never silently dropped.

## Exit check

A `solutions/sharepoint-file-transfer`-shaped workspace (slug + version +
workflows + configs + connections + extra entities) converts to a manifest
that `parseBundleManifest` accepts, with remaining pieces enumerated as gaps.
Covered by `test/migration-bridge.test.ts` (pure node-safe, no bindings).
