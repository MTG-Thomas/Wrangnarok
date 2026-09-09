# ADR 006: Boring names for load-bearing concepts

- **Status:** Accepted
- **Date:** 2026-09-09
- **Applied as the mechanical rename sweep on 2026-09-09; `docs/lexicon.md` now matches this ADR.**

## Context

Wrangnarök's naming rule (`docs/lexicon.md:5-11`) is correct: Cloudflare owns
infrastructure nouns. The open question is whether each Wrangnarök domain noun
prevents a collision or captures an invariant Cloudflare lacks — or merely
re-skins an industry-standard term at onboarding cost.

Review criteria per term:

1. Does it avoid collision with a Cloudflare noun?
2. Does it capture a product invariant absent in Cloudflare?
3. Does it avoid collision with other industry meanings?
4. Is the onboarding cost justified?

## Decision (proposed)

| Current | Verdict | Proposed | Rationale |
| --- | --- | --- | --- |
| Saga | **Keep** (with note) | Saga | Captures "stable automation identity ≠ Workflow class/binding" (ADR 002). But `saga` already means compensating-transactions pattern — add one-line disambiguation to lexicon. |
| Operation | **Keep** | Operation | Avoids collision with Cloudflare `step`/`WorkflowStep`; carries retry/idempotency contract (ADR 001). `Step` would collide. |
| Connection | **Keep** | Connection | Boring already; industry-standard for configured organization credential state. |
| Trail | **Rename** | ExecutionHistory | Audit-history surface. `ExecutionHistory` needs no glossary; `Trail` is flavor tax. Code/identifier: `execution_history`, `executionHistory`. |
| Journey | **Rename** | Execution | Real invariant is "D1 record + Workflow instance duality with organization context" (ADR 001). `Execution` says it; upstream says executions. `Journey` poeticizes. |
| Realm | **Rename** | Integration | Upstream says Integration; no Cloudflare collision to avoid. Keep the code-vs-state split as `Integration` (portable code) vs `Connection` (organization state). |
| Grove | **Rename** | Organization | Hard auth boundary must read as one, in upstream's own word. `Organization` chosen over `Tenant` per review: matches Bifrost `organizations`, `org_id` identifiers, and existing platform language. `Grove` softens it. |
| Signal | **Rename** | Trigger | `Trigger` already means "first-class starter, not cron metadata". `Signal` collides with Temporal in-flight signals. |
| Yggdrasil | **Drop** | Catalog | ADR 002's static catalog is exactly a catalog. `Yggdrasil` risks becoming a junk-drawer synonym for "the app". |
| Acorn | **Drop** | MVP slice | Removed from repo language. The milestone is Phase 0 MVP slice; do not use Acorn in prose, identifiers, or tests. |
| Squirrel | **Keep as joke-only** | — | Never an execution primitive (`lexicon.md:88-92`). Unchanged. |

Organization terminology note: `Organization` == tenant boundary. Prefer `org_id`
in D1/API identifiers to match upstream `org_id` usage; `tenant` acceptable in
prose only when discussing multi-tenancy generically.

## Rename diff (preview; apply on Accept)

Files carrying the old vocabulary (exact scope from `rg` at time of writing):

- `README.md` — Working vocabulary table (9 rows) + MVP bullets + architecture diagram labels.
- `docs/lexicon.md` — full rewrite of Domain terms per table above; move `Yggdrasil` to removed; add Saga disambiguation line.
- `AGENTS.md` — constraints 9, 10 (Realm/Connection, Grove context) reworded.
- `docs/roadmap.md` — Phase 0/1/3 bullets (Organization stub, Connection resolution, Trigger schedules).
- `docs/upstream-spec.md` — capability table rows + invariants 3, 4, 6.
- `docs/architecture/001-execution-model.md` — heaviest: Journey→Execution throughout (state model, D1 `journeys`→`executions` table sketch, `journeyId`→`executionId`, Journey record fields), Grove→Organization, Signal→Trigger, Trail→ExecutionHistory.
- `docs/architecture/002-saga-identity.md` — Saga stays; references to Signals/history callers updated.
- `docs/architecture/003-realms-connections.md` — retitle to `003-integrations-connections.md`; Realm→Integration throughout; Grove→Organization.
- `docs/architecture/004-ci-cd.md` — `system.smoke` organization isolation + Trigger wording.
- `docs/architecture/005-secret-storage.md` — Realm→Integration, Grove→Organization.
- `docs/testing.md` — Journey→Execution, Grove references.

Mechanical rules for the rename commit:

1. `Journey` → `Execution` (`journeys` table → `executions`, `journeyId` → `executionId`, `Journey record` → `Execution record`).
2. `Realm` → `Integration` (`realm` identifiers → `integration`; `ctx.realms.*` illustrative API → `ctx.integrations.*`).
3. `Grove` → `Organization` (`grove_id` → `org_id`, `default` stub → `default` organization, `grove_system_smoke` → `org_system_smoke`).
4. `Signal` → `Trigger` (cron/webhook/topic triggers).
5. `Trail` → `ExecutionHistory` (`trail` identifiers → `execution_history`; `Trail/observability linkage` → `ExecutionHistory/observability linkage`).
6. `Yggdrasil` → `Catalog` (static Saga catalog).
7. Code/identifier rule from lexicon (`wrangnarok` ascii) unchanged.
8. Keep `Saga`, `Operation`, `Connection`.

## Consequences

- Onboarding cost drops: six glossary mappings removed for anyone arriving from Bifrost/Cloudflare/Temporal backgrounds.
- Tenancy reads as safety-critical (`org_id`, isolation tests) in upstream's own word rather than flavored.
- Diff is large but mechanical; history survives (no Cove data yet — spec-only repo, no D1 migrations to write).
- Upstream-spec alignment improves: Integration/organization/trigger/execution/execution-history match observable Bifrost language; Wrangnarök diffs remain explicit where Cloudflare changes the model.

## Alternatives considered

- Keep all cute names for brand distinctiveness. Rejected: brand is carried by `Wrangnarok`/`Wrangnarök` + `Saga`, not by renaming organization, trigger, and history.
- Rename `Saga` too (to `Automation`/`WorkflowDefinition`). Rejected for now: Saga captures the identity-vs-binding invariant and is cheap to disambiguate with one line.
