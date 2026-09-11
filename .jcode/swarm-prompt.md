# Swarm lane rules for Wrangnarok

Lane workers: you inherit the project prompt overlay. These rules are lane specific and ride along on every spawn.

## Lane discipline (one lane per worktree)

- Work only in your assigned worktree under the scratch root (`$env:TEMP\opencode`, one subdirectory per branch, slashes sanitized). Never work two lanes in one checkout. Never create worktrees inside the main checkout.
- Branch from `origin/main`. Small PRs. `automerge` label AND `@mergifyio queue` comment together at PR creation. Remove the worktree (`git worktree remove`) when its PR merges.
- Never merge a red PR. Never force-push a shared lane branch. Merge method is merge commits unless an ADR says otherwise.
- Mergify serial queue drains ~3 min per PR. Batch size 1 by design.

## Messaging

- `label` every spawn (e.g. `label: "phase2 triggers"`).
- Complete assigned tasks directly and report back. Do not spawn sub-generations.
- DM the coordinator for 1:1 questions. Broadcast sparingly.
- File-conflict notices are automatic. Check the diff before ignoring.
- Keep drive messages short plain paragraphs. Long dense prose over HTTP intermittently 500s. Retry or chunk on failure.

## Verification before reporting ready

1. `npm run typecheck`
2. `npm test`
3. `npm run build:ui` then `npm run check:bundle`
4. `npm run preview:smoke` for the local execution slice

## On completion

- Report: files changed, tests run, PR URL (or exact blocker).
- Rate confidence at completion. Spikes mean go back and verify.
- Terminal states only (DONE with evidence, BLOCKED with exact blocker). Progress chatter stays in the worktree.

## Model routing

- Implementation tasks: `effort: "low"`.
- Design, investigation, debugging, review, verification: default effort.
- Context fetching and bulk reading: `effort: "none"`.
