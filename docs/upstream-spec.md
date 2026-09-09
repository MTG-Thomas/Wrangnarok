# Upstream Bifrost capability map

Wrangnarök is AGPL-3.0 and treats `gobifrost/bifrost` as its reference product. This document extracts behavioral contracts and product invariants rather than assuming upstream infrastructure should be reproduced.

Status vocabulary: **Adopt** preserves the product capability; **Adapt** preserves intent with a Cloudflare-native model; **Defer** is useful but not required yet; **Reject** is intentionally outside this experiment; **Investigate** needs more evidence.

| Upstream capability | Status | Wrangnarök direction | Candidate Cloudflare primitive |
| --- | --- | --- | --- |
| Code-first workflows | **Adopt** | TypeScript **Sagas** | Workflows |
| Workflow executions | **Adapt** | **Executions** with durable Operations | Workflow instances + D1 ExecutionHistory |
| Stable workflow identity | **Adopt** | Source edits must not silently mint a new Saga identity | D1 catalog + source metadata |
| Workflow discovery metadata | **Adopt** | Name, description, category/tags or equivalent | D1/catalog |
| Reusable integrations | **Adopt** | Typed **Integrations** | Worker TypeScript modules |
| Multi-tenancy / organizations | **Adopt** | **Organizations** | D1 initially |
| Explicit access boundary | **Adopt** | A caller must be authorized through the complete dependency chain | Worker auth + D1 policies/application checks |
| Connection/config management | **Adopt** | **Connections** scoped/resolved through Organizations | D1 + secret mechanism |
| OAuth management / refresh | **Defer** | Integration-specific auth contract with common lifecycle helpers | Worker + D1/secrets |
| Secret management | **Investigate** | Determine a safe Cloudflare-native per-Organization secret model | Secrets / encrypted D1 or another native facility |
| Dynamic forms | **Defer** | Form field names bind to Saga inputs | Worker + static UI + D1 |
| Tables / application storage | **Adapt** | JSON/document-like author storage over D1, if justified | D1 |
| Row-level authorization/policies | **Defer / Investigate** | Preserve deny-by-absence and tenant-safe query semantics if Tables ship | Application policy layer over D1 |
| Triggers/events | **Adopt** | **Triggers** include HTTP/webhook, schedule, and potentially topic events | Worker / Cron / Workflows |
| Topic emission/subscription | **Defer** | Preserve event decoupling only if needed | Queues / Workflows |
| Async execution queue | **Adapt** | Workflows first; Queue only for real broker/backpressure semantics | Queues if earned |
| Cache/session layer | **Reject as required architecture** | Add caching only for demonstrated need | KV / Cache API / DO if earned |
| Object/file storage | **Defer** | **Artifacts** with explicit ownership/access boundaries | R2 |
| Scheduler service | **Adapt** | No persistent scheduler process | Cron Triggers / Workflows |
| Persistent worker processes | **Reject** | Execution lives in Cloudflare primitives | Workers / Workflows |
| Local source execution | **Adopt** | Fast local execution without registration/deploy should remain possible | Wrangler/local runtime |
| Hot reload | **Adapt** | Standard local Worker development | Wrangler |
| Portable bundles / Solutions | **Defer but important** | One source definition installable into multiple Organizations; separate source from environment state | Git + manifests + D1 install state |
| Deploy-owned vs loose entities | **Investigate** | Upstream distinction is valuable but may be too heavy for early Wrangnarök | Catalog/manifests |
| Git-based management | **Adopt** | Sagas and Integrations are ordinary version-controlled TypeScript | GitHub |
| AI-assisted development | **Adopt as philosophy** | Types, docs, tests, and boring APIs should be agent-friendly | TypeScript |
| Monitoring / execution history | **Adopt** | **ExecutionHistory** | D1 + Workers observability |
| Agents / tool workflows | **Defer** | A Saga may eventually opt into tool exposure; normal Sagas remain distinct | Workers AI / external model APIs later |
| Self-host anywhere | **Reject** | This experiment is intentionally Cloudflare-native | Cloudflare |
| PostgreSQL / Redis / RabbitMQ | **Reject as dependencies** | Port behavior, not products | Native primitives as earned |
| Docker Compose deployment | **Reject** | Deployment target is Cloudflare | Wrangler |

