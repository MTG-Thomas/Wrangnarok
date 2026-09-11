import { describe, expect, it } from "vitest";
import { bindFormInput, parseFormFields, validateFormInput } from "../src/forms";
import { helloSaga } from "../src/domain";

const declaration = [{ name: "name", type: "text", required: true, maxLength: 1024 }] as const;
const fields = parseFormFields(structuredClone(declaration));
const def = {
  id: "a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c4d5",
  orgId: "00000000-0000-4000-8000-000000000001",
  name: "hello-greeting",
  sagaId: helloSaga.id,
  fields,
};

describe("form declaration contract", () => {
  it("accepts the pilot declaration and rejects malformed ones", () => {
    expect(parseFormFields(structuredClone(declaration))).toEqual([
      { name: "name", type: "text", required: true, maxLength: 1024 },
    ]);
    expect(parseFormFields([{ name: "nickname", type: "text", required: false }])).toEqual([
      { name: "nickname", type: "text", required: false, maxLength: 1024 },
    ]);
    const bad: unknown[] = [
      [],
      "fields",
      [{ name: "name", type: "text", required: true, extra: 1 }],
      [{ name: "9lives", type: "text", required: true }],
      [
        { name: "name", type: "text", required: true },
        { name: "name", type: "text", required: false },
      ],
      [{ name: "name", type: "number", required: true }],
      [{ name: "name", type: "text", required: "yes" }],
      [{ name: "name", type: "text", required: true, maxLength: 0 }],
      [{ name: "name", type: "text", required: true, maxLength: 2048 }],
      Array.from({ length: 51 }, (_, index) => ({ name: `f${index}`, type: "text", required: false })),
    ];
    for (const value of bad) expect(() => parseFormFields(value)).toThrow();
  });
  it("validates submissions field by field and binds the Saga input", () => {
    expect(validateFormInput(fields, { name: "Ada" })).toEqual({ name: "Ada" });
    expect(bindFormInput(def, { name: "Ada" })).toMatchObject({ input: { name: "Ada" } });
    const optional = parseFormFields([{ name: "nickname", type: "text", required: false, maxLength: 8 }]);
    expect(validateFormInput(optional, {})).toEqual({});
    expect(validateFormInput(optional, { nickname: null })).toEqual({});
    const failure = (value: unknown): { code: string; field: string }[] => {
      try {
        validateFormInput(fields, value);
      } catch (error) {
        const fault = error as { status?: number; code?: string; details?: { field: string; code: string }[] };
        expect(fault.status).toBe(422);
        expect(fault.code).toBe("FORM_VALIDATION_FAILED");
        return (fault.details ?? []).map((entry) => ({ code: entry.code, field: entry.field }));
      }
      throw new Error("expected validateFormInput to throw");
    };
    expect(failure({ name: "" })).toEqual([{ code: "REQUIRED", field: "name" }]);
    // A declaration that drifts from its Saga schema surfaces the Saga 400,
    // distinct from field-level 422s: the form gate passed, the Saga gate refused.
    expect(() => bindFormInput({ ...def, sagaId: helloSaga.id, fields: optional }, {})).toThrow(
      expect.objectContaining({ status: 400, code: "INVALID_INPUT" }),
    );
  });
});
