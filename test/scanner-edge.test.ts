// Edge-case unit tests for the Saga authoring contract helpers in src/saga.ts:
// definition validation plus the determinism-scanner internals (quoting,
// comments, templates, regex detection) and JSON-serializability rules.
import { expect, it } from "vitest";
import {
  assertDeterministicRun,
  assertJsonSerializable,
  buildCatalog,
  buildOrgCtx,
  defineSaga,
  stripStepDoBodies,
  validateSagaDefinition,
} from "../src/saga";
import type { SagaDefinition } from "../src/saga";

const VALID_ID = "aaaaaaaa-1111-4111-8111-111111111111";

function baseDef(overrides: Partial<SagaDefinition> = {}): SagaDefinition {
  return {
    id: VALID_ID,
    name: "probe",
    revision: "r1",
    description: "probe saga",
    requiredIntegrations: [],
    parse: (value: unknown) => value,
    run: async () => ({}),
    ...overrides,
  } as SagaDefinition;
}

it("rejects malformed identity, tags, and run shapes", async () => {
  expect(() => validateSagaDefinition(baseDef({ id: "not-a-uuid" }))).toThrow(/stable UUID/);
  expect(() => validateSagaDefinition(baseDef({ name: "Bad Name!" }))).toThrow(/simple slug/);
  expect(() => validateSagaDefinition(baseDef({ revision: "" }))).toThrow(/revision/);
  expect(() => validateSagaDefinition(baseDef({ revision: "r".repeat(65) }))).toThrow(/revision/);
  expect(() => validateSagaDefinition(baseDef({ description: "" }))).toThrow(/description/);
  expect(() => validateSagaDefinition(baseDef({ tags: [""] }))).toThrow(/tags/);
  expect(() => validateSagaDefinition(baseDef({ tags: ["x".repeat(33)] }))).toThrow(/tags/);
  expect(() => validateSagaDefinition(baseDef({ tags: "nope" as never }))).toThrow(/tags/);
  expect(() => validateSagaDefinition(baseDef({ parse: undefined as never }))).toThrow(/parse and run/);
  expect(() => validateSagaDefinition(baseDef({ run: undefined as never }))).toThrow(/parse and run/);
  expect(() => validateSagaDefinition(baseDef({ requiredIntegrations: undefined as never }))).toThrow(
    /requiredIntegrations must be declared/,
  );
  expect(defineSaga(baseDef({ name: "probe-two" }))).toMatchObject({ name: "probe-two" });
});

it("skips escaped quotes inside step bodies", async () => {
  const stripped = stripStepDoBodies('step.do("a\\n\\"b", async () => 1); tail');
  expect(stripped).toContain(".do()");
  expect(stripped).toContain("tail");
  expect(stripped).not.toContain("async () => 1");
});

it("tolerates unterminated strings and calls", async () => {
  expect(stripStepDoBodies('step.do("abc')).toBe("step.do()");
  expect(stripStepDoBodies('step.do("x", async () => 1')).toBe("step.do()");
});

it("skips block comments with parens inside step bodies", async () => {
  const stripped = stripStepDoBodies('step.do(/* note (with parens) */ "x", async () => { return 1; }); tail');
  expect(stripped).toContain(".do()");
  expect(stripped).toContain("tail");
  expect(stripped).not.toContain("with parens");
  // An unterminated block comment runs to the end of input.
  expect(stripStepDoBodies('step.do("x", () => 1 /* oops')).toBe("step.do()");
});

it("runs a trailing line comment to the end of input", async () => {
  expect(stripStepDoBodies('step.do("x", () => 1 // trailing')).toBe("step.do()");
});

it("runs an unterminated regex to the end of input", async () => {
  expect(stripStepDoBodies('step.do("x", () => { const r = /abc')).toBe("step.do()");
});

it("skips template escapes, nesting, and unterminated templates", async () => {
  const stripped = stripStepDoBodies("step.do(`a\\`b${JSON.stringify({ c: (1) })}`, async () => 2); tail");
  expect(stripped).toContain(".do()");
  expect(stripped).toContain("tail");
  expect(stripped).not.toContain("JSON.stringify");
  expect(stripStepDoBodies("step.do(`abc")).toBe("step.do()");
});

it("distinguishes regex literals from division inside step bodies", async () => {
  const withRegex = stripStepDoBodies(
    'step.do("x", () => { if (typeof s !== "string") return /a[/]+b\\/c/gi.test(s); return total / count; }); tail',
  );
  expect(withRegex).toContain("tail");
  expect(withRegex).not.toContain("typeof s");
  // Regex after a keyword starts a literal; division after a value does not.
  const keywordRegex = stripStepDoBodies('step.do("x", () => { return /re/.test(s); }); tail');
  expect(keywordRegex).toContain("tail");
  expect(keywordRegex).not.toContain("/re/");
  const bracketDivision = stripStepDoBodies('step.do("x", () => { const q = x[0] / 2; return q; }); tail');
  expect(bracketDivision).toContain("tail");
  expect(bracketDivision).not.toContain("x[0]");
  // A newline-terminated almost-regex still blanks the call body.
  const newlineRegex = stripStepDoBodies('step.do("x", () => { const r = /abc\nreturn r; }); tail');
  expect(newlineRegex).toContain("tail");
});

it("still flags forbidden tokens hidden behind scanner edge cases", async () => {
  async function sneaky(_ctx: never, step: never): Promise<unknown> {
    const pattern = /a[/]+b/gi;
    const ratio = 1 / 2;
    void pattern;
    void ratio;
    await fetch("http://127.0.0.1:9/unused");
    return (step as { do(name: string, fn: () => Promise<unknown>): Promise<unknown> }).do("real-v1", async () => ({
      ok: true,
    }));
  }
  expect(() => assertDeterministicRun("sneaky", sneaky as never)).toThrow(/fetch.*outside step\.do/);
});

it("rejects symbols, bigints, and accepts null-prototype objects", async () => {
  expect(() => assertJsonSerializable({ sym: Symbol("s") })).toThrow(/symbol/);
  expect(() => assertJsonSerializable({ big: 10n })).toThrow(/bigint/);
  expect(() => assertJsonSerializable({ nested: { big: 1n } }, "input")).toThrow(/input\.nested\.big/);
  const nullProto = Object.assign(Object.create(null), { a: 1, nested: [1, "two", null] });
  expect(() => assertJsonSerializable(nullProto)).not.toThrow();
  expect(() => assertJsonSerializable("plain", "label")).not.toThrow();
});

it("builds step-scoped organization contexts with and without an operation", async () => {
  const row = {
    id: "ab".repeat(32),
    org_id: "00000000-0000-4000-8000-000000000001",
    user_id: "00000000-0000-4000-8000-000000000002",
    saga_id: VALID_ID,
    saga_revision: "r1",
    dispatched: 1,
  };
  expect(buildOrgCtx(row)).toMatchObject({ orgId: row.org_id, attemptToken: `${row.id}:1` });
  expect(buildOrgCtx(row)).not.toHaveProperty("operationId");
});

it("mirrors optional catalog metadata when present", async () => {
  const entries = buildCatalog([baseDef({ category: "probe", tags: ["t"] })]);
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({ category: "probe", tags: ["t"] });
});
