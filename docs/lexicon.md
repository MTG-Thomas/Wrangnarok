# Wrangnarök lexicon

Wrangnarök prefers boring, industry-standard names for load-bearing concepts (see ADR 006). A small amount of Norse-inspired language remains where it carries a real distinction, not for the joke.

## Naming rule

**Cloudflare owns infrastructure nouns. Wrangnarök owns domain nouns.**

Do not alias or obscure established Cloudflare terms such as Worker, Workflow, workflow step, Queue, Durable Object, D1, R2, KV, binding, or Cron Trigger.

Display name `Wrangnarök` is permitted in prose and titles. All code, binding, package, D1, and identifier names MUST use ascii `wrangnarok` (no diacritics).

## Domain terms

### Saga

A code-first automation definition written in TypeScript.

A Saga describes orchestration logic. Cloudflare Workflows are the initial durable runtime used to implement Sagas, but the domain concept is intentionally distinct from the Cloudflare product. (Unrelated to the distributed-systems "saga pattern" of compensating transactions; no compensation semantics are implied.)

### Execution

One execution of a Saga.

An Execution maps naturally to a Cloudflare Workflow instance and carries Wrangnarök-specific identity, Organization context, status, and ExecutionHistory metadata.

### Operation

A durable unit of execution within a Saga.

Operations are expected to map to Cloudflare Workflow steps initially. `Operation` exists so Wrangnarök code and documentation can distinguish its execution contract from Cloudflare's `WorkflowStep` API.

### Integration

A reusable integration/provider boundary: for example NinjaOne, Microsoft Graph, HaloPSA, Meraki, or a generic HTTP service.

An Integration should expose ordinary typed TypeScript APIs. Avoid ceremonial wrappers that make normal code harder to write.

### Connection

A configured/authenticated instance of an Integration, usually scoped to an Organization.

### Organization

An organization/tenant boundary.

Authorization and isolation across Organizations must remain explicit in code and tests; the name must never soften that boundary.

### Trigger

An event capable of starting a Saga. Examples may include HTTP requests, schedules, or future event sources.

### ExecutionHistory

The durable execution/audit history associated with Executions and Operations.

### Catalog

The application-level catalog connecting Organizations, Integrations, Connections, Triggers, and Sagas: Saga discovery/registration metadata and cross-references.

`Catalog` describes that discovery metadata, not the app as a whole. Do not let it become a junk-drawer module.

## Deliberately boring terms

These keep their ordinary names unless a real domain distinction emerges:

- Form
- Table
- Secret
- User
- Role
- Permission
- Artifact
- Action
- Input
- Output
- Error
- Retry

## Reserved jokes

### Acorn 🌰

Not currently a domain abstraction.

The first MVP milestone is **The First Acorn**. If the architecture later develops a concept for which "Acorn" is genuinely clearer than the boring technical term, it may be reconsidered. Do not invent such a concept solely to use the name.

### Squirrel

Also not an execution primitive. Cloudflare Workers are Workers.

Squirrel jokes in logs, test fixtures, and documentation are permissible within reason.
