# Steward checklist (recurring simplicity review)

Run every 5th merge to `main` and on any ADR-level change. Record the outcome as a comment on the umbrella issue (#132) or the relevant ADR.

## One-diagram test

Draw (or update) the single platform diagram. It must show exactly one authoritative path each for:

1. Authentication / authorization
2. Execution (Saga -> Execution -> Operations)
3. Persistence (D1 schema ownership, migrations)
4. Secrets (registration, storage, scrubbing, tripwires)
5. Deployment (bundle install, activation, rollback)
6. Recovery (failure modes, retries, cancellation, restore)

## Pass criteria

- One path per concern, named files + tests as evidence.
- No "depending on which feature landed when" branches.
- Migration numbers owned by the steward; no duplicate or skipped numbers.
- Every lane scope file current; no repeated out-of-scope touches.
- LIMITS-01 classifications current (free / paid-adaptation / redesign / unresolved).

## Failure action

Pause new parity lanes. Open a consolidation issue naming the duplicated paths and the single surviving design. Resume fan-out only when the diagram is single-pathed again.

## History

- 2026-09-11: checkpoint adopted per #193. Baseline: auth spine (AUTH-01 merged, AUTH-02 in flight), runtime policy (RUN-01/02), schedules (TRG-01), connections (CON-01), single D1 schema with steward-owned numbering, SEC-01 scrub baseline, Solution activation via SOL-01.
