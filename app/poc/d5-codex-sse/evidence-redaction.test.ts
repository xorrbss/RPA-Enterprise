import {
  buildCodexEvidenceRedactions,
  errorEvidence,
  markdownCell,
  redactEvidence,
  validateCodexBaseUrl,
  validateEvidenceAlias,
  validatePositiveIntegerEnv,
} from "./evidence-redaction";

const SECRET_FRAGMENTS = [
  "sk-proj-abc1234567890",
  "sk-proj-json1234567890",
  "secret-value",
  "token-value",
  "hunter2",
  "abc.def.ghi",
  "basic-user",
  "basic-pass",
  "query-secret",
];

let failures = 0;

function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  PASS  ${label}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` - ${detail}` : ""}`);
  }
}

function checkThrows(label: string, fn: () => unknown, messagePattern: RegExp): void {
  try {
    fn();
    check(label, false, "accepted invalid input");
  } catch (error) {
    check(label, error instanceof Error && messagePattern.test(error.message), "unexpected error message");
  }
}

const redacted = redactEvidence(
  [
    "authorization: Bearer abc.def.ghi",
    "CODEX_API_KEY=sk-proj-abc1234567890",
    "refresh_token='token-value'",
    'client_secret="secret-value"',
    '"api_key":"sk-proj-json1234567890"',
    "password: hunter2",
    "https://basic-user:basic-pass@example.test/v1?api_key=query-secret",
  ].join(" "),
);

for (const [index, fragment] of SECRET_FRAGMENTS.entries()) {
  check(`redacts secret-like fragment ${index + 1}`, !redacted.includes(fragment), "secret-like material remained");
}
check("keeps redaction markers", redacted.includes("[REDACTED]"), "missing redaction marker");

const error = errorEvidence(new Error("provider returned api_key=sk-proj-abc1234567890"));
check("redacts Error messages", !error.includes("sk-proj-abc1234567890"), "secret-like material remained");

const cell = markdownCell("a|b token=token-value");
check("escapes markdown pipes", cell.includes("a\\|b"), cell);
check("redacts markdown cells", !cell.includes("token-value"), "secret-like material remained");

const multiline = markdownCell("first\nsecond\rthird\tfourth");
check("normalizes markdown cells to one line", !/[\r\n\t]/.test(multiline), multiline);

const bounded = markdownCell(`prefix ${"x".repeat(700)} token=token-value`);
check("bounds markdown cell length", bounded.length <= 500, `${bounded.length}`);
check("redacts before truncation", !bounded.includes("token-value"), "secret-like material remained");

const liveRules = buildCodexEvidenceRedactions({
  baseUrl: "https://live.example.test/v1",
  apiKey: "opaque-live-key-value",
  model: "codex-real-model-2026",
  endpointAlias: "[staging-endpoint]",
  modelAlias: "[staging-model]",
});

const liveProviderDetail = markdownCell(
  [
    "CODEX_BASE_URL=https://live.example.test/v1",
    "CODEX_API_KEY=opaque-live-key-value",
    "CODEX_MODEL=codex-real-model-2026",
    "provider rejected model codex-real-model-2026 at https://live.example.test/v1/chat/completions",
    "authorization: Bearer opaque-live-key-value",
  ].join(" "),
  liveRules,
);

for (const fragment of ["https://live.example.test/v1", "live.example.test", "codex-real-model-2026", "opaque-live-key-value"]) {
  check(`redacts live configured value ${fragment}`, !liveProviderDetail.includes(fragment), "configured value remained");
}
check("uses endpoint alias in live redaction", liveProviderDetail.includes("[staging-endpoint]"), liveProviderDetail);
check("uses model alias in live redaction", liveProviderDetail.includes("[staging-model]"), liveProviderDetail);

const liveError = errorEvidence(
  new Error("HTTP 400 model=codex-real-model-2026 endpoint=https://live.example.test/v1 apiKey=opaque-live-key-value"),
  liveRules,
);
check("redacts configured values in Error evidence", !/live\.example|codex-real-model|opaque-live-key/.test(liveError), liveError);

const normalizedBaseUrl = validateCodexBaseUrl(" https://SERVICE.EXAMPLE.test/v1/// ");
check("normalizes valid absolute CODEX_BASE_URL", normalizedBaseUrl === "https://service.example.test/v1", normalizedBaseUrl);

checkThrows(
  "rejects CODEX_BASE_URL userinfo",
  () => validateCodexBaseUrl("https://user:pass@service.example.test/v1"),
  /username\/password/,
);
checkThrows(
  "rejects CODEX_BASE_URL query",
  () => validateCodexBaseUrl("https://service.example.test/v1?debug=true"),
  /query or fragment/,
);
checkThrows(
  "rejects CODEX_BASE_URL bare query delimiter",
  () => validateCodexBaseUrl("https://service.example.test/v1?"),
  /query or fragment/,
);
checkThrows(
  "rejects CODEX_BASE_URL fragment",
  () => validateCodexBaseUrl("https://service.example.test/v1#section"),
  /query or fragment/,
);
checkThrows(
  "rejects CODEX_BASE_URL bare fragment delimiter",
  () => validateCodexBaseUrl("https://service.example.test/v1#"),
  /query or fragment/,
);
checkThrows("rejects CODEX_BASE_URL not-a-url", () => validateCodexBaseUrl("service.example.test/v1"), /absolute https URL/);
checkThrows(
  "rejects CODEX_BASE_URL missing authority delimiter",
  () => validateCodexBaseUrl("https:service.example.test/v1"),
  /absolute https URL/,
);
checkThrows(
  "rejects CODEX_BASE_URL non-HTTPS scheme",
  () => validateCodexBaseUrl("http://service.example.test/v1"),
  /absolute https URL/,
);

check(
  "defaults missing CODEX_MAX_CONTEXT_TOKENS",
  validatePositiveIntegerEnv("CODEX_MAX_CONTEXT_TOKENS", undefined, 8192) === 8192,
);
check(
  "accepts positive CODEX_MAX_CONTEXT_TOKENS",
  validatePositiveIntegerEnv("CODEX_MAX_CONTEXT_TOKENS", "128000", 8192) === 128000,
);
checkThrows(
  "rejects CODEX_MAX_CONTEXT_TOKENS zero",
  () => validatePositiveIntegerEnv("CODEX_MAX_CONTEXT_TOKENS", "0", 8192),
  /positive integer/,
);
checkThrows(
  "rejects CODEX_MAX_CONTEXT_TOKENS decimal",
  () => validatePositiveIntegerEnv("CODEX_MAX_CONTEXT_TOKENS", "8192.5", 8192),
  /positive integer/,
);
checkThrows(
  "rejects CODEX_MAX_CONTEXT_TOKENS unsafe integer",
  () => validatePositiveIntegerEnv("CODEX_MAX_CONTEXT_TOKENS", "9007199254740993", 8192),
  /positive safe integer/,
);

const endpointAlias = validateEvidenceAlias("CODEX_EVIDENCE_ENDPOINT_ALIAS", "[reference-endpoint]");
check("accepts bracketed endpoint evidence alias", endpointAlias === "[reference-endpoint]", endpointAlias);

const modelAlias = validateEvidenceAlias("CODEX_EVIDENCE_MODEL_ALIAS", "[reference-model]");
check("accepts bracketed model evidence alias", modelAlias === "[reference-model]", modelAlias);

checkThrows(
  "rejects URL-like evidence alias",
  () => validateEvidenceAlias("CODEX_EVIDENCE_ENDPOINT_ALIAS", "https://service.example.test/v1"),
  /redacted alias/,
);
checkThrows(
  "rejects evidence alias with whitespace",
  () => validateEvidenceAlias("CODEX_EVIDENCE_MODEL_ALIAS", "reference model"),
  /redacted alias/,
);
checkThrows(
  "rejects unbracketed evidence alias",
  () => validateEvidenceAlias("CODEX_EVIDENCE_MODEL_ALIAS", "reference-model"),
  /redacted alias/,
);
checkThrows(
  "rejects secret-like evidence alias",
  () => validateEvidenceAlias("CODEX_EVIDENCE_ENDPOINT_ALIAS", "secret-endpoint"),
  /redacted alias/,
);

if (failures > 0) {
  console.error(`\nFAIL: ${failures} evidence redaction check(s) failed`);
  process.exit(1);
}

console.log("\nPASS: D5 evidence redaction self-test green");
