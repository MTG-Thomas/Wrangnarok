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

Error mapping used: 401 `NINJA_UNAUTHORIZED`, 429 `NINJA_RATE_LIMITED`, 5xx `NINJA_VENDOR_FAILED`, non-array `NINJA_BAD_RESPONSE`, 3xx rejected (workerd has no `redirect:error`), slow vendor/abort `NINJA_VENDOR_TIMEOUT` (explicit 5s deadline per call; Sagas route it to the `timeout-mark-v1` checkpoint, never inferred).

Runtime facts: workerd `fetch` rejects `redirect:error` (use `manual` plus explicit 3xx handling); cross-realm `Request` construction from Workflow-isolate init fails (read headers directly); D1 `exec()` rejects leading SQL comments.

**Wrangnarök implication:** derive the token host from the Connection endpoint (region-portable, no per-region code). Pin OAuth scope as the least-privilege precedent for future OAuth work. Shape and count-cap vendor list responses before persisting; never assume small.

### 14. Execution state machine, retry, timeout, cancellation (upstream sweep, Sep 2026)

Upstream statuses, verbatim from `api/src/models/enums.py`: `Scheduled`, `Pending`, `Running`, `Success`, `Failed`, `Timeout`, `Stuck`, `CompletedWithErrors`, `Cancelling`, `Cancelled`. `Scheduled` is a durable pre-publish row (promotable when due); `Pending` is published-but-unclaimed and is never swept; `Cancelling` is the transient cancel-requested state; `Stuck` is legacy/query-only (the sweeper now writes `Timeout`/`Cancelled`); `CompletedWithErrors` is the success-with-errors variant ADR 001 omits.

Retry is off by default and narrow when on: `ExecutionRetryPolicy` (disabled unless enabled, max 2) plus an operator ceiling, both required. Only engine-loss retries (republish with `Pending` reset) — never business-error retry. Infrastructure redelivery is separate (backed-off delays, poison-letter queue when exhausted).

Timeouts are per-workflow (default 1800s, 0 disables); a 5-minute sweeper moves `Running`-past-timeout to `Timeout`, `Scheduled`-24h-overdue to `Failed`, and `Cancelling`-over-3-minutes to `Cancelled`.

Cancellation is owner-or-superuser only: `Scheduled`/`Pending` cancel immediately, `Running` goes to `Cancelling` with a cancel flag the worker honors, re-cancel is idempotent, terminal states are not cancellable.

Ambiguity is fenced, never guessed: advisory locks plus attempt-token claim fences, stale callbacks rejected unless the row is still `Running`/`Cancelling` with a matching token, `Scheduled` stays durable until broker confirm, and missing state surfaces as failure — never invented success.