## Behavioral findings from upstream

### 1. Code-first automation is a core invariant

Upstream workflows are ordinary async Python functions whose typed function signature defines inputs and whose result must be serializable. The decorated workflow should remain thin: validate input, orchestrate reusable module behavior, and shape output. Reusable integration/domain logic belongs outside the workflow body.

**Wrangnarök implication:** Sagas should be ordinary TypeScript, not serialized workflow definitions. Type inference/schema generation should derive as much as practical from code. Integration logic should remain independently testable.

### 2. Source identity and persisted execution identity are separate

Upstream registers a callable as a stable, scoped, permissioned workflow record. Editing its implementation preserves registration. Moving/renaming has explicit replacement/remap behavior because blindly re-registering creates a new UUID and breaks dependents.

**Wrangnarök implication:** do not equate `export function foo` with durable identity. A Saga needs stable identity independent of source edits, and references from Triggers/forms/etc. should survive implementation changes. Exact registration UX is TBD.

### 3. Runtime policy is environment state, not source decorator trivia

Upstream source-level workflow metadata is intentionally limited to identity/discovery. Timeouts, schedules, endpoints, access, retries, cache behavior, and similar operational configuration live on persisted entities rather than being baked into decorators.

**Wrangnarök implication:** keep the TypeScript Saga authoring contract small. Avoid stuffing Cloudflare deployment/runtime knobs into `saga()` just because they are available.

### 4. Local execution without registration is valuable

Upstream explicitly supports executing local workflow source without registration and separately executing registered workflows. Solution preview runs local code while using real environment resources and authorization.

**Wrangnarök implication:** `wrangler dev` should eventually support a fast local Saga loop. Do not make every edit require a deploy or D1 registration round trip.

### 5. Tenant scope is a dependency-chain property

Upstream organizations are tenant boundaries. Apps/forms/workflows/resources each carry scope/access, and successful admin execution does not prove an ordinary caller can traverse the dependency chain.

**Wrangnarök implication:** Organization context should be explicit and propagated through Executions, Integration Connection resolution, Tables, and Triggers. Tests need representative allowed and denied non-admin/non-owner callers once auth exists.

### 6. Integrations separate service definition from tenant mapping

Upstream Integration entities define a service/config schema; organization mappings bind them to tenant-specific OAuth/config state. Packages declare requirements but do not carry environment credentials.

**Wrangnarök implication:** distinguish **Integration** (code/service definition) from **Connection** (environment/Organization-specific configuration and credentials). Portable Saga code must never embed Connection state. Working dependencies do not guarantee connectivity: each Integration must document allowed outbound hosts, redirect/timeout/byte-bound policy, and non-HTTP / private-registry / IP-allowlist limits, with per-Operation timeout/retry/concurrency caps stated explicitly rather than inherited from host behavior.

### 7. Events are source + subscription, not merely cron annotations

Upstream event sources include schedule, webhook, and topic. A subscription targets one workflow or agent, and topic events carry metadata/payload into execution context.

**Wrangnarök implication:** Trigger should remain a first-class domain concept rather than becoming `cron` metadata on a Saga. MVP only needs HTTP initiation, but the model should not preclude schedules/webhooks/topics.

### 8. Tables are JSON-document storage with policy semantics

Upstream Tables store JSON documents, support filtering/querying, and attach row-level policies. Schema/declaration is source/deploy state while rows are environment data. Fresh resources are effectively deny-by-absence for ordinary users until policy is defined.

**Wrangnarök implication:** if user-facing Tables are implemented, they are not merely direct D1 access. They need a stable author API, explicit schema/declaration vs row-data separation, and authorization semantics. This is post-MVP. Phase 4 acceptance must additionally cover: atomic authorization of batch writes, explicitly managed indexes for arbitrary JSON queries (no PostgreSQL JSONB assumptions), counts/pagination over filtered history, per-subscriber visibility transitions and revocation handling, and a retention/partitioning policy for the D1 10 GB per-database limit with cross-database no-transaction semantics stated.

### 9. Portable product definition is distinct from an installation

