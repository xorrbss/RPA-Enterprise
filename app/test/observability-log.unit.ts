/**
 * observability/log.ts 단위 — worker/runtime 구조화 로깅(O3) 계약 고정.
 * level 라우팅(error/warn/info)·JSON 형상(level+at+msg+snake_case id 키)·null 정직 방출·errText message 추출.
 */
import { errText, redactUrlSecrets, workerLog } from "../src/observability/log";

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    process.stderr.write(`  FAIL  ${label}${detail !== undefined ? ` — ${detail}` : ""}\n`);
  }
}

function capture(fn: () => void): { error: string[]; warn: string[]; log: string[] } {
  const out = { error: [] as string[], warn: [] as string[], log: [] as string[] };
  const orig = { error: console.error, warn: console.warn, log: console.log };
  console.error = (...a: unknown[]) => out.error.push(a.map(String).join(" "));
  console.warn = (...a: unknown[]) => out.warn.push(a.map(String).join(" "));
  console.log = (...a: unknown[]) => out.log.push(a.map(String).join(" "));
  try {
    fn();
  } finally {
    console.error = orig.error;
    console.warn = orig.warn;
    console.log = orig.log;
  }
  return out;
}

function main(): void {
  // level 라우팅: error→console.error, warn→console.warn, info→console.log
  const e = capture(() => workerLog("error", { at: "t", msg: "boom" }));
  check("error → console.error", e.error.length === 1 && e.warn.length === 0 && e.log.length === 0);
  const w = capture(() => workerLog("warn", { at: "t", msg: "warn" }));
  check("warn → console.warn", w.warn.length === 1 && w.error.length === 0);
  const i = capture(() => workerLog("info", { at: "t", msg: "info" }));
  check("info → console.log", i.log.length === 1 && i.error.length === 0);

  // JSON 형상: 한 줄 JSON, level+at+msg+구조화 필드, snake_case 트레이스 키
  const out = capture(() =>
    workerLog("error", { at: "runtime-worker", msg: "INIT 실패", run_id: "r-1", correlation_id: "c-1", tenant_id: "t-1", error: "kaboom" }),
  );
  const parsed = JSON.parse(out.error[0] ?? "{}") as Record<string, unknown>;
  check("JSON 한 줄 파싱 가능", out.error.length === 1);
  check("level 필드", parsed.level === "error");
  check("at/msg 필드", parsed.at === "runtime-worker" && parsed.msg === "INIT 실패");
  check("run_id 전체 보존(절단 없음, 트레이스 join 키)", parsed.run_id === "r-1");
  check("correlation_id/tenant_id snake_case 키", parsed.correlation_id === "c-1" && parsed.tenant_id === "t-1");
  check("임의 구조화 필드(error) 보존", parsed.error === "kaboom");

  // null 정직 방출(날조 금지): correlation 부재 시 null 키로 명시
  const n = capture(() => workerLog("warn", { at: "t", msg: "m", run_id: "r", correlation_id: null }));
  const np = JSON.parse(n.warn[0] ?? "{}") as Record<string, unknown>;
  check("null id 는 null 로 방출(누락/날조 아님)", np.correlation_id === null && np.run_id === "r");

  // errText: Error → message, 비-Error → String
  check("errText(Error) → message", errText(new Error("nope")) === "nope");
  check("errText(string) → 원문", errText("raw failure") === "raw failure");
  check("errText(non-error object) → String()", errText({ code: 1 }) === "[object Object]");

  // redactUrlSecrets: URL 쿼리/프래그먼트 비밀 마스킹(navigate 누출 차단), scheme://host/path 진단 보존 (적대감사 #C1)
  check(
    "navigate 에러 URL 쿼리스트링 토큰 마스킹",
    redactUrlSecrets("page.goto: net::ERR_NAME_NOT_RESOLVED at https://sso.corp.example/login?ticket=SECRET123&u=bob") ===
      "page.goto: net::ERR_NAME_NOT_RESOLVED at https://sso.corp.example/login?<redacted>",
  );
  check(
    "URL 프래그먼트 토큰 마스킹(OAuth implicit #access_token)",
    redactUrlSecrets("nav failed https://app.example/cb#access_token=AKIA_SECRET") === "nav failed https://app.example/cb#<redacted>",
  );
  check("쿼리/프래그먼트 없는 URL 은 보존", redactUrlSecrets("at https://host.example/path/x") === "at https://host.example/path/x");
  check("URL 아닌 텍스트 불변", redactUrlSecrets("plain timeout exceeded") === "plain timeout exceeded");
  check(
    "errText 가 URL 쿼리 비밀 마스킹(로그 경계)",
    errText(new Error("goto https://h.example/p?token=t0p")) === "goto https://h.example/p?<redacted>",
  );

  if (failures > 0) {
    process.stderr.write(`\nobservability-log.unit: ${failures} FAIL\n`);
    process.exit(1);
  }
  console.log("\nobservability-log.unit: ALL PASS");
}

main();
