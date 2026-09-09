# ADR 005: Per-Organization Secret Storage

- **Status:** Proposed — not yet approved for production use
- **Date:** 2026-09-09
- **Extends:** ADR 003 (Integrations and Connections), `docs/upstream-spec.md` Secret management row

## Context

An Integration is portable code; a Connection is Organization-scoped environment state
(see ADR 003). Portable Saga/Integration source must never embed Organization credentials.

Upstream Bifrost binds Integrations to per-organization OAuth/config state.
Wrangnarök must provide the same product boundary Cloudflare-natively,
starting from Worker + Workflows + D1 only (AGENTS.md constraint 7).

## Why Worker secrets + Secrets Store alone are insufficient

Secrets Store is real and worth using — just not for per-Organization
credentials. Verified against current Cloudflare docs (open beta, Aug 2026):

- One store per account, **100 secrets max**, each a ≤1024-byte string,
  write-only after creation (only the bound service can `get()`).
- Workers bindings are **per-secret and statically declared** (`binding` +
  `store_id` + `secret_name` in wrangler config). Each new credential needs
  a config entry plus a redeploy by a Secrets Store Deployer.
- Local dev cannot touch production secrets (separate local secrets).

That shape fails per-Organization credentials structurally, not just
numerically:

1. **Worker secrets are deployment-bound, not Organization-bound.** One value per
   deployment/environment. They cannot express N Organizations × M Connections,
   cannot be CRUD-managed per Organization via the application API, and change
   only via redeploy with broad deploy privileges.
2. **Secrets Store cardinality and lifecycle are account-scoped.** Even if the
   100-secret beta cap rose tomorrow, every Connection credential would still
   need a static binding entry plus a redeploy to onboard one Organization,
   with no Organization dimension to scope lookups. Application-level
   Organization isolation still has to be built on top — at which point the
   envelope scheme has been rebuilt with extra steps and a ceiling.
3. **D1 encryption at rest is not application secret design.** D1 is
   encrypted at rest, but a plaintext `api_token TEXT` column would still
   expose credentials to any D1 reader, backup, log, or ExecutionHistory query.

## Decision (proposed direction, not yet accepted)

Use application-level envelope encryption with a deployment master key:

- One **master key (KEK)** per environment (`dev`, `production`), stored
  in **Secrets Store** (local-only secret for `dev`; never remote/production
  values in local config). Never in Git, D1, ExecutionHistory,
  logs, or client responses. `dev` KEK ≠ `production` KEK.
- Per-Connection secrets encrypted inside the Worker with Web Crypto
  **AES-GCM-256 + random 96-bit nonce**. Envelope form: random per-Connection
  data key (DEK) encrypts the payload; DEK is wrapped by the current KEK.
- D1 `connections` row stores only: `ciphertext BLOB`, `nonce BLOB`,
  `wrapped_dek BLOB`, `key_version INTEGER`, `algorithm TEXT` (e.g.
  `AES-GCM-256-envelope-v1`), plus non-secret config/metadata.
- Decryption happens only transiently, server-side, inside Worker/Workflow
  execution at the Integration Action call boundary. Decrypted material is never
  persisted, never returned by APIs, and never written to ExecutionHistory, Execution
  results, Workflow state, or logs.
- Integration schema declares which fields are secret; `ctx.integrations.*` injects
  decrypted values only to the Action implementation.

## Key rotation / versioning

- `key_version` selects the KEK that wrapped the DEK. Encrypt always with
  latest; decrypt with the matching historical version.
- Retain at most the previous KEK version(s) as decrypt-only Secrets Store
  versions during rotation, then destroy per runbook.
- Rotation = add new KEK version → re-wrap DEKs (or re-encrypt) via staged
  migration → verify dev smoke → destroy old version. Same forward-compatible
  discipline as ADR 004 D1 migrations.
- Format string (`algorithm`) must be versioned before declaring stability;
  v1 is experimental.

## What the MVP slice must NOT do

- No plaintext credential/token columns in D1.
- No secrets in ExecutionHistory rows, Execution Operation inputs/outputs, Workflow
  step payloads, Worker logs, error messages, or smoke-test output.
- No API that echoes decrypted Connection secrets (admin debug included).
- No OAuth token persistence yet (deferred per ADR 003); demo Integration uses a
  mock endpoint with non-secret config only.
- No per-Organization fan-out of Worker secrets or Secrets Store entries.

## Backup / restore implication

- D1 backups contain ciphertext + nonces + wrapped DEKs only. They are
  unrecoverable without the matching KEK version.
- KEK backup/restore is separate from D1, environment-scoped, and access-logged.
  Loss of all KEK versions for an environment = loss of all Connection secrets
  in that environment (by design); recovery is re-onboarding Connections,
  not decrypting backups.
- Restores must preserve `key_version` → KEK mapping; never mix `dev` KEK
  with `production` ciphertext.

## Production gate (explicit)

This ADR is **not yet approved for production**. Before any Phase 3
Connection-with-secrets ships, required review:

1. Threat model: Organization isolation, admin vs ordinary caller, backup/log attacker.
2. Crypto + code review of Web Crypto usage, nonce generation, envelope format.
3. Organization-isolation and redaction tests in workerd (allowed/denied callers,
   ExecutionHistory/result/log audit with secret sentinels).
4. Rotation drill on `dev` (add → re-wrap → verify `system.smoke` → destroy).
5. Superseding ADR (or 005 v2 Accepted) + updated `docs/upstream-spec.md` row.

## Consequences

- Integration code stays portable; Connection secrets stay Organization-scoped.
- Adds crypto + rotation complexity — earned only when real credentials arrive.
- First MVP slice stays unblocked without secret storage.

## Alternatives considered (ecosystem survey, Sep 2026)

| Pattern | Verdict |
| --- | --- |
| Few static secrets (Worker secrets / Secrets Store) | Correct for platform-level keys (including our KEK). Fails per-Organization credentials on cardinality (100/account), static per-secret bindings, and redeploy-per-tenant onboarding. |
| Per-Organization D1 databases (Cloudflare's own SaaS guidance: DB/KV/R2 per customer) | **Documented upgrade path, not v1 (see below).** Matches Cloudflare's "complete isolation" story and stays on the earned D1 primitive. |
| Tenant-scoped Durable Objects as vaults (one DO per org, secrets in DO SQLite storage) | Strongest isolation story, but a new primitive (must be earned), paid-metered, and still needs app-level routing correctness — a request routed to the wrong org's DO fails identically. Requires its own ADR if ever demanded. |
| Workers for Platforms per-tenant bindings | Rejected twice over: paid-only dispatch namespaces (breaks the Free-tier constraint) and equally static bindings. |
| External KMS (call out to AWS/GCP/Vault) | Rejected: vendor dependency, latency, and cost against the Cloudflare-native experiment constraint. Same trust-domain question, answered worse. |

## Storage topology: single D1 now, per-Organization D1 later

v1 is a **single D1** with `org_id` columns and envelope ciphertext: unbounded
Organizations on Free, static bindings, one migration stream (ADR 004),
isolation by deny-by-absence `WHERE` clauses proven with allowed/denied caller
tests. Per-Organization D1 databases are the Phase 3+ upgrade, gated on all of:

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
