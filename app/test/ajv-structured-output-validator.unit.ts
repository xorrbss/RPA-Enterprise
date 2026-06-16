/**
 * AjvStructuredOutputValidator unit test — production §5 structured-output validation (ajv) over an inline
 * JSON Schema body. Locks the fail-closed contract ("조용한 false/unknown 금지"): valid value passes;
 * schema violations fail with a reason; a missing/non-object/uncompilable schema body fails closed.
 */
import { AjvStructuredOutputValidator } from "../src/gateway/ajv-structured-output-validator";

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail !== undefined ? ` — ${detail}` : ""}`);
  }
}

function main(): void {
  const v = new AjvStructuredOutputValidator();
  const schema: Record<string, unknown> = {
    type: "object",
    properties: { name: { type: "string" }, n: { type: "integer" } },
    required: ["name"],
    additionalProperties: false,
  };

  // valid
  check("valid value passes", v.validate({ schemaRef: "reviews", schemaVersion: "1", schema, value: { name: "a", n: 3 } }).ok === true);

  // missing required
  const r1 = v.validate({ schemaRef: "reviews", schemaVersion: "1", schema, value: { n: 3 } });
  check("missing required fails", r1.ok === false);
  check("missing required reason names field", r1.ok === false && r1.reason.includes("name"), r1.ok === false ? r1.reason : "");

  // wrong type
  check("wrong type fails", v.validate({ schemaRef: "reviews", schemaVersion: "1", schema, value: { name: 1 } }).ok === false);

  // additionalProperties:false → extra key fails
  check("extra prop fails", v.validate({ schemaRef: "reviews", schemaVersion: "1", schema, value: { name: "a", extra: 1 } }).ok === false);

  // fail-closed: no schema body
  const r2 = v.validate({ schemaRef: "reviews", schemaVersion: "1", value: { name: "a" } });
  check("no schema body fails closed", r2.ok === false);
  check("no schema reason mentions schema", r2.ok === false && r2.reason.toLowerCase().includes("schema"));

  // fail-closed: non-object schema
  check("non-object schema fails closed", v.validate({ schemaRef: "x", schemaVersion: "1", schema: "nope" as unknown, value: {} }).ok === false);

  // fail-closed: uncompilable schema (unresolvable $ref)
  const rBad = v.validate({ schemaRef: "x", schemaVersion: "1", schema: { $ref: "#/does/not/exist" } as Record<string, unknown>, value: {} });
  check("uncompilable schema fails closed", rBad.ok === false);

  // cache: same body reused, still correct on a different value
  check("cached schema still validates", v.validate({ schemaRef: "reviews", schemaVersion: "1", schema, value: { name: "b" } }).ok === true);
  check("cached schema still rejects", v.validate({ schemaRef: "reviews", schemaVersion: "1", schema, value: {} }).ok === false);

  if (failures > 0) {
    console.error(`\najv-structured-output-validator.unit: ${failures} FAIL`);
    process.exit(1);
  }
  console.log("\najv-structured-output-validator.unit: ALL PASS");
}

main();