**Wrangnarök implication (feeds issue #15):** adopt an explicit `Cancelling` state plus stale-token rejection; gate retries to engine-loss with an operator ceiling (Workflow step retry 2 risks retrying non-idempotent mutations); keep a durable pre-publish `Scheduled` distinct from `Pending` and never sweep `Pending` — the current 10-minute expiry conflates queue backup with lost dispatch.

### 15. Integration SDK and OAuth contracts (upstream sweep, Sep 2026)

The SDK is workflow-facing, not vendor-facing: `@workflow`/`@tool` decorators, typed errors, and `integrations.get(name, scope, oauth_scope)` with decrypted secrets auto-registered for log scrubbing. There are deliberately **no** request/response normalization or pagination helpers — vendor calls are raw workflow HTTP plus OAuth URL templating and config merge. Vendor-call discipline comes from elsewhere: a concurrency admission slot (fail-closed, never retries the vendor op), GET-only 5xx retry, 10s timeouts with backoff, and 4xx-no-retry.

OAuth storage splits portable from per-organization state: global providers/tokens (null org) carry defaults; per-org rows carry overrides; client secrets and tokens are Fernet-encrypted while names, URLs, scopes, and expiry stay plaintext. Refresh runs in one shared primitive used by the scheduler (15-minute cadence, refresh within 20 minutes of expiry), the on-demand endpoint, and inline client-credentials auto-refresh; failures mark the token failed and emit events. Requested scopes must be a subset of configured scopes.

Portable definitions declare needs (`SolutionConnectionSchema`); resolution falls back org row → defaults, org overrides winning, token mapping → org token → most-recent global token. Requirement failures are loud when declared (HTTP 424) and silent (`None`/404) when undeclared; 403s propagate.

**Wrangnarök implication (feeds Phase 3):** copy the 424-fail-loud-on-declared vs silent-None-otherwise split instead of a uniform `CONNECTION_NOT_CONFIGURED`; put refresh in one shared primitive with per-Connection status rather than per-Saga code; enforce subset-only scope overrides with an explicit, auditable fallback order before adopting any global cascade.

### 16. Files/artifacts: policy-checked URLs, finalize-after-PUT, versioned deletes (upstream sweep, Sep 2026)

All pins at vendor/upstream commit `0598020e` (2026-09-04).

Uploads and downloads go through server-minted presigned S3 URLs, never through the API process as a pipe: `PUT`/`GET` URLs are generated only after per-action policy checks (`signed_get`, `signed_put`, `delete`) scoped by location, org scope, and path, with declared-solution-location requirements on writes (`api/src/routers/files.py:922-1029`). URL expiry is bounded 1 second to 7 days, default 600 (`files.py:165-184`); batch issuance caps at 100 with per-path allow/deny results (`files.py:187-205,1737-1747`).

Reads tier across scopes with an existence-first match — the shared read-only fallback pattern, again (`files.py:942-986`). Writes require a declared location plus policy. A browser `PUT` is not trusted until the client finalizes it with asserted metadata (path, content-type, size, sha256: `SignedUploadCompleteRequest`, `files.py:208`).

Deletes are policy-checked, mutation-locked, and optimistic-versioned: missing file or stale version answers `409` (`file_missing`, `version_conflict`) rather than silently succeeding (`files.py:1306-1365`). Retention is opt-in scheduled cleanup, default 90 days, range 1–3650 (`api/src/models/contracts/artifact_retention.py:6-21`; `api/src/routers/maintenance.py:60-122`). Size caps are per-surface, not global: logos 5 MB (`routers/branding.py:28`), avatars 2 MB (`routers/profile.py:27`), form file fields enforce per-field `max_size_mb` (`routers/forms.py:1937-1942`), chat caps attachments per message. Large objects stream via multipart without full-memory retention (`api/src/services/file_storage/s3_client.py:215-280`). File policies are CRUD-managed with pubsub invalidation (`files.py:881-919`); structural listing is admin-only (`files.py:218-228`); a policy access-test endpoint exists (`files.py:249-264`).

**Wrangnarök implication (feeds Phase 4):** Artifacts stay Deferred, but the required shape is now pinned — R2 presigned URLs plus D1 metadata plus per-Operation authorization, with finalize-after-PUT, versioned deletes, and a retention policy as mandatory pieces. No Container or Worker-local filesystem persistence assumptions; per-surface byte caps stated explicitly rather than inherited.

### 17. App SDK and forms: async invoke, owner-scoped reads, declared fields (upstream sweep, Sep 2026)

All pins at vendor/upstream commit `0598020e` (2026-09-04).

Invocation is async-only: `POST /api/workflows/execute` returns an execution ID plus status, never the result; terminal state arrives over WS frames while the result still needs `GET /api/executions/{id}` (`api/src/routers/workflows.py:734-744`; `app-sdk/use-workflow.ts:17-31`). There is no client deadline; the app polls at 2 s and retries only 404/408/429/5xx, fast-failing other 4xx (`use-workflow.ts:76-89,250-256`). The web client is a generated OpenAPI client whose retry discipline is method-shaped: `GET`/`PUT`/`DELETE` retry 502/503/504 with 250/750/2000 ms backoff, `POST`/`PATCH` never (`client/src/lib/api-client.ts:1-13,35-82`). Path refs (`path::fn`) scope to the calling install via app ID plus org scope (`app-sdk/use-workflow.ts:91-99,147-157`).

Execution reads are owner-scoped for non-admins, with redaction of variables/context/memory/CPU and hidden `DEBUG`/`TRACEBACK` logs (`api/src/routers/executions.py:155-190,337-366,462-522`). The UI polls detail every 2 s while `Pending`/`Running` and tolerates brief 404s; cancel invalidates list plus detail (`hooks/useExecutions.ts:66-126,180-200`).

Forms bind by name: each field name is a workflow parameter name, max 50 fields with unique names, from a closed type enum (`api/src/models/contracts/forms.py:68-70,134-146`; `api/src/models/enums.py:33-48`). The server validates submissions against the persisted field declarations — unknown names rejected, display-only types excluded — with per-type coercion and checks (email, ISO dates, option membership, pattern/min/max) and hard caps (200 keys, 256 KB) (`api/src/services/shared/form_runtime.py:32-157`; `contracts/forms.py:231-278`). Launch merges validated input over defaults, exposes inputs top-level plus `context.form_inputs`, and a deferred submit inserts a `SCHEDULED` row instead of running inline (`api/src/routers/forms.py:1354-1395`). Dynamic option providers and auto-fill targets are declared and capped (50 keys/64 KB option fetch); launch requires a random session-bound startup handle with a 30-minute TTL, and submitting without one is `422` (`form_runtime.py:178-231`). Public/embed forms need a fresh capability fingerprint and exact-match origins, no wildcards (`form_runtime.py:358-441`). Authz tiers run authenticated-minus-externals, everyone, role-based, private(owner), with unset-means-authenticated and unknown-means-deny; direct execution is allowlisted (admin, form/app grantee, integration-tied provider); form submit uses the form gate as authoritative, bypassing workflow RBAC anchored to the form org (`api/src/routers/forms.py:1322-1337`).

**Wrangnarök implication (feeds Phase 4):** Dynamic forms stay Deferred, verdict confirmed — the surface (providers, startup handles, fingerprints, embed fencing) is orthogonal to the MVP. When forms arrive: field-names-bind-to-Saga-inputs, server-validates-against-persisted-declaration, submit-gate-as-authoritative, and embed fingerprinting are the invariants to keep. The method-shaped SDK retry discipline (`GET` retries, `POST` never) is worth copying into our client now. AI-assisted-development (Adopt as philosophy) and Git-based management (Adopt) verdicts stand confirmed with no new runtime contract.

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

- current integration SDK and OAuth implementation contracts (swept, §15);
- files/artifacts (swept, §16);
- app/web SDK and forms (swept, §17);
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
