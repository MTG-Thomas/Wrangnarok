# Wrangnarok project overlay (loaded after AGENTS.md, cached in prompt prefix)

You are working in Wrangnarok: a Cloudflare-native reimagining of `gobifrost/bifrost` (AGPL-3.0). Before changing architecture or domain contracts, read `AGENTS.md`, `README.md`, `docs/lexicon.md`, `docs/upstream-spec.md`, `docs/roadmap.md`, and the relevant files under `docs/architecture/`.

## Session habits

- Keep responses concise (under 5 lines default). Prefer fixing over surfacing.
- Use the `todo` tool for multi-step work. Commit as you go (just your changes).
- One lane per worktree. Never work two lanes in one checkout.
- Native GitHub merge queue is unavailable: Mergify owns merging into `main`. Green PRs need the `automerge` label at creation plus `@mergifyio queue`.

## Jcode-native workflows (use them, they are configured for this repo)

- **Memory**: record durable decisions with `memory remember` (scope `project`, tag `wrangnarok`). Recall at session start for roadmap, ADR, and Integration/Connection context. Memory sidecar is off globally; explicit remember/recall keeps the cache prefix stable.
- **Swarm**: use `swarm` for parallel lanes (`label` always, e.g. `label: "phase2 triggers"`). Workers inherit this overlay plus `.jcode/swarm-prompt.md` lane rules. Use DM for 1:1, broadcast sparingly. File-conflict notices are automatic; check diffs before ignoring.
- **Todos**: rate confidence at assignment and completion. Confidence spikes mean go back and verify. Keep incomplete todos; auto-poke keeps headless `jcode run` iterating until they are done.
- **Side panel**: load `ExecutionDetail` output, Saga catalog diffs, and `docs/upstream-parity.md` slices into the side panel for live review.
- **Browser**: use the `browser` tool (Firefox Bridge) to verify the React client in `client/` against a local `wrangler dev` Worker, never a production deployment.
- **KV cache**: keep the prompt prefix stable and append-only. Dynamic context (memory recalls, reminders) goes late. `/cache stats` shows hit rate; the 5m/1h TTL toggle is Anthropic-only and irrelevant on other providers.

## Verification (repo-native, in order)

1. `npm run typecheck` (3 tsc passes: Worker, client, test)
2. `npm test` (Vitest + `@cloudflare/vitest-plugin`, real local workerd/D1/Workflow bindings; mock vendor HTTP only at Integration boundary)
3. `npm run build:ui` then `npm run check:bundle` (budget 102400 bytes)
4. `npm run preview:smoke` for the local execution slice
