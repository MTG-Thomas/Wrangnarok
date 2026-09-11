# Preferred tools for Wrangnarok

Prefer repo-native, cache-friendly tools. Keep the prompt prefix stable.

## Always prefer

- `agentgrep` over bare grep for code search (structural context, less output).
- `read` for files, `bash` with `cmd.exe` syntax for commands (Windows host).
- `todo` for multi-step work with confidence ratings.
- `memory` (explicit remember/recall, scope `project`, tag `wrangnarok`) for durable roadmap, ADR, and Integration/Connection context.
- `swarm` for parallel lanes (always pass `label`).
- `side_panel` for ExecutionDetail, Saga catalog, and parity-map review.
- `browser` (Firefox Bridge) for verifying `client/` against local `wrangler dev`, never production.

## Cloudflare-local first (per AGENTS.md)

- `wrangler dev` / Miniflare / workerd for Worker execution and bindings.
- Local D1 bindings and migrations, local Workflows emulation.
- `@cloudflare/vitest-plugin` + Vitest for runtime tests.
- Mock only external vendor HTTP at the Integration boundary.

## Avoid

- Hand-written Cloudflare mocks when local tooling works.
- Bare `curl` in PowerShell (alias trap); use `curl.exe`.
- Git Bash for `git <rev>:.dotpath` reads (MSYS rewrites args); use `cmd` or read from a checkout.
- Long dense lane-drive messages over HTTP (intermittent 500); keep short.
- Production deployments for local verification.
