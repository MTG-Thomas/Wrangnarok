# Migration pilot (issue #119, MIG-02)

Proof that a `bifrost-workspace` workflow can become a Wrangnarok Saga.
Pilot: `workflows/sample/hello_world.py` → `hello` (`hello-v1`).

Upstream baseline: `gobifrost/bifrost@3543c7e` (`api/bifrost/decorators.py`,
`api/bifrost/cli.py`).

## Registered-ID mapping

The `@workflow` decorator carries identity-only metadata and no stable id;
stable identity exists only after registration. The pilot records the mapping
explicitly (never derived):

- workspace source `workflows/sample/hello_world.py` (decorator metadata only,
  no stable UUID) → registered Saga UUID
  `395e15f0-3627-41f6-8922-008ce37e3b35` (`hello`, `hello-v1`).
- The UUID lives in `src/domain.ts` (`helloSaga`), the Saga definition in
  `src/sagas/hello.ts` (`helloSagaDef`), the catalog entry via
  `src/sagas/index.ts` (`SAGA_DEFINITIONS`), and the churn snapshot in
  `sagas.manifest.json`. `test/saga-contract.test.ts` fails closed on any
  drift between the four.

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

## Acceptance proof (local API + history)

- `test/hello.test.ts` runs the pilot end to end on the real local runtime:
  `GET /api/sagas` lists `hello`; `POST /api/executions` accepts
  `{ sagaId: 395e15f0-…, input: { name: "Ada" } }` with 202 plus a
  `Location` receipt; the `HelloWorkflow` instance completes;
  `GET /api/executions/<id>` reports `Succeeded` with
  `{ greeting: "Hello, Ada!", name: "Ada" }` and Operations
  `prepare-input-v1` + `greet-v1` both `Succeeded`, with zero outbound fetch.
- Invalid names (`""`, non-string, wrong key) answer 400 `INVALID_INPUT`.
- History visibility: the Execution persists `saga_id`/`saga_name`/
  `saga_revision` plus input/result/Operations rows, so
  `GET /api/executions?sagaId=395e15f0-…` surfaces the pilot run through the
  standard history query path (`test/history.test.ts` proves the filters).

## Gaps this pilot does not close

- Tables (M2, #117) and Forms binding (M3, #118): the pilot takes raw JSON input.
- Manifest bridge (M1, #116): the pilot is hand-pinned, not converted.
- Second pilot with a real Integration call (read-only NinjaOne workflow) once M1 lands.

