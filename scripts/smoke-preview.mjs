// SPDX-License-Identifier: AGPL-3.0
// Preview smoke probe (ADR 004): exercise system.smoke against a deployed
// Worker (e.g. a PR preview) over plain HTTPS. Discovers the smoke Saga ID
// from /api/sagas, so no IDs are hard-coded. Counts/IDs/statuses only —
// never logs the bearer token, headers, or bodies.
const TERMINAL = ["Succeeded", "Failed", "TimedOut", "Cancelled"];

function arg(name, fallback = undefined) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1 || index + 1 >= process.argv.length) return fallback;
  return process.argv[index + 1];
}

async function readJson(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Expected JSON but got HTTP ${response.status}: ${text.slice(0, 200)}`);
  }
}

export async function runSmoke({
  baseUrl,
  token,
  fetchImpl = globalThis.fetch,
  pollMs = 2000,
  timeoutMs = 180000,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  keyPrefix = "preview-smoke",
}) {
  const base = baseUrl.replace(/\/+$/, "");
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const catalogRes = await fetchImpl(`${base}/api/sagas`, { headers });
  if (!catalogRes.ok) throw new Error(`Saga catalog fetch failed: HTTP ${catalogRes.status}`);
  const catalog = await readJson(catalogRes);
  const saga = (catalog.sagas ?? []).find((entry) => entry.name === "system.smoke");
  if (!saga) throw new Error("system.smoke is not in the deployed catalog.");

  const submitRes = await fetchImpl(`${base}/api/executions`, {
    method: "POST",
    headers: { ...headers, "Idempotency-Key": `${keyPrefix}-${crypto.randomUUID()}` },
    body: JSON.stringify({ sagaId: saga.id, input: {} }),
  });
  if (submitRes.status !== 202 && submitRes.status !== 200) {
    throw new Error(`Execution submit failed: HTTP ${submitRes.status}`);
  }
  const { executionId } = await readJson(submitRes);
  if (typeof executionId !== "string" || executionId.length === 0) {
    throw new Error("Execution submit returned no executionId.");
  }

  const deadline = now() + timeoutMs;
  for (;;) {
    const detailRes = await fetchImpl(`${base}/api/executions/${executionId}`, { headers });
    if (!detailRes.ok) throw new Error(`Execution detail fetch failed: HTTP ${detailRes.status}`);
    const detail = await readJson(detailRes);
    if (TERMINAL.includes(detail.status)) {
      if (detail.status !== "Succeeded") {
        throw new Error(`Smoke ended ${detail.status}: ${JSON.stringify(detail.error ?? null)}`);
      }
      const failed = (detail.operations ?? []).filter((op) => op.status !== "Succeeded");
      if (failed.length > 0) throw new Error(`Smoke operations not all Succeeded: ${failed.length} failed.`);
      return { executionId, operations: (detail.operations ?? []).length };
    }
    if (now() >= deadline) throw new Error(`Timed out waiting for ${executionId} to settle.`);
    await sleep(pollMs);
  }
}

function stubFetch(scenarios) {
  const calls = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init });
      const next = scenarios.shift();
      if (!next) throw new Error(`Unexpected fetch: ${url}`);
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function selftest() {
  let passed = 0;
  const check = (name, cond) => {
    if (!cond) throw new Error(`selftest failed: ${name}`);
    passed += 1;
  };

  // Happy path: catalog, submit, running, succeeded.
  {
    const stub = stubFetch([
      jsonResponse({ sagas: [{ id: "saga-id", name: "system.smoke" }] }),
      jsonResponse({ executionId: "exec-1" }, 202),
      jsonResponse({ status: "Running", operations: [] }),
      jsonResponse({
        status: "Succeeded",
        operations: [{ name: "prepare-input-v1", status: "Succeeded" }],
      }),
    ]);
    const result = await runSmoke({
      baseUrl: "https://preview.test",
      token: "tok",
      fetchImpl: stub.fetch,
      pollMs: 0,
      sleep: async () => {},
    });
    check("happy execution id", result.executionId === "exec-1");
    check("happy operations", result.operations === 1);
    check(
      "idempotency key sent",
      String(stub.calls[1]?.init?.headers?.["Idempotency-Key"] ?? "").startsWith("preview-smoke-"),
    );
  }

  // Missing saga in catalog.
  {
    const stub = stubFetch([jsonResponse({ sagas: [] })]);
    let error = null;
    try {
      await runSmoke({ baseUrl: "https://preview.test", token: "tok", fetchImpl: stub.fetch });
    } catch (e) {
      error = e;
    }
    check("missing saga throws", /system\.smoke/.test(String(error)));
  }

  // Rejected submit.
  {
    const stub = stubFetch([
      jsonResponse({ sagas: [{ id: "saga-id", name: "system.smoke" }] }),
      new Response("bad", { status: 500 }),
    ]);
    let error = null;
    try {
      await runSmoke({ baseUrl: "https://preview.test", token: "tok", fetchImpl: stub.fetch });
    } catch (e) {
      error = e;
    }
    check("rejected submit throws", /HTTP 500/.test(String(error)));
  }

  // Terminal failure surfaces the code, not the body.
  {
    const stub = stubFetch([
      jsonResponse({ sagas: [{ id: "saga-id", name: "system.smoke" }] }),
      jsonResponse({ executionId: "exec-2" }, 202),
      jsonResponse({ status: "Failed", error: { code: "EXECUTION_FAILED" } }),
    ]);
    let error = null;
    try {
      await runSmoke({ baseUrl: "https://preview.test", token: "tok", fetchImpl: stub.fetch });
    } catch (e) {
      error = e;
    }
    check("failed execution throws", /Failed/.test(String(error)));
  }

  // Non-succeeded operation fails the probe.
  {
    const stub = stubFetch([
      jsonResponse({ sagas: [{ id: "saga-id", name: "system.smoke" }] }),
      jsonResponse({ executionId: "exec-3" }, 202),
      jsonResponse({ status: "Succeeded", operations: [{ name: "x", status: "Failed" }] }),
    ]);
    let error = null;
    try {
      await runSmoke({ baseUrl: "https://preview.test", token: "tok", fetchImpl: stub.fetch });
    } catch (e) {
      error = e;
    }
    check("failed operation throws", /not all Succeeded/.test(String(error)));
  }

  // Never-settling execution hits the deadline.
  {
    const stub = stubFetch([
      jsonResponse({ sagas: [{ id: "saga-id", name: "system.smoke" }] }),
      jsonResponse({ executionId: "exec-4" }, 202),
      jsonResponse({ status: "Running", operations: [] }),
      jsonResponse({ status: "Running", operations: [] }),
    ]);
    let error = null;
    try {
      await runSmoke({
        baseUrl: "https://preview.test",
        token: "tok",
        fetchImpl: stub.fetch,
        pollMs: 0,
        timeoutMs: 0,
        sleep: async () => {},
      });
    } catch (e) {
      error = e;
    }
    check("deadline throws", /Timed out/.test(String(error)));
  }

  console.log(`preview smoke selftest: ${passed} passed.`);
}

const invokedAsCli = process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"));
if (invokedAsCli) {
  const mode = process.argv[2];
  if (mode === "selftest") {
    await selftest();
  } else {
    const baseUrl = arg("base-url", "");
    const token = arg("token", "");
    if (!baseUrl || !token) {
      console.error("Usage: node scripts/smoke-preview.mjs --base-url URL --token TOKEN | selftest");
      process.exitCode = 2;
    } else {
      try {
        const result = await runSmoke({ baseUrl, token });
        console.log(`preview smoke passed: ${result.executionId} (${result.operations} operations).`);
      } catch (error) {
        console.error(`preview smoke failed: ${error instanceof Error ? error.message : error}`);
        process.exitCode = 1;
      }
    }
  }
}
