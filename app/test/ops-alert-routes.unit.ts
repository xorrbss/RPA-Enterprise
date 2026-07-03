// S4a OPS_ALERT_ROUTES env 파서(parseOpsAlertRoutes) 검증 — 유효 규칙 파싱 + 형식 오류 fail-closed.
import { OPS_ALERT_AUTO_FIRE_SOURCES, parseOpsAlertRoutes } from "../src/api/ops-alert-routes";

let failures = 0;
function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  PASS  ${label}`);
    return;
  }
  failures += 1;
  console.error(`  FAIL  ${label}${detail !== undefined ? ` :: ${detail}` : ""}`);
}

function expectThrow(label: string, fn: () => unknown): void {
  try {
    fn();
    failures += 1;
    console.error(`  FAIL  ${label} :: expected throw`);
  } catch {
    console.log(`  PASS  ${label}`);
  }
}

function main(): void {
  // 미설정/빈 → 빈 배열(자동 발화 없음, 정직).
  check("undefined → empty", parseOpsAlertRoutes(undefined).length === 0);
  check("blank → empty", parseOpsAlertRoutes("   ").length === 0);

  // 유효 규칙(전 필드) 파싱.
  const full = parseOpsAlertRoutes(
    JSON.stringify([
      {
        source: "run_sla",
        min_severity: "critical",
        provider_alias: "oncall",
        endpoint_secret_ref: "secret://ops/webhook",
        allowed_hosts: ["hooks.example.com"],
        route_policy_ref: "route:oncall",
        recipient_group_ref: "grp:oncall",
        callback_signature_secret_ref: "secret://ops/callback",
      },
    ]),
  );
  check("valid full route parses", full.length === 1
    && full[0]!.source === "run_sla"
    && full[0]!.minSeverity === "critical"
    && full[0]!.providerAlias === "oncall"
    && full[0]!.endpointSecretRef === "secret://ops/webhook"
    && JSON.stringify(full[0]!.allowedHosts) === JSON.stringify(["hooks.example.com"])
    && full[0]!.routePolicyRef === "route:oncall"
    && full[0]!.recipientGroupRef === "grp:oncall"
    && full[0]!.callbackSignatureSecretRef === "secret://ops/callback", JSON.stringify(full[0]));

  // source 생략 → 모든 대상 소스(undefined).
  const noSource = parseOpsAlertRoutes(
    JSON.stringify([{ min_severity: "warning", provider_alias: "p", endpoint_secret_ref: "secret://a/b", allowed_hosts: ["h.example.com"], route_policy_ref: "r" }]),
  );
  check("omitted source → undefined (all sources)", noSource[0]!.source === undefined);

  // S4b: session_expiry 도 자동 발화 소스로 허용된다(detected_at=expires_at 안정).
  const sessionExpiry = parseOpsAlertRoutes(
    JSON.stringify([{ source: "session_expiry", min_severity: "warning", provider_alias: "p", endpoint_secret_ref: "secret://a/b", allowed_hosts: ["h.example.com"], route_policy_ref: "r" }]),
  );
  check("session_expiry source parses", sessionExpiry.length === 1 && sessionExpiry[0]!.source === "session_expiry", JSON.stringify(sessionExpiry[0]));

  // A4-3: artifact_redaction 도 자동 발화 소스로 허용된다(detected_at=원장 행 타임스탬프 안정).
  const artifactRedaction = parseOpsAlertRoutes(
    JSON.stringify([{ source: "artifact_redaction", min_severity: "critical", provider_alias: "p", endpoint_secret_ref: "secret://a/b", allowed_hosts: ["h.example.com"], route_policy_ref: "r" }]),
  );
  check("artifact_redaction source parses", artifactRedaction.length === 1 && artifactRedaction[0]!.source === "artifact_redaction", JSON.stringify(artifactRedaction[0]));

  // fail-closed 케이스.
  expectThrow("non-array JSON throws", () => parseOpsAlertRoutes(JSON.stringify({ min_severity: "warning" })));
  expectThrow("malformed JSON throws", () => parseOpsAlertRoutes("{not json"));
  expectThrow("invalid source throws", () =>
    parseOpsAlertRoutes(JSON.stringify([{ source: "bot_pool", min_severity: "warning", provider_alias: "p", endpoint_secret_ref: "secret://a/b", allowed_hosts: ["h"], route_policy_ref: "r" }])));
  expectThrow("invalid min_severity throws", () =>
    parseOpsAlertRoutes(JSON.stringify([{ min_severity: "info", provider_alias: "p", endpoint_secret_ref: "secret://a/b", allowed_hosts: ["h"], route_policy_ref: "r" }])));
  expectThrow("non-secret endpoint ref throws", () =>
    parseOpsAlertRoutes(JSON.stringify([{ min_severity: "warning", provider_alias: "p", endpoint_secret_ref: "https://a/b", allowed_hosts: ["h"], route_policy_ref: "r" }])));
  expectThrow("empty allowed_hosts throws", () =>
    parseOpsAlertRoutes(JSON.stringify([{ min_severity: "warning", provider_alias: "p", endpoint_secret_ref: "secret://a/b", allowed_hosts: [], route_policy_ref: "r" }])));
  expectThrow("missing route_policy_ref throws", () =>
    parseOpsAlertRoutes(JSON.stringify([{ min_severity: "warning", provider_alias: "p", endpoint_secret_ref: "secret://a/b", allowed_hosts: ["h"] }])));
  expectThrow("missing provider_alias throws", () =>
    parseOpsAlertRoutes(JSON.stringify([{ min_severity: "warning", endpoint_secret_ref: "secret://a/b", allowed_hosts: ["h"], route_policy_ref: "r" }])));

  // 자동 발화 소스 allowlist 는 detected_at 안정 소스만(멱등 세대 키 보호). session_expiry 는 detected_at=expires_at.
  check("auto-fire sources are the stable-detected_at set", JSON.stringify([...OPS_ALERT_AUTO_FIRE_SOURCES]) === JSON.stringify(["run_sla", "human_task_sla", "trigger_fire", "failure_spike", "session_expiry", "artifact_redaction"]));
}

main();
if (failures > 0) process.exit(1);
console.log("PASS: ops-alert-routes parser green");
