# ADR 014: Human Authentication via Cloudflare Access

- **Status:** Accepted
- **Date:** 2026-09-10
- **Extends:** ADR 003 (Integrations and Connections), ADR 005 (provider-global v0 accepted; per-Organization envelope tripwire-gated), `docs/upstream-spec.md` auth rows
- **Steward review requested** on the implementing PR (security-adjacent; Phase 3 gate unchanged).

## Context

The LAB fixture bearer (`auth.ts`: 64-hex token, org/user from environment)
is correct for local/dev-fixture use and stays. Production human auth needs
real identity without building an OIDC user store, session cookies, or a
credential database inside the Worker — all of which would violate the
Cloudflare-native constraint and explode ADR-005 scope.

Upstream Bifrost authenticates callers and enforces owner-or-superuser
semantics with 404-on-foreign. Wrangnarök keeps those semantics; only the
identity source changes per platform.

## Decision

Human requests to URL-fronted environments authenticate via **Cloudflare
Access (Zero Trust)**, verified in-Worker:

- Access fronts the route, validates the login, and forwards the
  `Cf-Access-Jwt-Assertion` header. The Worker independently verifies it:
  RS256 signature against the team certs endpoint, `aud` match, expiry with
  60s leeway. Never trust the header unverified.
- Verified email becomes `Principal.userId` (lowercased); `Principal.orgId`
  comes from `ACCESS_ORG_ID`. Owner-scoping, 404-on-foreign, and all
  downstream authorization logic are unchanged — authentication moves to the
  edge, authorization stays in code + D1.
- Until Phase 3 ships D1 organization membership, a comma-separated
  `ACCESS_ALLOWED_EMAILS` allowlist gates who maps to the org. Empty
  allowlist denies everyone (fail closed). This allowlist is explicitly the
  demotion path: Phase 3 replaces it with the membership table, no API change.
- Service-token assertions carry no email: their `common_name` claim holds
  the token CLIENT ID (not the token name). `ACCESS_ALLOWED_SERVICES` lists
  client IDs; matched services map to `service:<client-id>` principals in the
  configured org. Verified live against the dev floor.
- LAB path is untouched and takes over when no assertion header is present.
  An assertion header with Access unconfigured fails closed (503), never
  falls through to LAB. Direct-URL callers bypassing Access still face LAB.
- Free-tier fit: Zero Trust free covers 50 users — inside the MVP constraint.
- Access policy itself (which emails, which routes) is Organization-owned
  install state like D1 IDs: documented, never in Git.

## What this ADR does NOT do

- No D1 user table, no sessions, no password/OAuth code of our own.
- No per-Organization Connection credentials (still ADR-005, still gated).
- No production deploy authorization (promotion stays manual per ADR-004).
- No change to service paths: Workflow steps, cron, and D1-local flows never
  traverse Access and are unaffected.

## Consequences

- Admin provisions humans in the Cloudflare dashboard/IdP (SSO/MFA free);
  the app never stores human credentials.
- Pilot order: code merged with tests → Access policy on the dev URL →
  verify matrix (no-header 401/404, forged assertion 401, expired 401,
  wrong-aud 401, allowed email 200, denied email 403) → production dark
  until Phase 3 membership lands.
- If Access is ever removed, delete the policy and the Worker falls back to
  LAB-only; no code removal required (unconfigured = inert).
