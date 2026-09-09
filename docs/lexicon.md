# Wrangnarök lexicon

Wrangnarök uses a small amount of Norse-inspired domain language. The goal is memorable concepts, not renaming infrastructure for the joke.

## Naming rule

**Cloudflare owns infrastructure nouns. Wrangnarök owns domain nouns.**

Do not alias or obscure established Cloudflare terms such as Worker, Workflow, workflow step, Queue, Durable Object, D1, R2, KV, binding, or Cron Trigger.

## Domain terms

### Saga

A code-first automation definition written in TypeScript.

A Saga describes orchestration logic. Cloudflare Workflows are the initial durable runtime used to implement Sagas, but the domain concept is intentionally distinct from the Cloudflare product.

### Journey

One execution of a Saga.

A Journey maps naturally to a Cloudflare Workflow instance and carries Wrangnarök-specific identity, Grove context, status, and Trail metadata.

### Operation

A durable unit of execution within a Saga.

Operations are expected to map to Cloudflare Workflow steps initially. `Operation` exists so Wrangnarök code and documentation can distinguish its execution contract from Cloudflare's `WorkflowStep` API.

### Realm

A reusable integration/provider boundary: for example NinjaOne, Microsoft Graph, HaloPSA, Meraki, or a generic HTTP service.

A Realm should expose ordinary typed TypeScript APIs. Avoid ceremonial wrappers that make normal code harder to write.

### Connection

A configured/authenticated instance of a Realm, usually scoped to a Grove.

### Grove

An organization/tenant boundary.

The name is domain flavor, not an excuse to hide tenancy semantics. Authorization and isolation should remain explicit in code and tests.

### Signal

An event capable of starting a Saga. Examples may include HTTP requests, schedules, or future event sources.

### Trail

The durable execution/audit history associated with Journeys and Operations.

### Yggdrasil

The application-level catalog/graph connecting Groves, Realms, Connections, Signals, and Sagas.

Use sparingly. `Yggdrasil` should describe the whole domain/catalog, not become a generic synonym for "the app."

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
