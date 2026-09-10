# ADR 005: Per-Organization Secret Storage

- **Status:** Proposed — v0 redraft per wrang-main decision (issue #78, 2026-09-10)
- **Date:** 2026-09-09 (v0 redraft 2026-09-10)
- **Extends:** ADR 003 (Integrations and Connections; now Implemented per #75), `docs/upstream-spec.md` Secret management row

## Context

An Integration is portable code; a Connection is Organization-scoped environment state
(see ADR 003). Portable Saga/Integration source must never embed Organization credentials.

Upstream Bifrost binds Integrations to per-organization OAuth/config state.
Wrangnarök must provide the same product boundary Cloudflare-natively,
starting from Worker + Workflows + D1 only (AGENTS.md constraint 7).

Operator experience since the Rung-1 NinjaOne integration reshapes the
problem: MSP-platform credentials are effectively global with vendor-side
multitenancy — one M2M app credential sees every tenant organization
through the vendor API. Per-Organization secrets have no demonstrated need
(AGENTS.md constraint 7), so v0 does not build per-Organization secret
storage. The envelope scheme is retained as a tripwire-gated upgrade, not v1.

## Decision v0 (proposed direction, not yet accepted)

Deployment-level secrets plus org-scoped non-secret Connection mapping:

- Integration credential sets live at the **deployment level** in **Secrets
  Store** (one entry per credential, per environment; local-only values for
  `dev`). This matches the current NinjaOne posture (`NINJA_CLIENT_ID` /
  `NINJA_CLIENT_SECRET` from env) and formalizes it: the credential belongs
  to the deployment's vendor relationship, not to any Organization.
- Connection rows stay **org-scoped and non-secret**: `(org_id,
  integration_id)` → endpoint plus non-secret config
  (`UNIQUE(org_id, integration_id)` already in migration 0001). No secret
  or token columns, plaintext or otherwise.
- Each `IntegrationDefinition` declares `secretFields` (already in
  `src/integrations/index.ts`: `echo` none, `ninjaone` `clientSecret`).
  Declarations drive the scrub/redaction discipline below; secret material
  is resolved transiently at the Integration Action call boundary and never
  serialized through discovery, history, or Execution results.
- No OAuth token persistence yet: client-credentials tokens are fetched per
  execution and dropped (the degenerate inline refresh that works today).
  Cached tokens are secret storage and wait for the tripwire.

## Scrub and redaction discipline (retained in full)

Unchanged from the prior draft and non-negotiable in v0:

- Decrypted material exists only transiently, server-side, inside
  Worker/Workflow execution at the Action call boundary.
- No secrets in D1 rows, ExecutionHistory, Execution inputs/outputs,
  Workflow step payloads, Worker logs, error messages, or smoke-test output.
- No API — admin debug included — echoes decrypted Connection secrets.
- Workerd tests audit every persisted surface with secret sentinels
  (precedent: `test/ninjaone.test.ts`, `test/ninja-echo-digest.test.ts`).

## Tripwire: envelope encryption as a gated upgrade

The application-level envelope scheme (Web Crypto AES-GCM-256, per-Connection
DEK wrapped by a per-environment KEK in Secrets Store, `ciphertext` /
`nonce` / `wrapped_dek` / `key_version` / `algorithm` beside non-secret
config, decrypt-only-transient) is fully specified in the prior draft and
preserved as the upgrade design — it is not built until the tripwire fires.

The tripwire fires on the **first Integration with genuinely per-tenant
secrets**: a vendor auth model with no global-with-multitenancy option, or
a compliance demand for per-tenant credential isolation. Pre-authorized now:
firing the tripwire may introduce a **separate dependency** (crypto helper,
KMS-adjacent library) if that is what the envelope takes — no second
justification round for the dependency itself, only for the firing.

Firing the tripwire means: an ADR amendment recording which Integration
fired it and why no global credential exists; the envelope implemented per
the retained spec (encrypt-with-latest, decrypt-with-version, staged
re-wrap rotation, dev-smoke-then-destroy drill); and D1 backups understood
to carry ciphertext thereafter (unrecoverable without the matching KEK).

## Why Secrets Store alone is insufficient for per-org secrets (tripwire rationale)

This is why the envelope — not more deployment secrets — is the upgrade
when the tripwire fires. Secrets Store is real and correct for v0's
platform-level keys, but structurally wrong for per-Organization
credentials: one store per account capped at 100 secrets, per-secret
statically declared bindings, and every new credential needing a config
entry plus a redeploy by a Secrets Store Deployer. Onboarding one
Organization must never require a redeploy, and Organization isolation
would still have to be built on top — at which point the envelope has been
rebuilt with extra steps and a ceiling. D1 encryption at rest, likewise,
does not make plaintext credential columns acceptable application design.

## v0 rotation, backup, restore

- Rotation is Secrets Store rotation (version, verify, destroy) with a
  Worker restart/redeploy; no re-wrap migration, because D1 holds no secrets.
- D1 backups are secret-free by construction. KEK-style loss semantics do
  not apply in v0; losing a deployment secret means re-onboarding one
  vendor relationship, not N Organizations.

## v0 acceptance (unlocks 3.0)

This ADR is **not yet accepted**. Before milestone 3.0 ships on v0:

1. Threat model: deployment-secret compromise blast radius, admin vs
   ordinary caller on Connection mapping writes, backup/log attacker.
2. Scrub/redaction tests green in workerd for every Integration with a
   non-empty `secretFields` list (allowed/denied callers, history/result/log
   audit with sentinels).
3. `secretFields` coverage: every Integration declares; every declared
   field is excluded from discovery/history/result serialization by test.
4. Acceptance stamp (superseding note or v0 Accepted) + updated
   `docs/upstream-spec.md` secret-management row.

## Alternatives considered (ecosystem survey, Sep 2026; verdicts stand)

| Pattern | Verdict |
| --- | --- |
| Few static secrets (Worker secrets / Secrets Store) | **Adopted for v0 platform-level keys** (including any future KEK). Fails per-Organization credentials on cardinality (100/account), static per-secret bindings, and redeploy-per-tenant onboarding — which is why it is v0, not the tripwire answer. |
| Application-level envelope encryption | **Tripwire-gated upgrade** (see above), not v1. |
| Per-Organization D1 databases (Cloudflare's own SaaS guidance: DB/KV/R2 per customer) | **Documented upgrade path, not v0.** Matches Cloudflare's "complete isolation" story and stays on the earned D1 primitive. |
| Tenant-scoped Durable Objects as vaults (one DO per org, secrets in DO SQLite storage) | Strongest isolation story, but a new primitive (must be earned), paid-metered, and still needs app-level routing correctness. Requires its own ADR if ever demanded. |
| Workers for Platforms per-tenant bindings | Rejected twice over: paid-only dispatch namespaces (breaks the Free-tier constraint) and equally static bindings. |
| External KMS (call out to AWS/GCP/Vault) | Rejected: vendor dependency, latency, and cost against the Cloudflare-native experiment constraint. |

## Storage topology: single D1 now, per-Organization D1 later

v1 is a **single D1** with `org_id` columns and (under v0) zero secret
columns: unbounded Organizations on Free, static bindings, one migration
stream (ADR 004), isolation by deny-by-absence `WHERE` clauses proven with
allowed/denied caller tests. Per-Organization D1 databases are the Phase 3+
upgrade, gated on all of:

1. A Paid plan (Free caps at **10 databases per account** — per-org D1 as v1
   would cap the product at 10 Organizations and violate the Free-tier
   constraint outright).
2. An Organization count or compliance demand where per-DB blast radius,
   backup/restore, and per-DB usage metering justify migration fan-out.
3. A runtime routing design that does not smuggle an API token into the edge
   (static bindings cap at ~5,000/script and still need deploys; the
   Cloudflare API from inside the Worker is a super-credential, worse than
   the problem it solves).

Until all three hold, per-org D1 is studied, not built.
