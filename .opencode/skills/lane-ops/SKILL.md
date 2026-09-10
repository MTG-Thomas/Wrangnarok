---
name: lane-ops
description: Coordinate parallel agent lanes over a local opencode lane server (HTTP session spawn/drive) plus mailbox and GitHub as the bus. Use when spawning lane workers, injecting messages into sessions, watching lane runs, or retiring lanes.
---

# Lane Ops

Run parallel agent lanes on this machine without a separate runtime. Three
channels, each with a fixed job:

- **Lane server (HTTP)**: spawn sessions, drive runs, read runs. Full-duplex
  ONLY for server-driven sessions. Base: `http://127.0.0.1:4097` (see
  `scripts/LaneOps.psm1`, `Get-LaneConfig`). Never touch the interactive
  `:4096` instance.
- **Mailbox**: async notes to harness-driven live threads (they poll at turn
  boundaries). Notes by default; `steer` permitted ONLY on terminal states
  (DONE with evidence, BLOCKED with exact blocker), steward-only otherwise,
  `[STEER]` subject prefix, cooldown until ack or 15 min. Steer attaches to
  the recipient's next tool result; it does NOT preempt mid-call, and nothing
  wakes an idle harness loop — turn-boundary polling remains the delivery
  moment. There is no true event ingress to a live harness thread; design
  around it (short polls, terminal-state steers).
- **GitHub**: durable record (tracking issues, progress comments, PRs).
  Registry format is `host:port + sessionID` (IDs alone are ambiguous across
  servers). Passwords and secrets NEVER go on GitHub; distribute via mailbox.

## Server lifecycle

- `Start-LaneServer [-Port 4097]`: loopback-only, basic auth day-1 (password
  generated, stored in the local lane config file outside the repo, never
  committed). Started from the repo dir so project scope matches. Record PID.
- Server dies with its process/logoff. Restart = re-run serve, then
  `Get-LaneSession` to re-attach (never blind re-`POST /session`, which
  duplicates coordinators). Sessions persist in the default store.
- `:4096` is a separate store (19 unrelated sessions); the default store is
  home to harness lanes. Verify with project/session counts before assuming.

## Model rule (load-bearing)

Spawned sessions default to a weak model that goes silent-busy (single-digit
output tokens over hours). Set the capable model on the FIRST delegation
message: `model: { providerID, modelID }`. Verified: it persists session-wide
(second message without the block still ran the same model). Server-wide
`PATCH /config` default did NOT stick; do not rely on it.

## Message semantics (verified)

- `prompt_async` + `noReply:true` = silent user-msg append, no run.
- `prompt_async` without `noReply` = lands in history, may sit unanswered
  (observed: queued behind a finished run, never answered).
- Blocking `POST /session/:id/message` = drives a run, returns the reply.
- Keep posts SHORT (single paragraphs, plain phrasing). Long dense-prose
  posts intermittently 500 (`UnknownError`); root cause unidentified, retry or
  chunk when hit. Use `curl.exe`, never bare `curl` (PS alias trap); 204
  returns `$null`, which is success. `ConvertTo-Json -Depth 5+` for bodies.
- PowerShell 5.1 notes: variables are case-insensitive (`$h` clobbers `$H`);
  no ternary/`??`; quote paths with spaces.

## Merge-queue recovery runbook

Green + `automerge` + CLEAN but Merge Queue `skipping`? Read the queue
check summary via `Watch-LaneQueue` (parses `Mergify Merge Queue` output,
names the exact blocking item). Known causes, in order:

1. **Mergify stale `conflict` flag** (seen live): GitHub says
   `mergeable=true/clean`, Mergify still demands `-conflict`. Force a fresh
   evaluation with close/reopen (`gh pr close N` + `gh pr reopen N`); the
   recorded queue request is then honored within a minute. No history
   pollution. Empty commits are the fallback, not the default.
2. **Behind after a main move**: the auto-update rule merges main into
   conflict-free `automerge` PRs. If it loses the event race, update the
   branch manually (GitHub UI or merge locally) and tick the queue checkbox
   once; Mergify records it ("no need to run the command again").
3. **Red non-required checks** (e.g. AI code-scan model outages): noise.
   Only `Validate` gates the queue; ignore the rest.
4. **Real conflict (DIRTY)**: lane work — merge main, resolve keeping both
   slices green, push, re-queue. Never force-push a shared lane branch.
5. **Auto-queue silently not firing** (seen live 4 of 4: green + `automerge`,
   queue says "can be added" indefinitely). Auto-queue-on-label is decorative;
   do not depend on it. PR creation standard: `automerge` label AND
   `@mergifyio queue` comment together at open (Mergify registers intent and
   merges when green — no waiting period). Repost the comment if a green
   PR is somehow still unqueued; it dedups.

## Driving lanes

- Prefer micro-tasks with verifiable replies over long autonomous briefs.
- Silent-busy recovery: `Stop-LaneRun` (abort) + redrive with
  report-first ("reply with completed/now/blockers, then continue"). Proven 3x.
- Never drive runs into harness-driven LIVE threads (dual-driver corruption:
  two loops, one session store). Mailbox for those; HTTP-first only for
  server-driven lane sessions. History-append (`noReply:true`) is the only
  safe write to a live thread, and even that may never surface (NOT-SEEN).
- One lane per worktree: branch from `origin/main`, worktree under the
  scratch root (never inside the main checkout), small PRs, `automerge` at
  creation, remove worktree on merge. Never merge red, never force-push.

## Stewardship & retirement

- Fixed lanes need a guard list (paths owned by active human/steward lanes).
  Collision = mailbox the owner, do not touch. No merge-infra changes without
  ADR. No production deploys (local + CI only).
- Retire: delete merged local branches (`git branch -d`, safe-delete only),
  prune stale remote-tracking refs (GitHub auto-deletes merged heads),
  `DELETE` scratch sessions, remove merged worktrees. Keep active + bot lanes.
  Dead mailbox letters have no withdraw API; record and ignore.
