/**
 * SecretStore resolution smoke harness — row 48 evidence (release-open-checklist.md row 48,
 * staging-decision-proposals.md §[EXTERNAL-FACT] 2 "AppRole는 row 48 smoke에서 실증").
 *
 * 프로덕션 코드(app/src/secrets 의 VaultSecretStore + VaultSecretStoreBoundary + app/src/api 의
 * PgDurableSecurityAuditDecisionWriter)를 **그대로** 라이브 Vault + PostgreSQL 에 대고 실증한다 — 재구현 아님.
 *
 * 실증 시나리오(오너 확정 access matrix, D8-A12):
 *   [A] authorized : identity=runtime-worker, purpose=resume_token_hmac,
 *       ref=rpa/staging/runtime-worker/resume_token_hmac/active → ALLOW
 *   [B] unauthorized: identity=browser-worker, purpose=gateway_policy,
 *       ref=rpa/staging/llm-gateway/gateway_policy/codex-primary → DENY (least-privilege)
 *
 * 자격증명은 env 로만 주입(레포에 남기지 않음). 출력은 REDACTED — 토큰/시크릿/AppRole 절대 미출력.
 * [A]=ALLOW && [B]=DENY 가 아니면 nonzero exit.
 *
 * 환경변수 + 실행법 + 캡처할 증거: app/poc/secretstore-smoke/README.md 참조.
 */
import { randomUUID } from "node:crypto";

import { PgDurableSecurityAuditDecisionWriter } from "../../src/api/security-audit";
import { createPool } from "../../src/db/pool";
import { SecretAccessDeniedError, VaultSecretStoreBoundary } from "../../src/secrets/vault-secret-store-boundary";
import { VaultSecretStore } from "../../src/secrets/vault-secret-store";
import type { SecretRef } from "../../../ts/core-types";
import type {
  AuditedSecurityDecision,
  AuthenticatedPrincipal,
  DurableSecurityAuditDecisionWriter,
  PrincipalId,
  SecretAccessRequest,
  SecurityAuditDecisionAppendInput,
  TenantId,
} from "../../../ts/security-middleware-contract";

function env(name: string): string {
  const v = process.env[name];
  if (v === undefined || v.trim() === "") {
    throw new Error(`missing env ${name} (자격증명/엔드포인트 미주입 — smoke 실행 불가)`);
  }
  return v.trim();
}

// === env ===
const VAULT_ADDR = env("VAULT_ADDR");
const VAULT_MOUNT = process.env.VAULT_MOUNT?.trim() || "secret";
const TENANT_ID = env("SMOKE_TENANT_ID") as TenantId;

// 시나리오별 AppRole 자격(런타임 identity 격리 — 각 워커는 자기 role 만 보유).
const RUNTIME_WORKER = {
  roleId: env("VAULT_RUNTIME_WORKER_ROLE_ID"),
  secretId: env("VAULT_RUNTIME_WORKER_SECRET_ID"),
};
const BROWSER_WORKER = {
  roleId: env("VAULT_BROWSER_WORKER_ROLE_ID"),
  secretId: env("VAULT_BROWSER_WORKER_SECRET_ID"),
};

// 출력 자체-검열용 비밀 문자열 집합(원시값은 화면/리포트에 절대 미등장).
const SECRET_STRINGS = [
  RUNTIME_WORKER.roleId,
  RUNTIME_WORKER.secretId,
  BROWSER_WORKER.roleId,
  BROWSER_WORKER.secretId,
].filter((s) => s.length > 0);

const REF_AUTHORIZED = "rpa/staging/runtime-worker/resume_token_hmac/active" as SecretRef;
const REF_UNAUTHORIZED = "rpa/staging/llm-gateway/gateway_policy/codex-primary" as SecretRef;

function principal(runtimeIdentity: string, subject: string): AuthenticatedPrincipal {
  return {
    subjectId: subject as PrincipalId,
    tenantId: TENANT_ID,
    roles: ["admin"],
    source: "jwt",
    claims: { runtime_identity: runtimeIdentity },
  };
}

interface RowResult {
  scenario: string;
  identity: string;
  refPath: string;
  expected: "ALLOW" | "DENY";
  observed: "ALLOW" | "DENY" | "ERROR";
  auditId: string;
  auditHash: string;
  detail: string;
}

