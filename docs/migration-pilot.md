# Migration pilot (issue #119)

Proof that a `bifrost-workspace` workflow can become a Wrangnarok Saga.
Pilot: `workflows/sample/hello_world.py` → `hello` (`hello-v1`).

## Construct mapping

| Workspace (`hello_world.py`) | Wrangnarok (`src/sagas/hello.ts`) |
| --- | --- |
| `@workflow(id="24f8f523-…")` | Stable Saga UUID `395e15f0-…` in `src/domain.ts` + `sagas.manifest.json` (ADR 002; UUIDs are not shared across systems, the mapping is recorded here, not derived) |
| `category="Examples"` | Catalog `tags: ["examples", "pilot"]` (discovery metadata only) |
| Typed signature `(name: str)` | `HelloInput` + `parseHelloInput` (400 `INVALID_INPUT` on violation) + JSON `inputSchema` |
| `return {"greeting": …, "name": …}` | `HelloResult` + `outputSchema`; terminal `result_json` |
| Bifrost durable execution | Cloudflare Workflow (`HelloWorkflow`, `HELLO_WORKFLOW` binding) + D1 `executions`/`operations` rows |
| Logging | `prepare-input-v1` / `greet-v1` Operation history (no log scraping) |

## Deliberate divergences

- No emoji in the greeting: boring outputs over workspace flavor.
- Input bound (1–1024 UTF-8 bytes) mirrors the echo message bound; a dedicated name bound waits for a real author-facing need.
- No usage block: only `system.smoke` emits Free-tier telemetry today.

## Gaps this pilot does not close

- Tables (M2, #117) and Forms binding (M3, #118): the pilot takes raw JSON input.
- Manifest bridge (M1, #116): the pilot is hand-pinned, not converted.
- Second pilot with a real Integration call (read-only NinjaOne workflow) once M1 lands.

