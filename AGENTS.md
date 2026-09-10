# AGENTS.md

Wrangnarök is an experimental Cloudflare-native reimagining of `gobifrost/bifrost`, licensed AGPL-3.0.

Before changing architecture or domain contracts, read:

- `README.md`
- `docs/lexicon.md`
- `docs/upstream-spec.md`
- `docs/roadmap.md`
- relevant files under `docs/architecture/`

## Non-negotiable project constraints

1. Preserve useful Bifrost product semantics, not its infrastructure by default.
2. The first useful MVP must remain viable on Cloudflare Free.
3. TypeScript is the implementation and Saga-authoring language.
4. Sagas are code-first. Do not invent a YAML/JSON workflow DSL without a demonstrated requirement.
5. Cloudflare primitives retain their native names: Worker, Workflow, step, Queue, Durable Object, D1, R2, KV, binding, etc.
6. The canonical domain vocabulary is `docs/lexicon.md`; do not casually add mythological aliases. In case of conflict, `docs/lexicon.md` prevails over README, roadmap, or ADR summaries.
7. Start with Worker + Workflows + D1. Add another Cloudflare primitive only when a concrete requirement needs it and document why.
8. Prefer boring, typed TypeScript APIs over clever wrappers.
9. Integration definitions and Organization-specific Connections are separate concepts. Never embed environment credentials in portable Saga/Integration source.
10. Organization context and authorization boundaries must remain explicit.
11. Saga identity must survive ordinary source edits.
12. Local development and tests must not require a Cloudflare production deployment.
13. Do not hide Cloudflare behind a portability abstraction. Cloudflare-native is the experiment.
14. Wrangnarök is AGPL-3.0. Preserve attribution/notices when adapting upstream implementation material.

## Development/testing direction

Use Cloudflare's current local tooling rather than hand-written mocks where practical:

- `wrangler dev` / Miniflare / workerd for local Worker execution and bindings;
- local D1 bindings and migrations;
- local Workflows emulation;
- `@cloudflare/vitest-plugin` + Vitest for Worker-runtime tests;
- mock only external vendor HTTP APIs at the Integration boundary.

Keep domain logic independently testable where possible, but include integration tests that exercise the real local Cloudflare runtime/bindings.

## Architecture changes

If a change introduces a new platform primitive, changes Saga/Execution/Operation semantics, changes tenancy/security boundaries, or creates a public compatibility contract, write/update an ADR or architecture spec and link the relevant issue.

## Upstream archaeology

When studying Bifrost, record observable behavior and invariants in `docs/upstream-spec.md`. Do not assume a PostgreSQL/Redis/RabbitMQ/process architecture is itself a requirement. Prefer current upstream docs/tests/source over old plans when they disagree.

## Collaboration

One lane per worktree. Parallel agents (human or AI) must work on separate branches checked out in separate `git worktree` directories — never two lanes in one checkout. Name worktrees after the branch. Remove the worktree (`git worktree remove`) when its PR merges. Git defines no default worktree location, so this project fixes one: create ephemeral lane worktrees under the harness's pre-approved scratch root (`$env:TEMP\opencode`, currently `C:\Users\ThomasBray\AppData\Local\Temp\opencode`), one subdirectory per branch named after the branch (slashes sanitized) — never inside the main checkout.