/** boundary 를 시나리오별 AppRole 자격으로 구성(워커 identity 격리). */
function makeBoundary(appRole: { roleId: string; secretId: string }, audit: DurableSecurityAuditDecisionWriter): VaultSecretStoreBoundary {
  const store = new VaultSecretStore({
    baseUrl: VAULT_ADDR,
    mount: VAULT_MOUNT,
    kvApiVersion: 2,
    appRole,
  });
  return new VaultSecretStoreBoundary({ store, audit });
}

/**
 * 라이브 실증 한 행. resolveAuthorized 를 호출하되, 반환된 PlainSecret 은 **절대 보관/출력하지 않는다**
 * (값 확인은 "에러 없이 resolve 됨" 으로만 — 시크릿 값은 리포트에 들어가지 않는다).
 * 감사 id/hash 는 직후 별도 audit.recordDecision 으로 만든 영수증이 아니라, boundary 가 남긴 감사를
 * 조회해 가져온다 — 단순화 위해 본 하니스는 동일 입력으로 audit writer 가 반환하는 record 를 직접 캡처한다.
 */
async function runScenario(
  scenario: string,
  identity: string,
  appRole: { roleId: string; secretId: string },
  req: SecretAccessRequest,
  expected: "ALLOW" | "DENY",
  captured: CapturingAudit,
): Promise<RowResult> {
  const refPath = String(req.ref);
  const boundary = makeBoundary(appRole, captured);
  let observed: "ALLOW" | "DENY" | "ERROR";
  let detail = "";
  try {
    const secret = await boundary.resolveAuthorized(req);
    // 값은 절대 출력하지 않는다 — 길이 0 여부만 무누설 표식으로 사용.
    observed = "ALLOW";
    // PlainSecret 값은 절대 materialize/출력하지 않는다 — .length(숫자)로 non-empty 여부만.
    detail = `resolved ok (PlainSecret non-empty: ${secret.length > 0})`;
  } catch (e) {
    if (e instanceof SecretAccessDeniedError) {
      observed = "DENY";
      detail = "SECRET_ACCESS_DENIED (least-privilege)";
    } else {
      observed = "ERROR";
      detail = redactErr(e);
    }
  }
  const rec = captured.last();
  return {
    scenario,
    identity,
    refPath,
    expected,
    observed,
    auditId: rec?.hash ? `seq#${rec.sequence}` : "(none)",
    auditHash: rec?.hash ? redact(rec.hash) : "(none)",
    detail,
  };
}

