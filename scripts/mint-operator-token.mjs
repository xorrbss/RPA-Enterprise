#!/usr/bin/env node
/**
 * 파일럿 최초 접속용 관리자/운영자 토큰 발급기 (HS256).
 *
 * 왜 있나: IdP(SSO) 연동 전 파일럿 단계에서 콘솔에 처음 접속하려면 sub·tenant_id·roles·exp 클레임을 담은
 *   JWT 가 필요하다. 이 절차가 제품·runbook 어디에도 없어 첫 접속 자체가 소스코드 독해를 요구했다(2026-07-02 감사 S2).
 *   이 스크립트가 그 공백을 닫는다. 서버의 HS256 검증기(app/src/api/auth.ts hmacJwtVerifier)와 동일한 클레임·알고리즘.
 *
 * 의존성 없음: node:crypto 만 사용(jose 불필요) → `npm install --prefix app` 없이 어느 배포 셸에서도 실행된다.
 *
 * 사용:
 *   JWT_HS256_SECRET=<서버와 동일한 시크릿> \
 *     node scripts/mint-operator-token.mjs --tenant <uuid> --sub <id> [--roles admin,operator] [--expires 12h]
 *
 * 시크릿(JWT_HS256_SECRET)은 서버 기동에 쓰는 값과 반드시 같아야 하며(같은 키로 서명·검증), 32자 이상이어야 한다
 *   (HS256 키 강도 — 서버 env 검증과 동일 기준). 시크릿은 출력하지 않는다.
 *
 * 출력: 발급된 JWT 를 stdout 으로 1줄 출력(파이프·복사용). 진단/안내는 stderr. 실패는 비-0 종료(토큰 미출력, fail-closed).
 */
import { createHmac } from "node:crypto";

const VALID_ROLES = new Set(["viewer", "operator", "reviewer", "approver", "admin"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MIN_SECRET_LENGTH = 32; // app/src/config/env.ts 와 동일(HS256 키 강도)

function fail(lines) {
  console.error(["FAIL:", ...lines.map((line) => `  ${line}`)].join("\n"));
  process.exit(2);
}

function printUsage() {
  console.error(
    [
      "Usage: JWT_HS256_SECRET=<secret> node scripts/mint-operator-token.mjs --tenant <uuid> --sub <id> [options]",
      "",
      "Required:",
      "  --tenant <uuid>   테넌트 ID(UUID). 서버 RLS/인가의 테넌트 경계.",
      "  --sub <id>        접속 주체 식별자. 감사 로그 귀속에 쓰인다(예: 사람은 UUID, 서비스는 안정적 식별자).",
      "",
      "Options:",
      "  --roles <csv>     쉼표 구분 역할. 기본 admin. 유효: viewer,operator,reviewer,approver,admin",
      "  --expires <dur>   만료 기간. 기본 12h. 형식: <N>s|m|h|d 또는 초 단위 정수(예: 30m, 8h, 7d, 3600).",
      "  --help, -h        이 도움말.",
      "",
      "Environment:",
      "  JWT_HS256_SECRET  서버 기동에 쓰는 것과 동일한 HS256 시크릿(32자 이상). 필수.",
      "",
      "예:",
      "  JWT_HS256_SECRET=$RPA_JWT_SECRET \\",
      "    node scripts/mint-operator-token.mjs --tenant 00000000-0000-4000-8000-0000000000d1 --sub ops-admin --roles admin",
    ].join("\n"),
  );
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") return { help: true };
    if (!arg.startsWith("--")) fail([`unexpected argument: ${arg}`, "run with --help for usage."]);
    const key = arg.slice(2);
    const known = ["tenant", "sub", "roles", "expires"];
    if (!known.includes(key)) fail([`unknown option: ${arg}`, "run with --help for usage."]);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) fail([`option ${arg} requires a value.`]);
    out[key] = value;
    i += 1;
  }
  return out;
}

// <N>s|m|h|d 또는 bare seconds → 초. 무효는 throw(조용한 기본값 대체 금지).
function parseDurationSeconds(raw) {
  const match = /^(\d+)([smhd]?)$/.exec(raw.trim());
  if (match === null) throw new Error(`invalid --expires "${raw}" (expected e.g. 30m, 8h, 7d, or seconds)`);
  const n = Number(match[1]);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`invalid --expires "${raw}" (must be a positive integer)`);
  const unit = match[2] || "s";
  const factor = { s: 1, m: 60, h: 3600, d: 86400 }[unit];
  return n * factor;
}

function base64url(input) {
  return Buffer.from(input).toString("base64url");
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help === true) {
    printUsage();
    process.exit(0);
  }

  const secret = process.env.JWT_HS256_SECRET ?? "";
  if (secret.length === 0) {
    fail([
      "JWT_HS256_SECRET environment variable is required (fail-closed).",
      "이 값은 서버 기동에 쓰는 것과 동일한 HS256 시크릿이어야 합니다.",
      "배포 runbook 의 '최초 접속' 절을 참고하세요.",
    ]);
  }
  if (secret.length < MIN_SECRET_LENGTH) {
    fail([`JWT_HS256_SECRET must be at least ${MIN_SECRET_LENGTH} characters (HS256 key strength; matches server env check).`]);
  }

  const tenant = args.tenant;
  if (tenant === undefined) fail(["--tenant <uuid> is required.", "run with --help for usage."]);
  if (!UUID_RE.test(tenant)) fail([`--tenant must be a UUID, got "${tenant}".`]);

  const sub = args.sub;
  if (sub === undefined || sub.trim().length === 0) fail(["--sub <id> is required and must be non-empty.", "run with --help for usage."]);

  const rolesRaw = args.roles ?? "admin";
  const roles = rolesRaw.split(",").map((r) => r.trim()).filter((r) => r.length > 0);
  if (roles.length === 0) fail(["--roles must contain at least one role."]);
  const invalidRoles = roles.filter((r) => !VALID_ROLES.has(r));
  if (invalidRoles.length > 0) {
    fail([`invalid role(s): ${invalidRoles.join(", ")}`, `valid roles: ${[...VALID_ROLES].join(", ")}`]);
  }
  const dedupedRoles = [...new Set(roles)];

  let expiresSeconds;
  try {
    expiresSeconds = parseDurationSeconds(args.expires ?? "12h");
  } catch (err) {
    fail([err instanceof Error ? err.message : String(err)]);
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const header = { alg: "HS256", typ: "JWT" };
  const payload = {
    sub: sub.trim(),
    tenant_id: tenant,
    roles: dedupedRoles,
    iat: nowSeconds,
    exp: nowSeconds + expiresSeconds,
  };

  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signature = createHmac("sha256", secret).update(signingInput).digest("base64url");
  const token = `${signingInput}.${signature}`;

  // 진단은 stderr(토큰 파이프를 오염시키지 않음). 시크릿은 절대 출력하지 않는다.
  const expiresAt = new Date(payload.exp * 1000).toISOString();
  console.error(
    [
      "발급 완료(HS256):",
      `  tenant : ${tenant}`,
      `  sub    : ${payload.sub}`,
      `  roles  : ${dedupedRoles.join(", ")}`,
      `  expires: ${expiresAt} (in ${expiresSeconds}s)`,
      "",
      "콘솔 접속: 접속 화면의 '접속 코드' 입력란에 아래 stdout 토큰을 붙여넣으세요.",
    ].join("\n"),
  );
  // 토큰만 stdout 으로(복사·파이프용).
  console.log(token);
}

main();
