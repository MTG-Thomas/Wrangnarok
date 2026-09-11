---
name: mtg-grill-with-docs
description: Use for broad, ambiguous, design-heavy, cross-repo, risky, or durable-knowledge work that needs clarification, assumption checks, docs, ADRs, or issues.
---

# MTG Grill With Docs

Use this skill to turn a fuzzy plan into shared understanding before implementation.

## Workflow

1. Identify the decision surface.
   - Name the intended outcome, affected users/operators, repo or system boundary, and likely blast radius.
   - Separate facts already evidenced from assumptions that need confirmation.

2. Ask only high-value questions.
   - Ask at most 3 questions at once.
   - Prefer questions that decide scope, risk, acceptance criteria, or ownership.
   - If a reasonable low-risk assumption exists, state it and proceed instead of blocking.

3. Grill the plan.
   - Look for hidden states, rollback paths, auth/config dependencies, data migration needs, observability, and test venues.
   - For operational work, distinguish read-only inspection from mutation.
   - For PR work, keep maintainer trust in view: small scope, clear verification, no unrelated churn.

4. Capture durable context only when it pays rent.
   - Use existing repo docs first: `CONTEXT.md`, `docs/adr/`, `docs/runbooks/`, issue bodies, or implementation notes.
   - Do not duplicate public platform docs; record repo-specific decisions, names, constraints, and evidence paths.
   - If editing docs, keep additions compact and useful to a competent newcomer.

5. Convert into an executable next step.
   - Produce a short plan, issue draft, PRD, ADR note, or implementation checklist.
   - Include acceptance criteria and verification commands when known.

## Output Shape

For chat-only alignment, respond with:

- `Understanding`: one paragraph.
- `Open decisions`: only unresolved blockers.
- `Proposed path`: 3-6 concrete steps.
- `Durable notes`: where context should be saved, or `none`.

When the user asks to proceed, implement the smallest useful slice and update any promised artifact.
