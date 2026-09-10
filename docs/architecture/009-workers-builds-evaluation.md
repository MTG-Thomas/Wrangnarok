# ADR 009: Stay on GitHub Actions, not Workers Builds

- **Status:** Accepted
- **Date:** 2026-09-10

## Context

During CI hardening (PRs 37-42) the question arose whether Cloudflare Workers
Builds should replace the GitHub Actions pipeline: hosted builds from a
connected repository, per-version preview URLs, and reported in-toto build
attestations binding a deployed Worker version to its source commit.

## Facts gathered

1. Workers Builds pricing (checked 2026-09-10 against
   `workers/ci-cd/builds/limits-and-pricing`): 3,000 build minutes/month free,
   6,000 on Paid, then $0.005/min. Our full build takes ~1 minute, so minutes
   are not the constraint; Workers requests, D1, and Workflow steps are.
2. This repository is public, where Actions minutes are effectively unlimited,
   so the minutes argument for Builds does not apply to us.
3. Build attestations are reported by a third party (April 2026), not confirmed
   in Cloudflare's own docs. Reported scope: code only, not bindings (D1, env
   vars, routes can drift without invalidating the attestation). Only builds on
   Cloudflare's hosted pipeline produce them; `wrangler deploy` from our own CI
   does not.
4. Everything the pipeline enforces today (guardrails, audit gate, lint,
   typecheck, workerd tests, Scorecard, CodeQL, required `Validate` check) is
   Actions-native. Builds can report commit statuses but cannot run this
   pipeline, so adopting it means running both systems, not one.

## Decision

1. Stay on GitHub Actions + Wrangler (dry-run today, deploy automation per
   ADR 004 when earned). Do not connect Workers Builds.
2. When deploy automation lands, prefer Actions + `wrangler deploy` with scoped
   tokens (ADR 004), plus self-issued Sigstore attestations if provenance is
   wanted. Hosted-build attestations are not a reason to switch pipelines.

## Consequences

- No connected-repo-deploy model enters the project while deployment automation
  itself is still deferred. Local-first development (AGENTS.md) is unaffected.
- Per-PR UI previews remain manual until someone justifies the second system.

## Revisit when any of these is true

1. Per-PR preview URLs become worth a second CI system.
2. Cloudflare confirms build attestations in its own docs AND promotion gates
   are being designed (attestation + binding-set verification at dev to
   production promotion).
3. Minutes pressure appears (e.g. the repository goes private with heavy
   build usage).
