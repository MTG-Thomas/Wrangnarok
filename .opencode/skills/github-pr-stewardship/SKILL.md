---
name: github-pr-stewardship
description: Use when publishing, opening, stewarding, monitoring, fixing, or merging GitHub pull requests. Midtown PRs default ready-for-review unless the user asks for draft.
---

# GitHub PR Stewardship

Use this skill for end-to-end PR lifecycle work: publishing a branch, opening a pull request, promoting an existing draft, and watching review and CI until it is safe to merge.

Do not route Midtown PR publishing through the curated `github:yeet` skill. Its draft-first default is not the local norm.

Midtown default: open full pull requests ready for review. Do not create draft PRs for Midtown/MTG work unless the user explicitly says draft, WIP, spike, sketch, or equivalent. If an agent accidentally opens a draft PR, mark it ready immediately once the intended branch/PR is confirmed.

## Boundaries First

- Identify the exact repository, PR number, base branch, head branch, and whether the target is a fork or upstream.
- Respect the user's repo boundary literally. If they say "our fork", do not open or mutate upstream PRs.
- Before mutating, inspect `git status -sb`, remotes, current branch, and PR metadata.
- Prefer `gh` for fork/cross-repo edge cases. Use the GitHub connector when it cleanly supports the requested mutation.
- Keep status checks read-only. A request to steward a PR is authorization to fix requested changes and merge once the PR is green, unless the user says read-only, no-merge, monitor only, or names a narrower boundary.

## Publish Or Open A PR

Use this flow when the user asks to push a completed branch, open a PR, or steward your PR after local work:

1. Inspect scope:
   - `git status -sb`
   - `git diff --stat`
   - `git remote -v`
   - `gh repo view --json nameWithOwner,defaultBranchRef,url`
2. If the working tree is mixed, stage only the intended paths. Do not silently stage unrelated user changes.
3. Commit only when there are intended local changes that are not already committed.
4. Run the smallest relevant verification before pushing, unless already run in the current turn.
5. Push with tracking:
   - `git push -u origin $(git branch --show-current)`
6. Open the PR ready for review by default:
   - `gh pr create --fill --head $(git branch --show-current) --base <base>`
   - Do not include `--draft` unless the user explicitly requested a draft PR in this turn.
   - Use `--draft` only when the user explicitly says draft, WIP, spike, sketch, or equivalent.
7. Re-read the PR:
   - `gh pr view <number> --json url,title,isDraft,state,baseRefName,headRefName,mergeStateStatus,reviewDecision,statusCheckRollup`
8. If the PR was accidentally created as draft, immediately mark it ready unless the user asked for draft:
   - `gh pr ready <number>`

Report the PR URL, branch, commit, verification, and any exact blocker.

## Promote A Draft PR

1. Confirm the PR is the intended one:
   - `gh pr view <number> --repo <owner/repo> --json url,title,isDraft,state,baseRefName,headRefName`
2. Mark ready:
   - Prefer connector mark-ready when it works.
   - Fallback: `gh pr ready <number> --repo <owner/repo>`.
3. Re-read PR metadata and report whether CI/review has started.

## Monitor CI And Review

Inspect these surfaces each pass:

- PR metadata: `isDraft`, `mergeStateStatus`, `reviewDecision`, `state`.
- Status checks: `statusCheckRollup`; distinguish pending, skipped, success, failure.
- Review submissions and unresolved review threads.
- Top-level PR comments when CodeRabbit or reviewers leave non-threaded feedback.

Report only meaningful deltas:

- new failure or blocker
- new requested change
- fix pushed
- all checks passed but waiting for review
- merge completed

Name exact blockers and smallest safe next actions.

## Watch Short Waits In-Session

Use this instead of sleep loops when the user asks to wait on a live PR in the current session ("watch this to green"). Prefer `gh`'s blocking watch over hand-rolled sleeps; no model turns burn while it blocks.

1. Block on checks, not on wall-clock guesswork:
   - `gh pr checks <number> --watch -i 30 --fail-fast` for the whole PR, or `gh run watch <run-id> --exit-status -i 10` for one run.
   - Set the tool timeout generously (10+ minutes for real CI). A killed watch is a missed green, not a failure.
2. When the watch returns, run one Monitor pass and act:
   - green → Merge Rules.
   - red → Fix Requested Changes, push, re-watch.
3. Stop on stall, with an absolute backstop: if 2 consecutive rounds end with the same unresolved failure and no new information, report deltas and stop. 5 watch-fix cycles is the absolute maximum — do not start a sixth unprompted.
4. Stop immediately and report when: a fix needs a design decision, the user interrupts, or the session is ending (state the PR number and last status so the next session resumes cleanly).
5. Never use this for detached or standing monitoring (laptop closed, hours-long waits, multi-PR sweeps). That is Heartbeats And Automations territory. A watch dies with its session and retries nothing.

## Fix Requested Changes

When the user has authorized fixes:

1. Read the review comment and surrounding code before editing.
2. Keep changes tightly scoped to the review feedback.
3. Do not revert unrelated local or user changes.
4. Run the smallest relevant verification, then broader checks if the fix touches shared behavior.
5. Commit with a terse message and push to the PR branch.
6. Reply or summarize what was addressed when useful.

## Merge Rules

Stewarded PRs should be merged automatically when all are true:

- The user asked to steward the PR, or otherwise explicitly authorized merging it.
- Required checks are passing or intentionally skipped under repo policy.
- There are no active requested changes or unresolved blocking review threads.
- Code review is green: approved, no review required, or no blocking review policy is configured.
- The PR is mergeable.
- The repository target is the one the user authorized.

Do not auto-merge if the user said read-only, no-merge, monitor only, or asked to pause for human review. Use the repository's normal merge method unless the user specifies one. After merge, report the merge SHA and any residual follow-up. Do not delete branches unless the user asks.

## Heartbeats And Automations

Use a heartbeat when the user wants this current thread to wake up soon and continue stewarding one PR. Use a cron automation only for detached standing monitors.

Heartbeat prompt essentials:

- Exact repo and PR number.
- Allowed actions: inspect, fix requested changes, push updates, merge when green unless explicitly forbidden.
- Forbidden actions: upstream PRs, unrelated repos, deploys, branch deletion unless requested.
- Output: concise status, exact blocker, smallest safe next action.

For standing cron monitors, default read-only and encode repo ownership boundaries clearly.
