---
name: mtg-architecture-hygiene
description: Use for focused architecture reviews of codebases, modules, workflows, integrations, boundaries, testability, duplication, domain language, and docs/code drift.
---

# MTG Architecture Hygiene

Use this skill to find small architecture improvements that make future work safer and easier.

## Review Lens

Prefer findings that improve:

- module depth: small interface over meaningful behavior;
- interface clarity: callers know only the invariants, error modes, config, and ordering they actually need;
- concern separation: API/client/workflow/operator concerns stay separated;
- testability: important behavior can be exercised without live services;
- observability: failures expose useful status, ids, and evidence paths;
- domain language: names match the repo and operator vocabulary;
- maintainability: duplicated integration logic has a clear home.

Use this vocabulary precisely:

- `Module`: anything with an interface and an implementation: function, class, package, workflow slice, or integration adapter.
- `Interface`: everything a caller must know to use the module correctly, not just type signatures or public methods.
- `Depth`: leverage at the interface. A deep module gives callers more behavior per fact they must learn.
- `Locality`: change, bugs, and verification concentrate in one place instead of spreading across callers.
- `Seam`: the place an interface lives and behavior can vary. Use this term only when variability or test substitution is the point.
- `Adapter`: a concrete implementation that satisfies an interface at a seam.
  Use it for the role something fills, not for every implementation detail.

## Workflow

1. Establish scope.
   - Identify the repo/module/workflow under review and what is intentionally out of scope.
   - Check working tree status before proposing edits in a repo.

2. Read the system shape.
   - Inspect entry points, core domain modules, integration clients, tests, docs, and recent changes.
   - Use `rg`/`rg --files` first for navigation.

3. Look for high-signal improvements.
   - Shallow module: many callers know nearly as much as the implementation.
   - Leaky integration: auth, retry, pagination, or payload details spread across workflows.
   - Missing seam for tests: live API required for basic behavior.
   - Drift: docs, names, or issue language disagree with code.
   - Agent churn: generated helper layers that obscure simple behavior.
   - Pass-through wrapper: a module whose deletion would remove complexity instead of concentrating it.
   - Refactor smells: long methods, duplicated logic, large classes/modules,
     long parameter lists, primitive obsession, magic constants, nested
     conditionals, dead code, or inappropriate coupling.

4. Apply the depth tests.
   - Deletion test: if deleting a module makes complexity vanish, it may be a pass-through; if complexity reappears across callers, it was earning its keep.
   - Interface test surface: callers and tests should cross the same interface for important behavior.
   - Variation test: one adapter is hypothetical flexibility; two adapters or a clear test substitute make the seam real.
   - Dependency placement: accept dependencies at the seam when callers need
     variation; avoid creating hard-coded collaborators inside behavior that
     must be tested.
   - Internal seams: allow private seams inside a deep module for its own
     implementation tests, but do not leak those seams into the public
     interface unless callers need them.

5. Rank by value and blast radius.
   - Prefer small refactors with immediate verification.
   - Separate speculative redesign from actionable cleanup.
   - Do not implement unless the user asked for changes.
   - Surface ADR conflicts only when the observed friction is strong enough to justify revisiting the decision.

6. If implementing, slice the work.
   - Make one architectural improvement at a time.
   - Preserve public behavior.
   - Prefer extract function/module, rename for domain clarity, introduce a
     small type/value object, or replace conditionals with a simple strategy
     only when tests or call sites make the behavior boundary clear.
   - When a design decision has several plausible seams, sketch at least two
     interface shapes and compare them on depth, locality, test surface, and
     real adapter count before choosing.
   - Run focused tests and document any unverified residual risk.

## Output Shape

Lead with findings:

```markdown
Finding:
Evidence:
Impact:
Recommended slice:
Verification:
```

If no worthwhile changes are found, say so and name any test or evidence gaps.
