# Dependency compatibility inventory (DEV-02, issue #141)

Upstream Bifrost Sagas are Python and may depend on Python-only packages,
native extensions, processes, the filesystem, or private registries. None
of that runs on Workers. This inventory (source of truth:
`DEV_COMPATIBILITY` in `src/dev.ts`, pinned by `test/dev-preview.test.ts`)
gives every class an explicit disposition: a supported TypeScript
replacement, a bounded HTTP alternative, or an explicit blocker.

**Arbitrary upstream Python execution is an explicit blocker, not a TODO.**
It is outside the accepted architecture: there is no Python runtime, no
process pool, and no shell in a Worker. Do not plan around it.

| Class | Examples | Disposition | Path |
| --- | --- | --- | --- |
| python-only-package | pandas, numpy, pydantic, httpx, jinja2 | Supported TS replacement | Re-author the transform as typed TypeScript in the Saga or a shared module; validate with the Saga parse function. Do not shell out to Python. |
| native-extension | numpy native wheels, Pillow, lxml, cryptography bindings | Blocker | Native binaries cannot run on Workers. Redesign around a bounded vendor HTTP call or drop the dependency; record the decision in the Saga. |
| process-execution | subprocess, multiprocessing, os.system, worker process pools | Blocker | No arbitrary processes. Use Workflow `step.do` Operations for durable work; Queue/Cron only when a concrete requirement earns them via ADR. |
| filesystem-access | open()/pathlib reads, tempfile, local disk caches | Bounded HTTP alternative | Workers have no local disk. Keep small state in D1 rows; managed files belong to FILE-01 (R2) when that issue lands. Until then, bounded inline payloads only. |
| private-registry | private PyPI indexes, private npm registries, git+ssh dependencies | Blocker | Breaks reproducible CI installs. Vendor the source under an AGPL-compatible license or use the public registry. |
| bounded-http-vendor | requests/httpx vendor calls, webhook delivery, OAuth token fetch | Bounded HTTP alternative | Call the vendor over bounded fetch from an Integration Action with an explicit deadline and typed error envelope (`src/integrations/`). Never expose raw vendor bytes to callers. |

`classifyDependency(spec)` maps one specifier to its row. Unknown
specifiers are blockers pending explicit review — never silently
supported. `validateLockfile` enforces the install side (exact pins,
lockfile present, default registry); `validateDeploy` enforces the venue
side (CI or local npm, never a Worker runtime).
