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

1. **Worker secrets are deployment-bound, not Organization-bound.** One value per
   deployment/environment. They cannot express N Organizations × M Connections,
   cannot be CRUD-managed per Organization via the application API, and change
   only via redeploy with broad deploy privileges.
2. **Secrets Store is account-level and count-limited.** It is suitable for
   a small set of deployment/account secrets (e.g. a master key), not for
   an unbounded per-Organization Connection table. Lifecycle is account/store
   scoped, not Organization scoped, and application-level Organization isolation still
   has to be built on top.
3. **D1 encryption at rest is not application secret design.** D1 is
   encrypted at rest, but a plaintext `api_token TEXT` column would still
   expose credentials to any D1 reader, backup, log, or ExecutionHistory query.

## Decision (proposed direction, not yet accepted)

Use application-level envelope encryption with a deployment master key:

- One **master key (KEK)** per environment (`dev`, `production`), stored
  only as a **Worker secret** (env binding). Never in Git, D1, ExecutionHistory,
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
- Retain at most the previous KEK version(s) as decrypt-only Worker secrets
  during rotation, then destroy per runbook.
- Rotation = add new KEK version → re-wrap DEKs (or re-encrypt) via staged
  migration → verify dev smoke → destroy old version. Same forward-compatible
  discipline as ADR 004 D1 migrations.
- Format string (`algorithm`) must be versioned before declaring stability;
  v1 is experimental.

## What First Acorn must NOT do

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
- First Acorn stays unblocked without secret storage.
