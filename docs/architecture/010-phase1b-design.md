# ADR 010: Phase 1b design for #58 — ctx, states, Connections, source boundary

**Status:** Implemented per issue #75 (lane-A, PR #80). Section 1–4 decisions
below are now code; the open questions record the picks the lane made.

## 1. Organization ctx propagation

```ts
type OrgCtx = { orgId: string; userId: string; executionId: string;
  sagaId: string; sagaRevision: string; operationId?: string; attemptToken: string };
```

Flow: admission builds `Principal { orgId, userId }` from local fixture config (never request body/query) → `submit()` hashes `(orgId, userId, key)` to Execution ID → Workflow params carry only `{ executionId }` → each step reloads the immutable D1 Execution row and rebuilds full `OrgCtx` (`attemptToken = executionId + ":" + dispatched`) → Connection resolution and terminal checkpoints consume `OrgCtx`, never caller-supplied org.
Deny-by-absence: every read is `WHERE id = ? AND org_id = ? AND user_id = ?`; miss → `404 EXECUTION_NOT_FOUND` (never 403-with-existence-leak); Saga code receives no cross-org lookup API; Workflow that finds `org_id` mismatch aborts to `persist-failure-v1` without vendor call.

## 2. Execution/Operation state model

Decision: the #15 refusal gate **stays** (`409 RECOVERY_EXPIRED`, 15-min same-revision); `Scheduled` stays deferred and **out** of the CHECK. Rationale: gate bounds re-dispatch ambiguity without inventing success; `Scheduled` needs keyless identity + promotion path with no Phase 1b requirement.
Adopt: explicit `Cancelling` (already in CHECK via `0002`) plus stale-token rejection: every terminal checkpoint is conditional (`WHERE status IN ('Pending','Running')` on executions, `AND status='Running'` on operations); stale/late callbacks (post-cancel, post-terminal, post-revision-change) are rejected no-ops, never overwrites. `Pending` is never swept: no timer, Cron, or reconciler writes `Pending -> Failed`; `Pending -> Failed` only via explicit `failExecution` checkpoint. Owner-cancel wins per ADR 001: once the `Cancelling` marker is written, a racing terminal checkpoint is the stale one and no-ops — the cancel endpoint acknowledges cancellation synchronously, so an acknowledged cancel is never flipped to `Failed` afterward.
Transition table (only legal moves; enforce in `canTransition` + conditional SQL — identical to the ADR 001 table):

```text
Pending    -> Running | Failed | Cancelling
Running    -> Succeeded | Failed | TimedOut | Cancelling
Cancelling -> Cancelled
Succeeded | Failed | TimedOut | Cancelled -> (none; cancel returns 409 EXECUTION_NOT_CANCELLABLE)
```

D1 CHECK sketch (no migration file in this lane; implementation lane authors the next free number — 0003 is taken by usage_blocks):

```sql
-- executions.status CHECK becomes:
CHECK(status IN ('Pending','Running','Succeeded','Failed','TimedOut','Cancelling','Cancelled'))
-- NO 'Scheduled' value. Stale-token fenced in statement WHERE clauses, not CHECK:
-- UPDATE executions SET status=?,... WHERE id=? AND status IN ('Pending','Running') AND attempt_token=?;
```

Operations stay `('Running','Succeeded','Failed')` in both the CHECK and the
`canTransitionOperation` code table; timeout code lives in `error_json`.
Operation writes are fenced (`begin`/`finish` match `Running` rows only), so
a late vendor callback or a re-begin can never overwrite terminal Operation
history. Each vendor step narrows the OrgCtx to its own step
(`withOperation`) so `operationId` names the step doing the work; the stable
outbound `Idempotency-Key` derives from it. The four `prepare-input-v1`
bodies are one shared `prepareExecution` helper. `requiredIntegrations` is
served in `CatalogEntry` discovery; `sagas.manifest.json` is untouched
(steward-owned) and D1 Execution rows need no migration (no query filters on
requirements).

## 3. Integration vs Connection follow-ups

Replaces uniform `CONNECTION_NOT_CONFIGURED`: each Saga declares `required: IntegrationId[]`.
Resolution order per Operation: (1) resolve Integration by stable ID; (2) exact-`org_id` Connection lookup only; (3a) declared-but-missing → fail loud `424 INTEGRATION_REQUIREMENT_UNSATISFIED { integrationId, orgId }` as structured step result → `Failed` (no retry, `NonRetryableError`); (3b) undeclared/optional access missing → return `None`/null to Saga code, no throw, no error row (caller decides fallback/skip).
Shared/default lookup and write boundaries (per upstream finding 11): **no** global/org-cascade fallback in Phase 1b; lookup order is exactly one row (this org), never most-recent-global; Connections are written only via explicit per-org admin/API path, never from Saga/step code; Saga code gets read-only resolved config + transient secret handle.
Stays denied in MVP: cross-org lookup from Sagas, admin cross-org reads from workflow APIs, OAuth/token refresh, scope overrides/subsets, provider-org mapping enumeration.

## 4. Local dev without registration + source-vs-persisted boundary

Fresh checkout + `npm run build:ui` once (Static Assets directory must exist or `wrangler dev` hard-fails) + `wrangler dev` on day one: static code catalog discovers Sagas (id/name/revision in source); local D1 migrations auto-apply; setup script seeds fixture principal (`default` org/user, ignored token file, never overwritten) and one exact-org fixture Connection (`http://127.0.0.1:8788/echo`); submit → run → history works with zero deploy/registration round-trip. Full loop proven in `docs/demo.md` (lane-A local verification, issue #75).
Knob boundary — **source (identity/discovery):** saga id/name/revision, step names/order, integration id/action signatures, declared `required` list, `stepRetryLimit()` code table shape. **Persisted/API-managed (never in decorators):** timeouts (`VENDOR_TIMEOUT_MS`), schedules/due-times, retry ceilings/counts, access grants, Connection config/secrets, per-Execution saga snapshot.
Boundary tests (workerd, real D1/Workflow bindings; vendor HTTP mocked): (a) source rename preserves Execution history/saga_id; (b) timeout value change needs no source edit; (c) declared-missing → 424 with single vendor call; (d) optional-missing → None with Succeeded; (e) cross-org read → 404; (f) stale-token checkpoint after cancel no-ops; (g) expired-window retry → 409 with no resurrection; (h) fresh-checkout seed script is idempotent and never overwrites token.

## Open questions (options, not decisions)

Implementation picks (issue #75):

- `attemptToken` representation: (i) `executionId:dispatched` reuse — no new
  column, no migration. Single dispatch per deterministic ID means one epoch;
  status-fenced conditional writes are the stale-token rejection.
- 424 code name/shape: `INTEGRATION_REQUIREMENT_UNSATISFIED` as a structured
  step result surfacing through `error_json` (Failed, no retry).
- Where declared `required` lives: mandatory `requiredIntegrations` field on
  `SagaDefinition` (source declaration, validated at startup, frozen).
- Retry-ceiling values stay in the `stepRetryLimit()` code table plus
  `VENDOR_TIMEOUT_MS` platform mapping — never Saga source properties.

Still open (explicitly Phase 3+, not this lane):

- `Scheduled` promotion design (keyless identity, due index, Cron) — explicitly Phase 3+, not this lane.
- Whether retry-ceiling values graduate from code table to persisted operator policy — needs #15 owner + Free-tier cost note.
