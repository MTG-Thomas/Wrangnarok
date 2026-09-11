---
name: lane-ops
description: Coordinate parallel agent lanes with jcode swarm plus mailbox and GitHub as the bus. Use when spawning lane workers, messaging sessions, watching lane runs, or retiring lanes.
---

# Lane Ops (jcode swarm edition)

Run parallel agent lanes natively. Three channels, each with a fixed job:

- **Swarm** (native): spawn workers, DM/broadcast, file-conflict notices. Workers inherit `.jcode/prompt-overlay.md` plus `.jcode/swarm-prompt.md` lane rules. Always pass `label` on spawn (e.g. `label: "phase2 triggers"`). Prefer micro-tasks with verifiable replies over long autonomous briefs.
- **Mailbox**: async notes to harness-driven live threads (they poll at turn boundaries). Notes by default; `steer` permitted ONLY on terminal states (DONE with evidence, BLOCKED with exact blocker), steward-only otherwise, `[STEER]` subject prefix, cooldown until ack or 15 min. Steer attaches to the recipient's next tool result; it does NOT preempt mid-call, and nothing wakes an idle harness loop — turn-boundary polling remains the delivery moment. There is no true event ingress to a live harness thread; design around it (short polls, terminal-state steers).
- **GitHub**: durable record (tracking issues, progress comments, PRs). Passwords and secrets NEVER go on GitHub; distribute via mailbox.

Lane server history (opencode `:4097`, see `scripts/LaneOps.psm1`): the old HTTP spawn/drive path (`POST /session`, `prompt_async`, `noReply`, blocking message drives, first-message model rule, 500-on-dense-prose retries) is retained in the script for the still-live overnight lanes only. New lanes use `swarm` — do not extend the HTTP path.

## Merge-queue recovery runbook

Green + `automerge` + CLEAN but Merge Queue `skipping`? Read the queue check summary via `Watch-LaneQueue` (parses `Mergify Merge Queue` output, names the exact blocking item). Known causes, in order:

1. **Mergify stale `conflict` flag** (seen live): GitHub says `mergeable=true/clean`, Mergify still demands `-conflict`. Force a fresh evaluation with close/reopen (`gh pr close N` + `gh pr reopen N`); the recorded queue request is then honored within a minute. No history pollution. Empty commits are the fallback, not the default.
2. **Behind after a main move**: the auto-update rule merges main into conflict-free `automerge` PRs. If it loses the event race, update the branch manually (GitHub UI or merge locally) and tick the queue checkbox once; Mergify records it ("no need to run the command again").
3. **Red non-required checks** (e.g. AI code-scan model outages): noise. Only `Validate` gates the queue; ignore the rest.
4. **Real conflict (DIRTY)**: lane work — merge main, resolve keeping both slices green, push, re-queue. Never force-push a shared lane branch.
5. **Auto-queue silently not firing** (seen live 4 of 4: green + `automerge`, queue says "can be added" indefinitely). Auto-queue-on-label is decorative; do not depend on it. PR creation standard: `automerge` label AND `@mergifyio queue` comment together at open (Mergify registers intent and merges when green — no waiting period). Repost the comment if a green PR is somehow still unqueued; it dedups.

## Driving lanes

- Prefer micro-tasks with verifiable replies over long autonomous briefs.
- Workers complete assigned tasks directly and report back; no sub-generation.
- File-conflict notices are automatic; check diffs before ignoring.
- One lane per worktree: branch from `origin/main`, worktree under the scratch root (never inside the main checkout), small PRs, `automerge` at creation, remove worktree on merge. Never merge red, never force-push.
- Keep drive messages SHORT (single paragraphs, plain phrasing).

## Stewardship & retirement

- Fixed lanes need a guard list (paths owned by active human/steward lanes). Collision = mailbox the owner, do not touch. No merge-infra changes without ADR. No production deploys (local + CI only).
- Retire: delete merged local branches (`git branch -d`, safe-delete only), prune stale remote-tracking refs (GitHub auto-deletes merged heads), remove merged worktrees. Keep active + bot lanes. Dead mailbox letters have no withdraw API; record and ignore.

## Goal comms discipline (adapted from pi goal-bus)

Goals announce ONLY terminal transitions (complete / new blocker). Progress chatter never posts — that is the entire point. Rules:

- Keep a seen-file per coordinator: goal id → {status, announcedComplete, announcedBlockers[]}. First sight records silently (unless already complete — announce once). New blockers announce once each. Completion announces once. Everything else is silence.
- Route by explicit goal→thread link; unlinked goals fall back to broadcast (goals are rare; no spam risk).
- Delivery is poll-based (mailbox / issue bus). Bookkeeping must never break a turn: check-then-send via `Test-GoalTransition`, send via the normal mailbox tool.
