---
name: mtg-testing-strategy
description: Use for test strategy across coverage, mutation, property-based, fuzzing, metamorphic, contract, stateful, acceptance, test doubles, and meaningful-suite design.
---

# MTG Testing Strategy

Use this skill to choose the next most valuable testing layer, not to chase
coverage for its own sake.

## Core Principles

- Test behavior through public interfaces. Prefer tests that survive internal
  refactors.
- Work in vertical slices: one behavior, one failing test or explicit evidence
  gap, one implementation or test improvement, then repeat.
- Coverage is a map, not a goal. Use it to find blind spots, then ask whether
  those blind spots matter.
- Mutation testing is the sanity check for whether assertions are strong.
- Prefer real code paths and fakes over mocks of internal collaborators.
- Keep live-service tests separate from deterministic local tests.

## Testing Ladder

Use the lowest layer that can catch the risk clearly:

1. Unit or module tests for pure logic, parsing, normalization, validation, and
   retry/backoff decisions.
2. Integration tests for adapters, persistence, message boundaries, auth/config
   handling, and payload contracts.
3. Contract tests for external APIs, workflow inputs/outputs, webhook payloads,
   and serialized artifacts.
4. Property-based tests for broad input spaces and invariants.
5. Metamorphic tests when exact expected output is hard but relationships should
   hold across transformed inputs.
6. Stateful or model-based tests for lifecycles, queues, retries, ticket states,
   rollout ledgers, and workflow execution state.
7. Acceptance or E2E tests for critical user/operator workflows only.
8. Live smoke tests for vendor/platform behavior that cannot be represented
   locally. Keep them explicit, narrow, and credential-aware.

## Workflow

1. Identify the risk.
   - Bug class, behavior, workflow, integration boundary, or regression being
     protected.
   - What would a real failure cost: customer impact, data drift, noisy tickets,
     missed backup, bad rollout, bad PR, or just inconvenience?

2. Inspect existing tests and run commands.
   - Use repo-native commands first: `pytest`, `npm test`, `uv run pytest`,
     `tox`, `nox`, or project scripts.
   - Read coverage config before adding new tools.
   - Separate deterministic tests from live vendor/API tests.

3. Choose the next layer.
   - Missing behavior coverage: add behavior-focused tests.
   - Weak assertions: run or introduce mutation testing.
   - Many edge cases: use property-based tests.
   - Hard oracle: use metamorphic tests.
   - Lifecycle risk: use stateful/model-based tests.
   - External boundary drift: add contract tests or recorded fixtures.

4. Design the test.
   - Name the behavior in domain language.
   - Cross the same interface production callers use when practical.
   - Prefer fixtures, fakes, and deterministic clocks over sleeping, live calls,
     or internal mocks.
   - Keep one assertion story per test; split unrelated behavior.

5. Verify the test proves something.
   - New behavior test: watch it fail for the expected reason before making it
     pass when implementing production code.
   - Regression test: reproduce the bug or construct the minimal failing case.
   - Coverage test: inspect uncovered lines and add assertions for meaningful
     branches.
   - Mutation test: treat surviving mutants as weak or missing assertions.

6. Record residual risk.
   - Say what is covered, what is intentionally not covered, and what requires
     live validation.
   - For live tests, report execution ids, status codes, model counts, ticket
     ids, or other non-secret evidence.

## Python Defaults

- Use `pytest` for normal tests.
- Use `pytest-cov` to locate blind spots, not as a substitute for review.
- Use `mutmut` for mutation testing when Python code has meaningful branch or
  decision logic.
- Use `hypothesis` for property-based and stateful tests.
- Use `freezegun` or injectable clocks for time behavior.
- Use `responses`, `respx`, local fakes, or recorded fixtures for HTTP clients.

Suggested progression:

```text
pytest -> pytest --cov -> mutmut run -> targeted Hypothesis/property tests
```

## Test Doubles

Choose doubles intentionally:

- Dummy: passed only to satisfy a signature.
- Stub: returns fixed data.
- Fake: working lightweight implementation, preferred for repositories,
  queues, clocks, and vendor clients.
- Spy: records calls for later assertions.
- Mock: pre-programmed expectations; use sparingly at system boundaries.

Avoid mocks that mirror implementation internals. If a test needs many mocks,
look for a better interface or a fake.

## Output Shape

For strategy reviews:

```markdown
Risk:
Current evidence:
Recommended next layer:
Test design:
Commands:
Residual risk:
```

For implementation work, report the tests added or changed, the command output
that proves them, and any live validation still needed.
