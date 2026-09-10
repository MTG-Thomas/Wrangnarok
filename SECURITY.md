# Security policy

Wrangnarök is a pre-alpha experiment. There are no supported releases yet; everything on `main` should be treated as under active development.

## Reporting a vulnerability

Please do **not** open a public issue for a suspected vulnerability. Use GitHub's [private vulnerability reporting](../../security/advisories/new) on this repository instead, so the report stays private until a fix exists.

Include, where known:

- the affected commit or file and how the issue was found;
- what an attacker could achieve (read/write/execution scope, tenant boundary);
- whether Organization isolation or Connection secrets are involved.

## Scope notes

- Production dependencies are intentionally tiny (`react`, `react-dom`, `react-router-dom`); CI gates `npm audit --omit=dev` on every PR.
- Local Cloudflare emulation (`wrangler`, `@cloudflare/vitest-plugin`) pulls in dev-only native dependencies (e.g. `sharp` via `miniflare`) that never ship in the Worker bundle. Findings confined to that tree are tracked but do not trigger production advisories.
- `vendor/upstream` is a commit-pinned submodule of `gobifrost/bifrost` used as a behavioral reference, not shipped code.
