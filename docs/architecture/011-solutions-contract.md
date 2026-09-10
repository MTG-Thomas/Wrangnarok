# ADR 011: Solutions — portable bundles, install reconciliation, activation

- **Status:** Proposed (gates production promotion per issue #35; dev deploy unaffected)
- **Date:** 2026-09-10
- **Extends:** upstream findings 9–11, ADR 002 (stable identity), ADR 003 (Integration vs Connection), ADR 005 (secret storage)
- **Upstream compatibility:** verified against `gobifrost/bifrost` Solutions machinery (`api/src/services/solutions/`, ORM + contracts, Sep 2026 mirror). Ideology preserved throughout; divergences below are explicit and Cloudflare-driven.

## Context

Upstream Bifrost separates a portable Solution definition (apps, workflows, forms, integrations, config declarations, claims) from each Organization installation (independent identity, config, credentials, runtime data). Managed entities reject live mutation; deploy reconciles by full replacement while environment data follows separate rules.

Wrangnarök currently has half of this: stable Saga/Integration IDs, D1 snapshots in Execution rows, and seed scripts. It lacks a manifest (what *is* the bundle?), an install path (remote state today is seeded by hand-run scripts with no reconciliation), any owned-vs-loose distinction (every D1 row is effectively loose), and activation semantics. Production promotion without these means hand-built tenant state with no source of truth — the exact failure the standing rule (no hand-mutated remote state) exists to prevent.

## Decision

### 1. Manifest: `solution.manifest.json`, versioned, environment-free by construction

A bundle is one manifest file plus the Git tree it points at. Schema (v1):

```json
{
  "manifestVersion": 1,
  "bundle": { "id": "00000000-0000-0000-0000-000000000000", "name": "acme-starter", "version": "1.2.0" },
  "sagas": [{ "id": "<stable-saga-uuid>", "revision": "echo-v1" }],
  "integrations": [{ "id": "<stable-integration-uuid>", "connections": [{
    "org": "default",
    "config": { "endpoint": "https://api.example.com" },
    "secretsRequired": ["clientSecret"]
  }] }],
  "config": [{ "key": "supportEmail", "value": "ops@example.com" }]
}
```

Structural exclusions (rejected by validation, not convention): credential/token *values* (only `secretsRequired` names), Execution/Operation/history rows, Workflow instance IDs, environment URLs that embed tenant identity. Secrets resolve at install time from env/Secrets Store per ADR 005 — the manifest never carries them and `secretsRequired` names must exist in the Integration's declared secret schema.

**Explicit divergence — format:** upstream ships `bifrost.solution.yaml` plus `.bifrost/*.yaml` declarations inside a zip. Wrangnarök uses a single JSON manifest: Worker-native parsing with no YAML dependency, and no packaging step in v1 (Section 5). Same ideology (source + declarations only, values excluded); different container.

### 2. Install is reconciliation, not seeding

`installBundle(db, manifest, { strict })` is idempotent per row and restart-safe:

1. Validate manifest (schema version, UUIDs resolve against the static code catalog, no environment values).
2. Ensure the Organization row; record the install in `bundle_installs(bundle_id, version, org_id, manifest_hash, installed_at)`.
3. For each declared Connection: INSERT missing managed rows; UPDATE drifted managed rows to manifest values **iff** the row's `managed_by` matches this bundle (same bundle id); never INSERT credentials, never touch `executions`/`operations`/`usage_blocks` or any row with `managed_by = NULL` created outside install.
4. Report a drift plan first (`--dry-run` lists create/update/skip); apply only on explicit invocation.

Re-running an install is a no-op when nothing drifted. Interrupted activation restarts from scratch safely — there is no half-state by construction (no multi-row transaction spans D1 + Workflows; each row reconciles independently).

### 3. Owned vs loose: one flag, enforced in code

Upstream marks ownership with a nullable install id (`solution_id NULL` = loose,
non-NULL = owned by exactly one install): live mutation of owned rows is
blocked (409 plus a persistence-layer backstop), redeploy upserts owned rows in
place and deletes absentees scoped to the install (`solution_id == sid AND id
NOT IN bundle`), installed entities get deterministic stable IDs, and file
payloads are never deleted. Wrangnarök copies this shape with D1 means:

- **Managed:** `connections` config columns + `bundle_installs` ledger carry `managed_by = <bundle_id>@<version>`. Ordinary application/API write paths MUST reject writes to managed rows (`MANAGED_RESOURCE` error); only the installer writes them.
- **Loose:** `executions`, `operations`, `usage_blocks`, and any row with `managed_by IS NULL`. The app owns these freely.
- Live mutation of a managed row outside install is rejected at the repository layer (centralize Connection writes through one function that checks the flag), demonstrated by test — not by policy prose.
- Redeploy deletes managed absentees scoped to the bundle install (entities in D1 but no longer in the manifest), except payload-like rows, which are never deleted (applies to future Artifacts; nothing qualifies in v1).
- Installed entity identity is deterministic (`uuid5`-style over install + manifest identity) so reinstall converges instead of forking duplicates.

### 4. Activation and rollback are install operations

Upstream keeps immutable deployment rows (hashes, pins, states) behind a mutable
active pointer moved by compare-and-swap, with `conflicted`/`recovery_required`
outcomes and rollback reusing the same CAS path; downgrades are refused unless
forced; execution fail-closes with no active pointer. Wrangnarök adopts the
semantics with D1 means, minus the Postgres/S3/Vite-compile plumbing:

- Upgrade = install a newer bundle version (reconcile, bump `bundle_installs.version`). Rollback = install the previous manifest (same code path, downgrades managed rows to recorded values). No separate rollback machinery in v1.
- Each install writes an immutable install record (bundle id/version, manifest hash, resolved IDs); the install pointer moves only on full reconcile success, and a lost race surfaces `conflicted`, never silent overwrite. Downgrades are refused unless forced.
- Saga *behavior* versions travel with code deploys (Worker bundle), not manifests: the manifest pins expected `revision` strings and install **fails closed** (`REVISION_MISMATCH`) when code and manifest disagree, so a deploy can never silently serve undeclared behavior.
- Execution fail-closes with no active install for the referenced bundle, with one exception: local/loose development (no install present) keeps working, mirroring upstream's legacy-repo exception. The boundary is explicit, not a silent fallback.

### 5. Install preflight fails closed before any write

Upstream gates deploy on preflight (missing modules, downgrade, pending-capture blockers, locks, scope). Wrangnarök's install preflight, all checked before the first write:

- manifest resolves against the static code catalog (every saga/integration ID exists);
- pinned revisions match deployed code, else `REVISION_MISMATCH`;
- every `secretsRequired` name exists in the Integration's secret schema and has a value available (env/Secrets Store), else fail closed — never install half-credentialed;
- no ownership conflicts (a managed row owned by a *different* bundle id aborts with `INSTALL_CONFLICT`; hijack by re-install is refused);
- downgrade without explicit force is refused.

### 6. v1 implementation slice (what #35 ships)

- Manifest parser/validator (hand-rolled, no new deps — mirrors the saga-catalog validation style) + one checked-in example bundle (echo saga + echo fixture Integration, `default` org only).
- `installBundle` + local runner (`npm run install:local`, D1-local, fixture secrets from env) + `--dry-run` drift report.
- `managed_by` column migration (additive, nullable → all existing rows loose by default, zero behavior change on upgrade).
- workerd tests: fresh-org install from manifest; re-run no-op; managed-row live mutation rejected; rollback = reinstall v1 after v2 with managed values restored; secretsRequired-without-value fails closed.
- Explicitly deferred: cross-org shared fallback, export/import packaging, UI, per-Operation `required` wiring (see ADR 010 — the manifest's saga list and the `required` declaration must agree; the implementation lane resolves which is authoritative on conflict).

## Consequences

- Remote state gains a source of truth before production exists; the standing rule becomes enforceable by code instead of discipline.
- Dev flow is unchanged (seed scripts keep working locally); install is additive, first exercised against dev.
- Adds manifest/installer complexity — earned by the production gate, not before; v1 is deliberately install-only, no packaging format beyond versioned JSON.

## Alternatives considered

- **Keep seed scripts forever:** rejected — seeds are write-once with no drift detection, no ownership, and no rollback story. They stay for local fixtures only.
- **Full upstream parity (loose entities, solution-owned apps/forms/agents, cross-org fallback):** rejected for v1 — no Forms/agents/Tables exist yet to own; fallback semantics need the Phase 3 auth model first.
- **Two-phase/atomic activation across D1 + Workflows:** rejected — D1 has no cross-service transactions with Workflows; idempotent per-row reconciliation gives restart-safety without pretending atomicity.
