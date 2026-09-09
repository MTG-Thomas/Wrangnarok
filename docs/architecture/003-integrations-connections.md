# ADR 003: Integrations and Connections

Status: **Proposed**

## Context

Upstream Bifrost separates an Integration definition from organization-specific mappings. A workflow resolves the Integration in its current organization context; configuration is composed from service defaults and organization overrides, while OAuth/token state belongs to the environment rather than portable workflow source.

Wrangnarök needs the same product boundary without inheriting Bifrost's implementation.

## Decision

### Integration

A **Integration** is code: a reusable, typed TypeScript integration/provider definition.

An Integration owns:

- a stable machine identifier;
- human discovery metadata;
- typed configuration schema;
- identification of which configuration fields are secret;
- optional authentication/OAuth contract;
- typed Actions that Sagas may call;
- vendor-specific request/response normalization;
- vendor-specific pagination/rate-limit/error behavior where useful.

An Integration does **not** own tenant credentials or mutable OAuth tokens.

Example shape (illustrative, not yet API-stable):

```ts
export const echo = defineIntegration({
  id: "00000000-0000-0000-0000-000000000101",
  name: "echo",
  config: EchoConfig,
  actions: {
    echo: async (ctx, input: EchoInput) => {
      const response = await ctx.fetch(`${ctx.config.baseUrl}/echo`, {
        method: "POST",
        body: JSON.stringify(input),
      });
      return response.json<EchoResult>();
    },
  },
});
```

### Connection

A **Connection** is environment state: a configured instance of an Integration for an Organization.

A Connection owns:

- stable Connection ID;
- Integration ID;
- Organization ID;
- optional external entity/tenant ID and display name;
- non-secret configuration;
- references to secret material;
- authentication state/metadata;
- created/updated timestamps.

A Connection must never serialize decrypted credentials through the ordinary public API, ExecutionHistory, Execution result, or browser-facing state.

### Resolution

A Saga normally asks for an Integration in the current Execution's Organization context. The runtime resolves the corresponding Connection.

The MVP resolution rule is deliberately strict:

1. Resolve the requested Integration by stable ID/name.
2. Resolve a Connection for exactly the current Organization.
3. If none exists, fail with a structured `CONNECTION_NOT_CONFIGURED` error.

There is **no implicit global credential fallback in the MVP**. Upstream supports org/global cascades, but explicit Organization isolation is safer and simpler for the experiment. Shared/default Connections may be introduced later only with explicit lookup and write-boundary semantics.

Explicit cross-Organization Connection lookup is an administrative capability, not something arbitrary Saga code receives by passing another Organization ID.

### Actions

An **Action** is a typed callable exposed by an Integration. Keep this boring term.

Sagas should ideally read like ordinary TypeScript:

```ts
const echo = await ctx.integrations.echo.echo({ message: "hello" });
```

Do not require Saga authors to manipulate Connection records, tokens, D1 rows, or Cloudflare bindings directly.

### Secret boundary

Cloudflare Worker secrets and Secrets Store are suitable for deployment/account-level secrets, but they are not by themselves a scalable per-Organization Connection store: Worker secrets are deployment bindings, while Secrets Store is account-level and currently limited in count.

D1 is encrypted at rest, but D1 encryption alone does not make plaintext credential columns an acceptable application secret design. Before multi-tenant Connections ship, Wrangnarök must choose an application-level secret-storage scheme.

Proposed direction is now ADR 005 (per-Organization envelope encryption, Proposed — not yet approved for production use):

- one deployment-level master encryption key (KEK) stored as a Worker secret;
- per-Connection secret payload encrypted/decrypted inside the Worker with Web Crypto (AES-GCM envelope);
- ciphertext, nonce, wrapped DEK, key version, and algorithm persisted in D1;
- decrypted material exists only transiently inside server-side Worker/Workflow execution;
- key rotation/versioning designed before declaring the format stable.

This is **not yet approved for production use**. The MVP slice does not need tenant credentials; its demo Integration can use a mock endpoint with non-secret configuration.

### OAuth

OAuth is deferred, but the Connection contract must leave room for:

- authorization-code tokens;
- client-credentials flows;
- access/refresh token expiry;
- refresh coordination;
- alternate requested scopes/resources;
- token replacement without replacing Connection identity.

Token refresh must not be implemented independently in every Saga.

## Consequences

- Integration code remains portable and Git-versioned.
- Connection state remains Organization/environment-specific.
- A Saga cannot accidentally carry credentials in source.
- MVP tenant resolution is stricter than upstream Bifrost's global fallback behavior.
- Secret storage becomes an explicit security design task rather than an accidental D1 schema detail.
- The MVP slice can implement the Integration abstraction without blocking on OAuth/secret storage.

## Upstream behavior intentionally not copied yet

- global/default Integration credential fallback;
- provider-organization mapping enumeration;
- cross-org mapping administration from ordinary workflow APIs;
- Solution-declared Integration requirement failures;
- OAuth scope override behavior.

These remain specification fodder for later phases.