An upstream Solution is a portable source definition containing apps, workflows, forms, agents, table/config declarations, claims, and declared file locations. One definition can be installed in many organizations. Each install has independent identity, scope, environment configuration, and runtime data. Shareable exports exclude secrets/table rows/runtime file bytes.

**Wrangnarök implication:** this distinction is worth preserving eventually. A portable bundle should not contain Organization-specific Connection credentials or mutable environment data. Do not prematurely make Git repository == tenant installation. Activation of a new bundle version must be atomic (persist inputs/outputs outside execution, then flip version with rollback path), and published assets need explicit authorization, version activation/rollback, and cache invalidation — interrupted work restarts from the beginning, never from a half-activated state.

### 10. Managed ownership has consequences

Upstream Solution-owned entities are deploy-managed; live mutation is blocked. Loose entities can be manipulated directly. Deploy is full replacement/reconciliation of managed definitions, while environment data follows separate preservation rules.

**Wrangnarök implication:** there is a useful invariant here—declaratively managed resources should not drift through ad-hoc mutation—but reproducing the full loose-vs-managed system may be excessive. Investigate after the MVP slice.

### 11. Shared-resource fallback is explicit and bounded

Upstream can allow a Solution to fall back to eligible shared workflows/tables/files/modules, but this does not grant arbitrary cross-tenant access. Shared table fallback is read-only, normal policy remains active, and configs/integrations have separate resolution rules.

**Wrangnarök implication:** do not build magical global fallback early. If shared Integrations/resources arrive later, define lookup order and write boundaries explicitly.

### 12. Agents are consumers of explicitly exposed tools

Upstream distinguishes normal workflows from tool workflows exposed to agents. Tool naming/description must be sufficiently distinctive for deferred discovery, and server-side permissions remain authoritative even when an agent can discover a tool.

**Wrangnarök implication:** future AI/tool exposure should be opt-in metadata on suitable Sagas/Actions, not the default execution model.

### 13. First real vendor: NinjaOne (Rung 1, verified live 2026-09-09)

Auth is OAuth2 client-credentials M2M app, sysadmin-created via the API Services platform. Token host is regional `us2.ninjarmm.com/oauth/token`; central `app.ninjarmm.com` does not know us2 clients (returns API-envelope `Client-app-not-exist`). The `scope` parameter is mandatory; `monitoring` is granted while `management` is rejected for a read-only app. Token shape is `{access_token (87 chars observed), expires_in 3600, token_type Bearer}`; tokens are re-requested per execution with no caching yet.

API base is `https://us2.ninjarmm.com/api` with `/v2/organizations`; both `/api/v2` and `/v2` paths route on us2 (verified via error-envelope discrimination, no creds).

The response is a bare JSON array of organizations (297 observed, ~24KB); entries are `{id number, name string}`; results are shaped to count plus max 25 persisted (4KB D1 result bound) with a 256KB transport cap for this call.

Error mapping used: 401 `NINJA_UNAUTHORIZED`, 429 `NINJA_RATE_LIMITED`, 5xx `NINJA_VENDOR_FAILED`, non-array `NINJA_BAD_RESPONSE`, 3xx rejected (workerd has no `redirect:error`).

Runtime facts: workerd `fetch` rejects `redirect:error` (use `manual` plus explicit 3xx handling); cross-realm `Request` construction from Workflow-isolate init fails (read headers directly); D1 `exec()` rejects leading SQL comments.

**Wrangnarök implication:** derive the token host from the Connection endpoint (region-portable, no per-region code). Pin OAuth scope as the least-privilege precedent for future OAuth work. Shape and count-cap vendor list responses before persisting; never assume small.

## Candidate product invariants

These are stronger than implementation preferences and should guide design reviews:

1. **Code is source of behavior; environment state is not embedded in code.**
2. **Saga identity survives ordinary source edits.**
3. **Organizations are hard tenant boundaries.**
4. **Integration definitions and Organization-specific Connections are separate.**
5. **Secrets never cross into browser/client code or ordinary execution output.**
6. **Portable definitions exclude tenant credentials and mutable runtime data.**
7. **Every externally invokable dependency must independently authorize the caller/context.**
8. **Local development should not require production deployment.**
9. **Managed/declarative resources must have a clear source of truth.**
10. **Cloudflare primitives remain visible rather than hidden behind mythological aliases.**
11. **Free-tier viability is measured, not assumed.**

