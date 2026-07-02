// S2 최초 접속 토큰 발급기(scripts/mint-operator-token.mjs) 경계 검증.
// 핵심 수용 기준: 발급 토큰이 서버가 실제로 쓰는 인증 경계(JwtAuthenticationBoundary + hmacJwtVerifier)를 통과하고,
// 시크릿 미설정/약함·무효 입력은 fail-closed(비-0 종료, 토큰 미출력)로 거부한다.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { hmacJwtVerifier, JwtAuthenticationBoundary } from "../src/api/auth";

const SCRIPT = fileURLToPath(new URL("../../scripts/mint-operator-token.mjs", import.meta.url));
const SECRET = "test-hs256-secret-at-least-32-characters-long";
const SHORT_SECRET = "too-short";
const TENANT = "00000000-0000-4000-8000-0000000000d1";

let failures = 0;

function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  PASS  ${label}`);
    return;
  }
  failures += 1;
  console.error(`  FAIL  ${label}${detail !== undefined ? ` :: ${detail}` : ""}`);
}

interface MintResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function mint(args: readonly string[], env: Record<string, string | undefined>): MintResult {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { status: result.status, stdout: (result.stdout ?? "").trim(), stderr: result.stderr ?? "" };
}

async function main(): Promise<void> {
  const boundary = new JwtAuthenticationBoundary(hmacJwtVerifier(new TextEncoder().encode(SECRET)));

  // 1) happy path — 발급 토큰이 실제 인증 경계를 통과하고 tenant/roles/sub 가 정확히 실린다.
  const ok = mint(["--tenant", TENANT, "--sub", "ops-admin", "--roles", "admin,operator"], { JWT_HS256_SECRET: SECRET });
  check("happy path exits 0", ok.status === 0, `status=${ok.status} stderr=${ok.stderr}`);
  check("happy path prints exactly one token line to stdout", ok.stdout.split("\n").length === 1 && ok.stdout.split(".").length === 3, ok.stdout);
  check("secret never printed", !ok.stdout.includes(SECRET) && !ok.stderr.includes(SECRET));

  const authed = await boundary.authenticate({ authorization: `Bearer ${ok.stdout}` });
  check("minted token authenticates through the real boundary", authed.kind === "authenticated", JSON.stringify(authed));
  if (authed.kind === "authenticated") {
    check("tenant claim round-trips", authed.principal.tenantId === TENANT, authed.principal.tenantId);
    check("subject claim round-trips", authed.principal.subjectId === "ops-admin", authed.principal.subjectId);
    check(
      "roles claim round-trips (order + dedup preserved)",
      JSON.stringify(authed.principal.roles) === JSON.stringify(["admin", "operator"]),
      JSON.stringify(authed.principal.roles),
    );
  }

  // 2) --roles 생략 → 기본 admin(부트스트랩 목적).
  const defaultRoles = mint(["--tenant", TENANT, "--sub", "boot"], { JWT_HS256_SECRET: SECRET });
  const defaultAuthed = await boundary.authenticate({ authorization: `Bearer ${defaultRoles.stdout}` });
  check(
    "default roles = admin when --roles omitted",
    defaultAuthed.kind === "authenticated" && JSON.stringify(defaultAuthed.principal.roles) === JSON.stringify(["admin"]),
    JSON.stringify(defaultAuthed),
  );

  // 3) 다른 시크릿으로 검증하면 서명 불일치 → 인증 미성립(401). (토큰 위조 방지 확인)
  const wrongSecretBoundary = new JwtAuthenticationBoundary(hmacJwtVerifier(new TextEncoder().encode(`${SECRET}-different`)));
  const wrong = await wrongSecretBoundary.authenticate({ authorization: `Bearer ${ok.stdout}` });
  check("token rejected under a different secret", wrong.kind === "denied" && wrong.code === "UNAUTHENTICATED", JSON.stringify(wrong));

  // 4) fail-closed: 시크릿 미설정 → 비-0 종료 + 토큰 미출력.
  const noSecret = mint(["--tenant", TENANT, "--sub", "x"], { JWT_HS256_SECRET: undefined });
  check("no secret → non-zero exit, no token", noSecret.status !== 0 && noSecret.stdout === "", `status=${noSecret.status} stdout=${noSecret.stdout}`);

  // 5) fail-closed: 약한 시크릿(<32) → 거부.
  const weak = mint(["--tenant", TENANT, "--sub", "x"], { JWT_HS256_SECRET: SHORT_SECRET });
  check("short secret → non-zero exit, no token", weak.status !== 0 && weak.stdout === "", `status=${weak.status}`);

  // 6) fail-closed: tenant 가 UUID 아님 → 거부(서버가 403 낼 토큰을 애초에 만들지 않음).
  const badTenant = mint(["--tenant", "not-a-uuid", "--sub", "x"], { JWT_HS256_SECRET: SECRET });
  check("non-UUID tenant → non-zero exit, no token", badTenant.status !== 0 && badTenant.stdout === "", `status=${badTenant.status}`);

  // 7) fail-closed: 무효 역할 → 거부.
  const badRole = mint(["--tenant", TENANT, "--sub", "x", "--roles", "superuser"], { JWT_HS256_SECRET: SECRET });
  check("invalid role → non-zero exit, no token", badRole.status !== 0 && badRole.stdout === "", `status=${badRole.status}`);

  // 8) fail-closed: --sub 누락 → 거부(암묵 기본 신원 금지).
  const noSub = mint(["--tenant", TENANT], { JWT_HS256_SECRET: SECRET });
  check("missing --sub → non-zero exit, no token", noSub.status !== 0 && noSub.stdout === "", `status=${noSub.status}`);

  // 9) --help → 0 종료(운영자 자가 안내).
  const help = mint(["--help"], { JWT_HS256_SECRET: SECRET });
  check("--help exits 0 with usage", help.status === 0 && help.stderr.includes("Usage:"), `status=${help.status}`);
}

await main();
if (failures > 0) process.exit(1);
console.log("PASS: mint-operator-token boundary green");
