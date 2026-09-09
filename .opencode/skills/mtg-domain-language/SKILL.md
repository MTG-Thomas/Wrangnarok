---
name: mtg-domain-language
description: Use when project, customer, Bifrost, NinjaOne, Keeper, MemPalace, infrastructure, or workflow terminology needs clarification, normalization, documentation, or reuse.
---

# MTG Domain Language

Use this skill to create or refresh the shared vocabulary that keeps future work short and accurate.

## What To Capture

Capture terms that are:

- used repeatedly by the user, repo, tickets, logs, or runbooks;
- shorter than their explanation;
- easy to misuse across systems;
- important for safe operations, customer classification, workflow rollout, or PR scope.

Examples: `durable VM`, `ring rollout`, `callback runner`, `operator surface`, `plan-branded MSP customer`, `evidence-backed cleanup`, `Keeper UID`, `workflow coverage ledger`.

## Workflow

1. Inspect existing context before inventing names.
   - Look for `CONTEXT.md`, `AGENTS.md`, `README.md`, `docs/adr/`, `docs/runbooks/`, issues, and nearby code identifiers.
   - Use memory only as a hint; verify repo-local language when cheap.

2. Find language drift.
   - Same word used for different concepts.
   - Different words used for the same concept.
   - Vague or overloaded names that hide operational risk.
   - Terms that sound generic but carry local meaning in this repo or tenant.

3. Build a compact glossary.
   - Term: canonical spelling.
   - Meaning: one sentence.
   - Use when: operational or code context.
   - Avoid confusing with: similar term or old name.
   - Evidence path: file, command, API, ticket, or memory source if relevant.

4. Prefer the codebase's own terms.
   - Do not rename concepts casually.
   - If a better term is needed, propose it explicitly and explain the migration impact.
   - When the user chooses a term, use it consistently in later plans, issues, PRs, and docs.

5. Store only durable language.
   - For repo work, prefer `CONTEXT.md` or a short `docs/adr/` entry if a naming decision changes behavior or architecture.
   - If no repo context file exists and the language is central to future work, create `CONTEXT.md` lazily with only the terms needed now.
   - For machine-local/operator knowledge, prefer the user's established local memory or notes flow when explicitly asked.

6. Use the vocabulary immediately.
   - Apply terms consistently in plans, issues, commits, PR descriptions, docs, and code identifiers.
   - In architecture reviews, name modules and interfaces with repo vocabulary rather than implementation nicknames.

## Output Shape

When not editing files, return a short table with `Term`, `Meaning`, and `Evidence/Use`.

When editing files, keep changes compact and avoid turning the glossary into generic documentation.
