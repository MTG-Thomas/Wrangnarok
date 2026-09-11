# ADR 016: Authored Applications — independent vs Solution-owned lifecycle, ownership, recovery, build security

- **Status:** Accepted (2026-09-11; gates APP-01 per issue #159)
- **Date:** 2026-09-11
- **Extends:** ADR 002 (stable identity), ADR 003 (Integration vs Connection), ADR 011 (Solutions install contract)
- **Upstream compatibility:** shaped from upstream `gobifrost/bifrost` authored-app machinery at baseline `3543c7ebee0e1bd9a2cab6dfba080a30621b1c5f` (`api/src/routers/applications.py`, `api/src/routers/app_code_files.py`, `api/src/routers/dependencies.py`, `api/src/jobs/platform/application_deploy.py`; tests `api/tests/e2e/api/test_applications.py`, `api/tests/e2e/api/test_application_publish_async.py`, `api/tests/e2e/platform/test_solution_v2_app_e2e.py`). Ideology preserved; divergences below are explicit and Cloudflare-driven.

## Context

Upstream Bifrost lets workspace authors create applications and deploy them through two distinct lifecycles:

1. **Independent applications (current V2).** An app is local source plus a build plus a deploy. There is no separate draft/preview/publish step for independent V2 apps: the author edits local source, validates, builds, and deploys. Each deploy runs as an asynchronous job the author can inspect.
2. **Solution-owned applications (current V2).** The same app source can be captured into a Solution bundle as an owned entity; install reconciles it like any other managed row (install/upgrade/rollback through the bundle path, live mutation rejected outside install).
3. **Legacy V1.** The older draft/publish lifecycle (draft, preview, publish) predates the V2 model. It is a historical record, not a second mode we implement.

Wrangnarök has half of the Solution-owned side (ADR 011 connection reconciliation) and none of the independent-app side: no Application record, no code-file/dependency declarations, no deploy job, no route/slug registry, no authored-asset serving. The control-plane React UI ships as Worker Static Assets and proves nothing about per-tenant authored-app hosting or build isolation.

Two upstream invariants bound this design:

- **Independent V2 deletes superseded compiled artifacts.** There is no retained-history rollback UI as existing upstream behavior: recovery is redeploy (a newer build of fixed source) or a parked-old-app slug swap (keep the old app record around under a different slug and swap the route back). We must not promise a rollback timeline the upstream product does not keep.
- **Failed deployment preserves the prior usable app.** Activation moves an `active_deployment_id` pointer only after the new build compiles and stages cleanly; a failed build leaves the previous pointer (and the caches/invalidation state around it) untouched.

## Decision

### 1. Independent versus Solution-owned applications

An **Application** is an Organization-scoped, author-owned record: stable UUID identity (ADR 002 rules: edits preserve identity, identity changes mint a different app), a human name, a route slug unique per Organization, an ownership marker, and an `active_deployment_id` pointer.

- **Independent app:** `owner_kind = 'independent'`, `managed_by IS NULL`. It lives and dies through the app API below. The trusted author edits source declarations, validates, builds, and deploys. There is no draft/preview/publish step: validate/build/deploy is the lifecycle.
- **Solution-owned app:** `owner_kind = 'solution'`, `managed_by = <bundle_id>@<version>`. It is reconciled by bundle install (ADR 011) and **rejects live mutation** through the app API with `MANAGED_RESOURCE` (409), exactly like managed Connections. Only the installer writes owned rows. Redeploy deletes managed absentees scoped to the bundle; loose app rows (`managed_by IS NULL`) are never touched by install.

**Legacy V1 draft/publish is documented, not implemented.** V1 draft/preview/publish is the superseded upstream lifecycle; current upstream V2 (local-source/build/deploy) is the model. No draft, preview, or publish endpoints ship, and no V1 compatibility shim is promised.

### 2. Independent V2 lifecycle: edit, validate, build, deploy, inspect

The trusted author (the authenticated Organization caller; no separate author role in v1) moves an independent app through explicit states recorded in D1:

- `created` — record exists, no valid source revision yet.
- `ready` — the latest source revision passes validation (code files parse against the declared schema, dependencies resolve against the allowlist, slug/route still unclaimed).
- `building` — a build (deploy job) is running for the revision.
- `live` — an `active_deployment_id` points at a successful build.
- `failed` — the latest build failed; the previous `active_deployment_id` (if any) is untouched.

Transitions are append-only forward except `failed`, which returns the app to its prior live/ready posture: **a failed build never clears `active_deployment_id`**. Only validation-passing revisions may build; only successful builds may activate.

Code files and dependencies are declarations, not execution: the app stores file records (path, content hash, byte size) and dependency pins (name, version range). Validation checks shape (paths, sizes, name allowlists) and records the result; **nothing in the source is executed at edit or validate time**.

Every deploy creates an **asynchronous deploy job** row the author can inspect: queued/running/succeeded/failed with started/finished timestamps, the revision it built, and a safe error (code + message, no stack or environment detail). The API is:

- `POST /api/apps` — create (independent only; Solution-owned rows arrive via install).
- `GET /api/apps` — list for this Organization (id, name, slug, owner, status, active deployment).
- `GET /api/apps/:id` — detail including revisions, jobs, and the active deployment.
- `PUT /api/apps/:id/source` — edit source declarations (independent only; validations run, `MANAGED_RESOURCE` on owned rows).
- `POST /api/apps/:id/validate` — validate the current revision, return field-level failures.
- `POST /api/apps/:id/builds` — start an async deploy job (validate-gated).
- `GET /api/apps/:id/builds` and `GET /api/apps/:id/builds/:jobId` — inspect the job queue and one job.
- `POST /api/apps/:id/swap` — parked-old-app slug swap recovery (Section 4).
- `DELETE /api/apps/:id` — delete an independent app (owned rows refuse; uninstall owns that path).

Query strings stay deny-by-default: list routes take no query keys (anything else is `UNSUPPORTED_QUERY`), matching the existing hardening posture. Bodies are bounded JSON (`BODY_LIMIT`), auth is the standard Organization caller (foreign org rows answer 404, never a leak).

### 3. Routes, slugs, dependencies, and explicit replace/swap semantics

- **Slugs are unique per Organization** (`UNIQUE(org_id, slug)`). Creating or renaming onto a claimed slug fails with `SLUG_CONFLICT` (409). A slug rebuild after delete is a new app, never a resurrection: identity follows the UUID, not the slug.
- **Dependencies are pinned declarations** (name + exact version or bounded range against a static allowlist). Unlisted or unresolvable dependencies fail validation with `DEPENDENCY_UNRESOLVED`; validation failure blocks build.
- **Replace is explicit.** Deploying a new revision over a live app replaces the served bundle only on success (pointer move); there is no merge, no partial activation, and no retained compiled history beyond the active and (optionally) parked rows.
- **Swap is explicit.** `POST /api/apps/:id/swap` exchanges the slugs of two apps in the same Organization atomically at the row level (fenced on both current slugs): the parked old app takes the live slug back. A lost race surfaces `SLUG_CONFLICT`, never a silent double-claim.

### 4. Recovery: redeploy or parked-old-app slug swap, never a history-rollback UI

Recovery has exactly two supported paths, matching upstream behavior:

1. **Redeploy:** fix the source, validate, build, deploy. The new successful build moves `active_deployment_id`. This is the primary path.
2. **Parked-old-app slug swap:** before a risky deploy, the author duplicates the live app record under a parking slug (ordinary create with copied source, then deploy to confirm it serves). If the new revision fails in production, `swap` exchanges the slugs so the parked copy serves the production route again.

What we do **not** ship: a retained-history rollback UI. Independent V2 deletes superseded compiled artifacts, so a timeline-restore control would promise what the platform does not keep. Downgrade-by-reinstall (ADR 011 section 4) covers Solution-owned apps through the same bundle path; independent apps recover by redeploy or swap, both tested.

### 5. Activation and cache invalidation semantics

Activation is a pointer move with explicit ordering:

1. The build stages its compiled bundle (D1 `app_deployments` row: revision, bundle bytes reference, content hash).
2. Only on build success does `active_deployment_id` move to the new row, in the same fenced write that marks the job succeeded.
3. The previous deployment row is retained (one generation) so a failed *next* build still has something to preserve; older superseded rows are deleted on success (upstream parity: no retained history beyond the active row plus the optional parked app, which is a separate app row, not deployment history).
4. Served-asset responses carry `ETag: "<content-hash>"` and `Cache-Control: no-store` on the API; the authorized asset route (`GET /api/apps/:id/assets/*`, same Organization caller, 404 for foreign rows) serves the active deployment bytes only. A moved pointer is immediately visible because activation and serving read the same row. There is no separate CDN purge step in v1: `no-store` is the invalidation story, recorded here so a future cache layer must revisit it.

### 6. Build-security decision (gating)

**No untrusted source or package execution ships in v1.** This ADR accepts the lifecycle, validation, job, and serving contract above, but draws a hard line:

- Validation is **shape-only** (path allowlists, byte bounds, dependency-pin allowlist, JSON schema of the declaration). It never imports, evaluates, bundles, or installs the declared source or its dependencies.
- The v1 deploy job **compiles declarations to a stored bundle without executing them**: it re-validates, resolves pins against the static allowlist, hashes content, and writes the `app_deployments` row. There is no package install step, no build-script execution, no dynamic import of author code in the Worker.
- **Worker Static Assets for the platform shell is not proof of per-tenant authored-app hosting or build isolation.** Authored assets are served as data rows through the authorized asset route (Section 5), never as platform code, and never through the platform ASSETS binding.
- Any future step that executes untrusted source or installs third-party packages (a real bundler, an isolate build venue, a paid build service) needs its own ADR with a venue decision, an isolation model, and a documented cost gate. Adding a Queue, R2, or a paid build primitive for that purpose is justified there, not here. This v1 ships on Worker + D1 only, per the standing constraint.

This section is the acceptance gate the issue requires: the lifecycle above is safe to implement now *because* nothing executes author code. Reviewers must reject any lane that smuggles execution into validate/build without the follow-up ADR.

## Consequences

- Authors get a real create/deploy/inspect loop for Organization-scoped apps with honest recovery (redeploy or swap) and no phantom rollback UI.
- Solution-owned apps reuse the ADR 011 ownership machinery: one flag, enforced in code, tested by owned-vs-loose mutation tests.
- The build-security line keeps v1 on the Free-tier envelope (Worker + D1 only) and forces the isolation/cost conversation before any execution venue is added.
- Deferred: multi-route apps (one slug per app in v1), per-app custom domains, build logs beyond the safe job error, scheduled deploys, cross-org app sharing (SOL-02), and the browser App SDK runtime (APP-02).

## Alternatives considered

- **Full upstream parity (V1 draft/publish + retained deployment history):** rejected — V1 is superseded upstream, and retained-history rollback contradicts the current upstream artifact-deletion behavior. Documenting V1 without implementing it is the honest record.
- **Real bundler execution in v1 (esbuild/isolate/R2 builds):** rejected — untrusted execution needs an isolation model and usually a paid venue; the shape-only build proves the lifecycle without it.
- **Serving authored apps as platform Static Assets:** rejected — the platform shell binding is not per-tenant isolation, and mixing author bytes into the platform deploy conflates two trust domains.
