/**
 * AjvStructuredOutputValidator — production `StructuredOutputValidator` (llm-gateway.ts §5) backed by ajv.
 *
 * Validates an extract/json output `value` against the inline JSON Schema **body** carried on the gateway
 * request's `responseFormat.schema` (sourced from the IR extract node's `args.schema` — see ir-translate.ts;
 * schema_ref/schemaVersion stay as identity/versioning). Replaces the test-fake validators; no schema
 * registry/table is introduced (the body travels inline with the scenario).
 *
 * Fail-closed ("조용한 false/unknown 금지"): a missing/non-object schema body, or a body that does not
 * compile as a JSON Schema, yields `{ ok: false }` with a redacted reason — never a silent pass. Compiled
 * validators are cached by the schema body itself (stable identity), so an inline body change recompiles.
 */
import Ajv2020, { type ValidateFunction } from "ajv/dist/2020";

import type { StructuredOutputValidator } from "./llm-gateway";

export class AjvStructuredOutputValidator implements StructuredOutputValidator {
  private readonly ajv: Ajv2020;
  private readonly cache = new Map<string, ValidateFunction>();

  constructor() {
    // strict:false — extract output schemas are scenario-authored and may use varied JSON Schema dialects;
    // we validate structure, not author ajv-strictness. allErrors for a complete redacted reason.
    this.ajv = new Ajv2020({ allErrors: true, strict: false });
  }

  validate(input: { schemaRef: string; schemaVersion: string; schema?: unknown; value: unknown }):
    | { ok: true }
    | { ok: false; reason: string } {
    const id = `${input.schemaRef}@${input.schemaVersion}`;
    if (input.schema === null || typeof input.schema !== "object") {
      return { ok: false, reason: `no JSON Schema body for ${id} (extract requires an inline schema)` };
    }

    // Cache by the body's stable identity (not ref@version, which is only a label for an inline body).
    const cacheKey = JSON.stringify(input.schema);
    let validateFn = this.cache.get(cacheKey);
    if (validateFn === undefined) {
      try {
        validateFn = this.ajv.compile(input.schema as Record<string, unknown>);
      } catch (e) {
        return { ok: false, reason: `invalid JSON Schema for ${id}: ${e instanceof Error ? e.message : String(e)}` };
      }
      this.cache.set(cacheKey, validateFn);
    }

    if (validateFn(input.value) === true) return { ok: true };
    const reason = this.ajv.errorsText(validateFn.errors, { separator: "; " });
    return { ok: false, reason: reason.length > 0 ? `${id}: ${reason}` : `${id}: schema validation failed` };
  }
}
