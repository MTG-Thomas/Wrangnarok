---
name: mtg-secure-delivery-review
description: "Use for secure delivery review: Dockerfiles, containers, CI/CD, minimal API/OpenAPI hygiene, secrets boundaries, least privilege, provenance, and verification."
---

# MTG Secure Delivery Review

Use this skill for a concise, evidence-led review of how a repository builds,
ships, and exposes software. Focus on secure defaults that a maintainer can
see in the repo: build files, Dockerfiles, workflow definitions, deployment
scripts, API surface, secrets handling, and verification gates.

This complements `codex-security` and `github-pr-stewardship`. Do not turn it
into a full security scan, exploit search, or PR lifecycle workflow.

## Boundaries

- Start read-only unless the user asks for implementation.
- Preserve other agents' edits and stay inside the user's stated repo/path
  boundary.
- Route deep scans, source-to-sink analysis, exploitability validation, and
  vulnerability triage to `codex-security`.
- Route PR publishing, check monitoring, requested-change fixes, and merge
  decisions to `github-pr-stewardship`.
- Do not print secrets, tokens, registry credentials, publish profiles,
  connection strings, customer identifiers, or private endpoint values.
- Prefer small, repo-native fixes over broad platform redesigns.

## Evidence To Inspect

Use the smallest set that answers the question:

```bash
rg --files
git status -sb
rg -n "FROM |USER |EXPOSE |HEALTHCHECK|ENTRYPOINT|CMD |COPY |RUN " -g "Dockerfile*" -g "*.dockerfile"
rg -n "password|secret|token|api[_-]?key|connectionstring|publish profile|registry" .github Dockerfile* docker-compose* . 2>/dev/null
rg -n "permissions:|id-token:|pull_request_target|workflow_run|environment:|secrets\\.|docker build|docker/login-action|actions/checkout" .github
rg -n "OpenApi|Swagger|WithOpenApi|AddEndpointsApiExplorer|Map(Get|Post|Put|Delete)|RequireAuthorization|AllowAnonymous" .
```

On PowerShell, adapt globs rather than widening the review accidentally. If
the repo has task runners, prefer existing commands such as `make test`,
`npm test`, `dotnet test`, `docker build`, or documented verification scripts.

## Review Checklist

Container and Dockerfile quality:

- Multi-stage builds keep SDK/build tools out of runtime images.
- Runtime images are minimal, pinned enough for repeatability, and appropriate
  for the app framework.
- Containers run as a non-root user, avoid privileged mode, and expose only
  expected ports.
- Build layers avoid copying secrets, package caches, local config, `.git`, or
  large unrelated directories.
- `HEALTHCHECK`, entrypoint, environment defaults, and file permissions match
  the runtime model.

CI/CD and release evidence:

- Workflows use least-privilege `permissions:` and avoid untrusted write paths
  such as unsafe `pull_request_target` usage.
- Build, test, lint, container build, and release jobs are separated enough to
  make failures understandable.
- Release or deploy jobs require explicit environments, approvals, protected
  branches/tags, or other repo-native gates where risk warrants it.
- Registry login, signing, SBOM, provenance, artifact retention, and image
  tagging are visible when the repository ships containers.
- Secrets are consumed through repo/org environments or OIDC where possible,
  never committed or echoed.

Minimal API and OpenAPI hygiene:

- OpenAPI/Swagger is intentionally enabled by environment and does not expose
  internal-only docs in production by accident.
- Endpoints have clear auth defaults; anonymous routes are explicit and rare.
- Request validation, response types, versioning, CORS, HTTPS redirects, and
  problem-details behavior are visible enough for maintainers.
- Health, readiness, and metrics endpoints expose only operationally safe data.

Secrets and least privilege:

- No plaintext secrets or generated credentials are present in tracked files.
- Example env files use placeholders and document where real secrets live.
- Service accounts, deploy keys, package tokens, and cloud identities are
  scoped to the minimum repo, environment, registry, or resource needed.
- Logs, tests, and sample commands do not leak sensitive values.

Verification:

- Prefer real build/test evidence over checklist-only advice.
- For Docker changes, run or recommend the narrowest useful build command.
- For pipeline changes, inspect workflow syntax and name the check that should
  prove the change in CI.
- For API exposure changes, run existing tests or a local smoke check when
  practical.

## Output Shape

For review-only work:

```markdown
Evidence checked:
Findings:
Recommended fixes:
Route elsewhere:
Verification:
```

For implemented fixes:

```markdown
Changed paths:
- path

Summary:
- secure delivery default improved
- evidence or tests run
- residual risk or follow-up
```
