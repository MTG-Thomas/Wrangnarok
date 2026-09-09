---
name: codex-security
description: "Use for deep security scans, source-to-sink analysis, exploitability validation, and vulnerability triage via OpenAI codex-security. Trigger on suspected vulnerabilities, scan requests, or findings that need validation/fixing."
---

# Codex Security Router

This skill routes deep security work to OpenAI's `codex-security` CLI/SDK
(`@openai/codex-security`, Apache-2.0). It is a thin router, not a vendored
methodology: the 15-skill Codex plugin suite upstream is coupled to its own
scan harness (workers, MCP tools, `CODEX_SECURITY_SCAN_*` env) and is
deliberately not copied here.

Routed here from `mtg-secure-delivery-review`: deep scans, source-to-sink
analysis, exploitability validation, and vulnerability triage. Shallow
delivery review stays in `mtg-secure-delivery-review`.

## Prerequisites

- Node.js 22.13.0+ and Python 3.10+.
- Auth: `codex-security login`, or `OPENAI_API_KEY` for CI.
- Some cybersecurity requests and protected findings require Trusted Access
  for Cyber approval (`chatgpt.com/cyber`).
- Full docs: `learn.chatgpt.com/docs/security/cli`.

## Invoke

```bash
npm install @openai/codex-security
codex-security scan /path/to/directory
```

Policy generation (drafts outside the checkout; review before installing):

```bash
codex-security policy .
```

Headless/bulk: TypeScript SDK (`new CodexSecurity().run(dir, { mode: "deep", ... })`)
or the Docker Compose bulk-scan configuration upstream. Findings service
preview: `codex-security serve`.

## Boundaries

- Start read-only: scan and triage before fixing. Do not auto-remediate
  findings without explicit user authorization.
- Never print secrets, tokens, or private endpoint values from scan output.
- Findings reference the scanned revision; re-scan after fixes rather than
  assuming remediation.
- If the tool is not installed or auth is missing, report that as the
  blocker with the exact install/login command — do not improvise an
  equivalent scan with ad-hoc greps.
