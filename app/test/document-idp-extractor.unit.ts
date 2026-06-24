import { extractDocumentFields, parseDocumentFieldSchema } from "../src/api/document-idp-extractor";

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` - ${detail}` : ""}`);
  }
}

const schema = parseDocumentFieldSchema([
  { key: "invoice_id", label: "Invoice ID", required: true, aliases: ["송장 번호"], patterns: ["INV-(\\d+)"], min_confidence: 0.8 },
  { key: "total", label: "Total", type: "number", required: true, aliases: ["금액"], min_confidence: 0.8 },
  { key: "approved", label: "Approved", type: "boolean", required: false, min_confidence: 0.7 },
]);

const jsonResult = extractDocumentFields(JSON.stringify({ invoice_id: "INV-7", total: 12000, approved: true }), schema);
check("json fields complete", jsonResult.status === "completed" && jsonResult.missingFields.length === 0, JSON.stringify(jsonResult));
check("json confidence high", jsonResult.fields.every((field) => field.status === "extracted"), JSON.stringify(jsonResult.fields));

const csvResult = extractDocumentFields('invoice_id,total,approved\n"INV-8","12,000","true"', schema);
check("quoted CSV fields complete", csvResult.status === "completed" && csvResult.missingFields.length === 0, JSON.stringify(csvResult));
check("quoted CSV comma stays in the same value", csvResult.fields.find((field) => field.key === "total")?.value === "12,000", JSON.stringify(csvResult.fields));

const labelResult = extractDocumentFields("송장 번호: INV-9\n금액: 9900", schema);
check("label extraction routes low confidence to validation", labelResult.status === "validation_required", JSON.stringify(labelResult));
check("optional missing field does not require validation", !labelResult.missingFields.includes("approved"), JSON.stringify(labelResult.missingFields));
check("low-confidence required fields require validation", labelResult.missingFields.includes("total"), JSON.stringify(labelResult.missingFields));

try {
  parseDocumentFieldSchema([{ key: "", label: "bad" }]);
  check("invalid schema rejected", false);
} catch {
  check("invalid schema rejected", true);
}

try {
  parseDocumentFieldSchema([{ key: "bad_pattern", label: "Bad", patterns: ["("] }]);
  check("invalid regex pattern rejected", false);
} catch {
  check("invalid regex pattern rejected", true);
}

if (failures > 0) {
  console.error(`FAIL: ${failures} document IDP extractor check(s) failed`);
  process.exit(1);
}
console.log("PASS: document IDP extractor unit green");
