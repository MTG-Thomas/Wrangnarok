# ADR 012: Phase 2 Trigger investigation — schedules and webhooks

**Status:** Investigation for issue #76. NOT accepted. Implements no code;
constrains later implementation lanes. Defers to ADR 001 (Execution identity,
idempotency) and ADR 010 (OrgCtx, declared requirements) where silent.

## Context

Roadmap Phase 2 asks for "schedules/webhook Triggers" on top of the
HTTP-submit loop. The lexicon defines a Trigger as "an event capable of
starting a Saga" and names HTTP requests and schedules as examples. Upstream
finding 7 (`docs/upstream-spec.md`) adds the invariant worth keeping: events
are source-plus-subscription (schedule, webhook, topic), and a subscription
targets one workflow or agent with metadata/payload carried into execution
context. Upstream finding 3 adds the counterweight: runtime policy
(timeouts, schedules, endpoints, access) is environment state, not Saga
source trivia — so Trigger configuration must never become Saga decorator
metadata.

## Decision direction (not yet decided)

### Webhook Triggers: a thin authenticated route over submit

A webhook Trigger is an HTTP route that authenticates the caller, shapes the
vendor payload into a Saga input, and enters the existing
`POST /api/executions` protocol with a deterministic Idempotency-Key derived
from the vendor event (delivery ID, event ID). Consequences, all already
covered by current contracts:

- Vendor redelivery with the same event ID converges via same-key replay
  (`200 replayed:true`); same key plus different payload answers `409
  IDEMPOTENCY_CONFLICT` instead of forking a second Execution.
- Connection resolution stays exact-org through the OrgCtx; a declared but
  unconfigured Connection fails loud with 424 rather than silently skipping.
- No new Cloudflare primitive: Worker fetch plus the existing submit path.
  HMAC verification (where the vendor signs) is per-Integration request
  normalization inside the Action boundary, not Saga code.

Open before implementation: per-route authentication scheme (fixture Bearer
does not survive multi-tenant webhooks), the key-derivation rule from vendor
event IDs (must satisfy the 16–128 `Idempotency-Key` alphabet), and the
payload-to-input shaping bound (4096-byte input CHECK already applies).

### Schedule Triggers: Cron plus a durable Scheduled state

A schedule Trigger pairs a Cloudflare Cron Trigger (the tick) with a durable
`Scheduled` Execution row (the intent): the tick promotes due rows through
the normal dispatch protocol. `Scheduled` stays what ADR 001 says it is — a
durable pre-publish row distinct from `Pending`, promotable when due — and
is still deferred: this investigation does not introduce it. Blockers,
in order:

1. **Keyless identity.** The deterministic Execution ID hashes
   `(orgId, userId, key)`; a schedule has no client-supplied key. Server-side
   key derivation (schedule ID plus window) or the rejected UUIDv7 plus
   `UNIQUE(idempotency_key)` path from ADR 001 must be settled first —
   whichever it is, it is an identity decision with an ADR, not a Cron
   annotation on a Saga.
2. **Due-time indexing and promotion.** A due index, a promotion claim that
   cannot double-dispatch (same fencing discipline as the submit path:
   single winner, retained-ID dedup), and the `Scheduled`-cancel semantics
   ADR 001 defers.
3. **Policy placement.** Cadence, enabled/disabled, and timezone live as
   persisted per-installation policy (upstream finding 3), never as Saga
   source properties — `buildCatalog` rejects schedule-shaped keys today
   and must keep rejecting them.

### Topic events: deferred

Upstream topic emission/subscription stays deferred per the capability map.
If a concrete multi-Saga fan-out need arrives, it must demonstrate why a
direct Saga-to-Saga submit (ordinary TypeScript calling the submit protocol)
is insufficient before any Queue or Durable Object is earned — per
AGENTS.md constraint 7, the primitive needs the requirement, not the
other way around.

## Consequences of this investigation

- No new primitive, migration, binding, or route in this slice.
- The next webhook lane implements one vendor webhook on the submit protocol
  with its own tests (auth, redelivery convergence, 424 posture) and no ADR
  unless it changes shared contracts.
- The next schedule lane writes the `Scheduled` design (identity first) and
  only then touches Cron.
- Saga source stays free of trigger-shaped metadata; the
  `OPERATIONAL_POLICY_KEYS` rejection list already covers schedule/cron
  keys and needs no change.

## Open questions (options, not decisions)

- Webhook auth model past the fixture (per-Connection secrets vs.
  per-route tokens) — needs the Phase 3 secret-storage decision (ADR 005).
- Whether schedule cadence belongs to the portable bundle or the
  installation (Phase 5 will care; Phase 2 only records the question).
- ExecutionHistory querying for Trigger provenance (which Trigger started
  this Execution) — needs a source-of-trigger field once webhooks exist.