async function main(): Promise<void> {
  const pool = createPool();
  const audit = new PgDurableSecurityAuditDecisionWriter(pool);
  const captured = new CapturingAudit(audit);

  const rows: RowResult[] = [];
  try {
    rows.push(
      await runScenario(
        "[A] authorized",
        "runtime-worker",
        RUNTIME_WORKER,
        { principal: principal("runtime-worker", "svc-runtime-worker"), ref: REF_AUTHORIZED, purpose: "resume_token_hmac" },
        "ALLOW",
        captured,
      ),
    );
    rows.push(
      await runScenario(
        "[B] unauthorized",
        "browser-worker",
        BROWSER_WORKER,
        { principal: principal("browser-worker", "svc-browser-worker"), ref: REF_UNAUTHORIZED, purpose: "gateway_policy" },
        "DENY",
        captured,
      ),
    );
  } finally {
    await pool.end().catch(() => undefined);
  }

  // === REDACTED report (assemble once → scan the SAME string → then print) ===
  const lines: string[] = [
    "# SecretStore resolution smoke — row 48 evidence (REDACTED)\n",
    `- vault mount: ${VAULT_MOUNT}`,
    `- tenant: ${redact(TENANT_ID)}\n`,
    "| 시나리오 | identity | ref path | expected | observed | audit | audit hash | detail |",
    "|---|---|---|---|---|---|---|---|",
  ];
  for (const r of rows) {
    lines.push(
      `| ${r.scenario} | ${r.identity} | ${r.refPath} | ${r.expected} | \`${r.observed}\` | ${r.auditId} | ${cell(r.auditHash)} | ${cell(r.detail)} |`,
    );
  }
  const printed = lines.join("\n");

  // === redaction self-check (gate) ===
  // 실제 출력 문자열 printed + redact 이전 raw rows 둘 다 스캔 → AppRole 리터럴 또는 Vault
  // 토큰-형태(hvs./hvb./s.)/Bearer 가 하나라도 있으면 FAIL. 누출 시 안전 라벨만 출력(값 재노출 금지).
  // resolve된 PlainSecret 값은 리포트에 절대 담기지 않는다(길이 boolean만).
  const rawProbe = JSON.stringify(rows);
  const leaked = [...new Set([...scanForLeaks(printed), ...scanForLeaks(rawProbe)])];
  const selfCheckPass = leaked.length === 0;
  console.log(printed);
  console.log(
    `\nredaction self-check: ${selfCheckPass ? "PASS (no AppRole credential / token-shape in printed output or raw report)" : `FAIL (${leaked.length} leak categories: ${leaked.join(", ")})`}`,
  );

  const a = rows.find((r) => r.scenario.startsWith("[A]"));
  const b = rows.find((r) => r.scenario.startsWith("[B]"));
  const pass = selfCheckPass && a?.observed === "ALLOW" && b?.observed === "DENY";
  console.log(`\n결과: [A]=${a?.observed} [B]=${b?.observed} → ${pass ? "PASS" : "FAIL"}`);
  if (!pass) {
    console.error("FAIL: row 48 requires [A]=ALLOW, [B]=DENY, and a clean redaction self-check.");
  }
  process.exitCode = pass ? 0 : 1;
}

/**
 * 라이브 boundary 가 남긴 감사 record 를 캡처하는 래퍼(증거 id/hash 출력용).
 * 실제 PgDurableSecurityAuditDecisionWriter 에 위임하되 마지막 record 를 보관한다.
 */
class CapturingAudit implements DurableSecurityAuditDecisionWriter {
  private lastRecord?: { sequence: number; hash: string };
  constructor(private readonly inner: DurableSecurityAuditDecisionWriter) {}
  async recordDecision<TDecision>(
    input: SecurityAuditDecisionAppendInput,
    decision: TDecision,
  ): Promise<AuditedSecurityDecision<TDecision>> {
    const result = await this.inner.recordDecision(input, decision);
    this.lastRecord = { sequence: result.auditRecord.sequence, hash: result.auditRecord.hash };
    return result;
  }
  last(): { sequence: number; hash: string } | undefined {
    return this.lastRecord;
  }
}

/** AppRole 자격/토큰-유사 문자열을 출력 전 검열. */
function redact(value: string): string {
  let out = value;
  for (const s of SECRET_STRINGS) {
    if (s.length > 0) out = out.split(s).join("[REDACTED]");
  }
  return out
    .replace(/\b(hvs\.|s\.)[A-Za-z0-9._-]{8,}\b/g, "[REDACTED:token]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/\b([A-Z0-9_]*(?:ROLE_ID|SECRET_ID|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*)\s*[:=]\s*\S+/gi, "$1=[REDACTED]");
}

/**
 * 출력/raw 리포트에서 비밀 누출을 탐지 — 값이 아닌 안전 라벨만 반환(재노출 금지).
 * AppRole role_id/secret_id 리터럴 + Vault 토큰-형태(hvs./hvb./s.)·Bearer 정규식.
 */
const VAULT_TOKEN_SHAPE = /\b(?:hvs|hvb|s)\.[A-Za-z0-9._-]{8,}\b|Bearer\s+\S+/i;
function scanForLeaks(text: string): string[] {
  const labels: string[] = [];
  SECRET_STRINGS.forEach((s, i) => {
    if (s.length > 0 && text.includes(s)) labels.push(`appRoleCred#${i}`);
  });
  if (VAULT_TOKEN_SHAPE.test(text)) labels.push("vault-token-shape");
  return labels;
}

function redactErr(error: unknown): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return redact(text);
}

function cell(value: string): string {
  return redact(value).replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ").trim();
}

void main().catch((e) => {
  console.error(`FAIL: smoke threw: ${redactErr(e)}`);
  process.exit(1);
});
