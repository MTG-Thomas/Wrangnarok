// SPDX-License-Identifier: AGPL-3.0
// Forms-to-Saga input binding (FORM-01, issue #118; ADR 015).
//
// A Form is a persisted, Organization-scoped declaration that names the Saga it
// feeds plus the fields it accepts. Field names bind to Saga inputs by name
// (upstream invariant, docs/upstream-spec.md finding 17): the server validates
// a submission against the persisted declaration — unknown names rejected —
// and only validated input reaches the Saga parse gate. No renderer, no
// provider, no publication: binding only (FORM-02 owns the rest).
import { Fault, parseSubmission, UUID } from "./domain";
import type { FieldFailure, SagaDef } from "./domain";

/** Closed v1 field type set. Only text ships; new types arrive with FORM-02. */
export const FORM_FIELD_TYPES = ["text"] as const;
export type FormFieldType = (typeof FORM_FIELD_TYPES)[number];

export interface FormField {
  readonly name: string;
  readonly type: FormFieldType;
  readonly required: boolean;
  readonly maxLength: number;
}

export interface FormDefinition {
  readonly id: string;
  readonly orgId: string;
  readonly name: string;
  readonly sagaId: string;
  readonly fields: readonly FormField[];
}

export interface FormSubmission {
  readonly saga: SagaDef;
  readonly input: unknown;
}

export const FORM_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const FIELD_NAME = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;
export const FORM_MAX_FIELDS = 50;
export const FORM_MAX_KEYS = 200;
export const FORM_FIELD_MAX_LENGTH = 1024;

interface FormRow {
  id: string;
  org_id: string;
  name: string;
  saga_id: string;
  fields_json: string;
}

/** Validate one persisted field declaration (fail closed: corrupt declarations
 * are a server defect, never caller input). */
export function parseFormFields(value: unknown): FormField[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > FORM_MAX_FIELDS) {
    throw new Error("Form declaration must list 1 to 50 fields.");
  }
  const seen = new Set<string>();
  return value.map((entry) => {
    if (
      entry === null ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      Object.keys(entry).some((key) => !["name", "type", "required", "maxLength"].includes(key))
    ) {
      throw new Error("Form fields declare only name, type, required, and maxLength.");
    }
    const field = entry as Record<string, unknown>;
    if (typeof field.name !== "string" || !FIELD_NAME.test(field.name)) {
      throw new Error("Form field names must start with a letter and hold letters, digits, or underscores.");
    }
    if (seen.has(field.name)) throw new Error(`Duplicate form field "${field.name}".`);
    seen.add(field.name);
    if (field.type !== "text") throw new Error(`Form field "${field.name}" has an unsupported type.`);
    if (typeof field.required !== "boolean") throw new Error(`Form field "${field.name}" must declare required.`);
    let maxLength = FORM_FIELD_MAX_LENGTH;
    if (field.maxLength !== undefined) {
      if (!Number.isInteger(field.maxLength) || (field.maxLength as number) < 1 || (field.maxLength as number) > 1024) {
        throw new Error(`Form field "${field.name}" maxLength must be an integer from 1 to 1024.`);
      }
      maxLength = field.maxLength as number;
    }
    return { name: field.name, type: "text" as const, required: field.required, maxLength };
  });
}

/** Load one persisted declaration for this Organization. Unknown names (or
 * foreign-Organization names) resolve to null so the route answers 404,
 * never a cross-tenant leak. */
export async function loadForm(db: D1Database, orgId: string, name: string): Promise<FormDefinition | null> {
  const row = await db
    .prepare("SELECT id,org_id,name,saga_id,fields_json FROM forms WHERE org_id=? AND name=?")
    .bind(orgId, name)
    .first<FormRow>();
  if (!row) return null;
  if (!UUID.test(row.id) || !UUID.test(row.saga_id)) throw new Error("Form declaration carries invalid identity.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.fields_json);
  } catch {
    throw new Error("Form declaration is not valid JSON.");
  }
  return { id: row.id, orgId: row.org_id, name: row.name, sagaId: row.saga_id, fields: parseFormFields(parsed) };
}

/** Validate a submission against the persisted declaration. Unknown field
 * names are rejected; per-field failures accumulate into one 422 Fault whose
 * details carry the structured per-field list. */
export function validateFormInput(fields: readonly FormField[], value: unknown): Record<string, string> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Fault(422, "FORM_VALIDATION_FAILED", "The form submission must be a JSON object.", [
      { field: "", code: "NOT_OBJECT", message: "The form submission must be a JSON object." },
    ] satisfies FieldFailure[]);
  }
  const body = value as Record<string, unknown>;
  const keys = Object.keys(body);
  if (keys.length > FORM_MAX_KEYS) {
    throw new Fault(422, "FORM_VALIDATION_FAILED", "The form submission carries too many fields.", [
      { field: "", code: "TOO_MANY_FIELDS", message: `At most ${FORM_MAX_KEYS} fields are accepted.` },
    ] satisfies FieldFailure[]);
  }
  const declared = new Map(fields.map((field) => [field.name, field]));
  const failures: FieldFailure[] = [];
  for (const key of keys) {
    if (!declared.has(key))
      failures.push({ field: key, code: "UNKNOWN_FIELD", message: "This field is not declared." });
  }
  const validated: Record<string, string> = {};
  for (const field of fields) {
    const entry = body[field.name];
    if (entry === undefined || entry === null) {
      if (field.required) failures.push({ field: field.name, code: "REQUIRED", message: "This field is required." });
      continue;
    }
    if (typeof entry !== "string") {
      failures.push({ field: field.name, code: "NOT_STRING", message: "This field must be a string." });
      continue;
    }
    if (field.required && entry.length === 0) {
      failures.push({ field: field.name, code: "REQUIRED", message: "This field is required." });
      continue;
    }
    if (new TextEncoder().encode(entry).length > field.maxLength) {
      failures.push({
        field: field.name,
        code: "TOO_LONG",
        message: `At most ${field.maxLength} UTF-8 bytes are accepted.`,
      });
      continue;
    }
    validated[field.name] = entry;
  }
  if (failures.length > 0) {
    throw new Fault(422, "FORM_VALIDATION_FAILED", "The form submission did not pass validation.", failures);
  }
  return validated;
}

/** Bind a submission to its Saga: form-gate validation first, then the Saga
 * parse gate (a drift between declaration and Saga schema surfaces as the
 * Saga 400 INVALID_INPUT, distinct from field-level 422s). */
export function bindFormInput(def: FormDefinition, body: unknown): FormSubmission {
  const validated = validateFormInput(def.fields, body);
  const { saga, input } = parseSubmission({ sagaId: def.sagaId, input: validated });
  return { saga, input };
}