## Next upstream sweeps

Priority order is intentional. Inspect first:

- execution state machine, cancellation, timeout and retry behavior — required to settle ADR 001 Execution/Operation semantics, Phase 1 state model, and Phase 2 retries/cancellation before any Tables/Forms/AI work;

Then, in roughly this order:

- current integration SDK and OAuth implementation contracts;
- files/artifacts;
- app/web SDK and forms;
- agent/MCP surface;
- Solution manifests and packaging/version semantics;
- claims/policies and authentication model;
- API surface and execution observability;
- current upstream tests for invariants that documentation may omit.

## Cutover lessons from Cloudflare lift-and-shift report (2026-09)

Upstream's hardest→easiest cutover ranking assumes preserving Python, FastAPI, and PostgreSQL via Containers. Wrangnarök rejects that path (TypeScript Sagas, Workers-native API, D1 day one) but keeps the failure-mode inventory:

1. **D1 capacity/retention:** 10 GB per-database limit, explicit retention/partitioning policy, no cross-database transactions. Pointer: ADR 001 Open questions, Phase 4 Tables bullet.
2. **Tables/policy acceptance:** atomic batch-write authz, managed indexes for JSON queries, counts/pagination, visibility transitions, revocation. Pointer: §8 implication above.
3. **Job-contract hygiene:** no process/cgroup/filesystem assumptions; explicit progress/lost-run story plus concurrency, cancellation, timeout, and resource limits. Pointer: ADR 001 Open questions.
4. **Atomic activation:** persist inputs/outputs outside execution; version flip with rollback and cache invalidation; interrupted activation restarts. Pointer: §9 implication, Phase 5 roadmap.
5. **Networking/egress:** private APIs/registries, non-HTTP, IP allowlists validated per Integration. Pointer: §6 implication, Phase 2 roadmap.
6. **Storage/search verification:** R2 uploads, signed access, multipart, metadata, cleanup, authz verified per operation; search keeps org scope/permissions/filtering with explicit reindex and async-index consistency. Pointer: Phase 4 roadmap.

## Free-tier rule (measurable)
Every proposed capability should answer:

> Can a small but useful deployment exercise this capability indefinitely within Cloudflare Free allowances?

If not, document the exact limit or missing primitive. Paid-tier escape hatches are useful findings, but they are not MVP defaults.

Measurement is mandatory, not assumed (see ADR 004 `system.smoke`):

1. Every `system.smoke` run MUST log a `usage` block with, at minimum:
   - D1: rows written/read, read/write/query counts for the run;
   - Workflow: instances started, steps executed, per-Execution duration;
   - Worker: requests handled, CPU-ms per request where the runtime exposes it.
2. The repo MUST maintain a Free-allowance vs actuals table (in docs, updated per smoke run or release), e.g.:

   | Primitive | Free allowance | Smoke actual (per run) | Notes/source |
   | --- | --- | --- | --- |
   | D1 stored rows | [verify vs current Cloudflare pricing] | measured | MVP slice state + ExecutionHistory |
   | D1 reads / writes | [verify vs current Cloudflare pricing] | measured | per `system.smoke` usage block |
   | Workflows steps / instances | [verify vs current Cloudflare pricing] | measured | Execution + Operations |
   | Workers requests / CPU-ms | [verify vs current Cloudflare pricing] | measured | Worker/API handling |

   Do not hard-code allowance numbers from memory; link the pricing/docs page checked and the date checked. Use `[verify vs current Cloudflare pricing]` where uncertain.
3. Track at least: D1 (stored data, rows, reads, writes), Workflows (steps, instances, duration/retention), Workers (requests/day, CPU-ms). Add R2/KV/ Queue/DO rows only when an ADR earns that primitive.
4. If a capability cannot stay within Free allowances for a small useful deployment, its spec entry MUST name the binding limit and propose a deferred/paid alternative — it MUST NOT silently become an MVP default.
