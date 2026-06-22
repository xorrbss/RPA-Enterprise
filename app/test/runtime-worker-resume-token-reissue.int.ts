/**
 * resume_token 재발행 통합 (상태머신 감사 클러스터 C). 실 PostgreSQL.
 *
 * 결함: resume_token 은 suspend 시 1회(ttl 30m) 발행·resolve 시 미재발행. human_task timeout 스위퍼도 미구현이라
 * 인간이 30m 넘겨(야간/주말) 승인하면 토큰 만료 → restore 가 R20(failed_system) — 운영자의 정상 승인이 시스템 실패로
 * 좌초(하이웍스 결재 흐름 직격). 수정: resume_requested 도달은 R13(RBAC 인증 resolve)로만 가능하므로, 워커가 resume 시작
 * 시 진본(hmac-valid)·만료 토큰을 fresh TTL 로 재발행 후 restore. tamper(hmac/kid 불일치=invalid)는 재발행 안 함 → R20 거부.
 *
 * 검증:
 *  - 진본·만료 토큰 → 재발행 → resume 성공(running) + runs.resume_token 만료시각 미래로 갱신.
 *  - tamper 토큰 → 재발행 안 함 → R20(failed_system).
 *  - 유효(미만료) 토큰 → 재발행 불요 → resume 성공 + 토큰 불변(issuedAt 유지).
 *
 * 실행: node scripts/db-temp-postgres-gate.mjs -- npm --prefix app exec -- tsx app/test/runtime-worker-resume-token-reissue.int.ts
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { PlainSecret, SecretRef, SecretStore } from "../../ts/core-types";
import type { CorrelationId, RunId, TenantId } from "../../ts/security-middleware-contract";
import type {
  ResumeTokenEnvelope,
  SessionRestorer,
  SessionRestoreResult,
} from "../../ts/runtime-contract";
import { createPool, withTenantTx } from "../src/db/pool";
import { PgRuntimeWorker } from "../src/worker/runtime-worker";
import type { BrowserLeasePlan } from "../src/worker/runtime-worker";
import { HmacResumeTokenCodec } from "../src/runtime/resume-token-codec";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCHEMA = "rpa_resume_reissue_int";
const TENANT = "00000000-0000-0000-0000-0000000000c1";
const WORKER = "9a000000-0000-0000-0000-0000000000c1";
const CORRELATION = "20000000-0000-0000-0000-0000000000c1";
const SITE = "5c000000-0000-0000-0000-0000000000c1";
// run 별 identity(SESSION_LOCKED 는 (site,identity)별 활성 lease 1개 — run 격리).
const IDENTITY_EXP = "b1000000-0000-0000-0000-0000000000c1";
const IDENTITY_TAM = "b1000000-0000-0000-0000-0000000000c2";
const IDENTITY_VAL = "b1000000-0000-0000-0000-0000000000c3";
const SCENARIO = "5ce00000-0000-0000-0000-0000000000c1";
const SCENARIO_VERSION = "5ce00000-0000-0000-0000-0000000000c2";
const RUN_EXPIRED = "30000000-0000-0000-0000-0000000000c1"; // 진본·만료 → 재발행
const RUN_TAMPERED = "30000000-0000-0000-0000-0000000000c2"; // tamper → R20
const RUN_VALID = "30000000-0000-0000-0000-0000000000c3"; // 유효 → 불변

const KEY_PAYLOAD = JSON.stringify({ kid: "kid-c", key: "resume-reissue-test-key-abcdef" });
const fakeStore: SecretStore = { resolve: async () => KEY_PAYLOAD as unknown as PlainSecret };
const REF = "kms://test/resume-token" as unknown as SecretRef;
const codec = new HmacResumeTokenCodec(fakeStore, REF);

// restorer: 실 codec 으로 토큰 검증 → valid 면 restored(세션 복원은 페이크), expired/invalid 면 invalid_token(R20).
const restorer: SessionRestorer = {
  async restoreSession(input): Promise<SessionRestoreResult> {
    const v = await codec.verify(input.token);
    if (v.kind === "valid") return { kind: "restored", pageStateRef: input.expectedPageStateRef };
    return { kind: "invalid_token", code: v.code, reason: v.reason };
  },
};
const identityFor = (runId: string): string =>
  runId === RUN_EXPIRED ? IDENTITY_EXP : runId === RUN_TAMPERED ? IDENTITY_TAM : IDENTITY_VAL;
const planResolver = async (_c: unknown, input: { runId: string }): Promise<BrowserLeasePlan> => ({
  siteProfileId: SITE,
  browserIdentityId: identityFor(input.runId),
});

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${label}`);
  else { failures += 1; console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`); }
}

async function storedToken(pool: ReturnType<typeof createPool>, runId: string): Promise<ResumeTokenEnvelope> {
  return withTenantTx(pool, TENANT, async (c) => {
    const r = await c.query<{ resume_token: ResumeTokenEnvelope }>(`SELECT resume_token FROM runs WHERE id=$1::uuid`, [runId]);
    return r.rows[0]!.resume_token;
  });
}
async function runStatus(pool: ReturnType<typeof createPool>, runId: string): Promise<string> {
  return withTenantTx(pool, TENANT, async (c) => {
    const r = await c.query<{ status: string }>(`SELECT status FROM runs WHERE id=$1::uuid`, [runId]);
    return r.rows[0]?.status ?? "missing";
  });
}

async function seedRun(pool: ReturnType<typeof createPool>, runId: string, tokenJson: ResumeTokenEnvelope): Promise<void> {
  await withTenantTx(pool, TENANT, async (c) => {
    await c.query(
      `INSERT INTO runs (id, tenant_id, scenario_version_id, status, resume_token, correlation_id)
       VALUES ($1,$2,$3,'resume_requested',$4::jsonb,$5)`,
      [runId, TENANT, SCENARIO_VERSION, JSON.stringify(tokenJson), CORRELATION],
    );
  });
}

async function main(): Promise<void> {
  const pool = createPool({ options: `-c search_path=${SCHEMA},public` });
  try {
    const setup = await pool.connect();
    try {
      await setup.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
      await setup.query(`CREATE SCHEMA ${SCHEMA}`);
      await setup.query(`SET search_path = ${SCHEMA}, public`);
      await setup.query(readFileSync(`${ROOT}db/migration_concurrency_idempotency.sql`, "utf8"));
      await setup.query(readFileSync(`${ROOT}db/migration_core_entities.sql`, "utf8"));
      await setup.query(`INSERT INTO workers (id, kind, status, circuit_state) VALUES ($1::uuid,'browser','active','closed')`, [WORKER]);
    } finally {
      setup.release();
    }
    await withTenantTx(pool, TENANT, async (c) => {
      await c.query(`INSERT INTO site_profiles (id, tenant_id, name, url_pattern, risk, approved) VALUES ($1,$2,'c','https://c.example/*','green',true)`, [SITE, TENANT]);
      await c.query(
        `INSERT INTO browser_identities (id, tenant_id, site_profile_id, label) VALUES ($1,$4,$5,'c-exp'),($2,$4,$5,'c-tam'),($3,$4,$5,'c-val')`,
        [IDENTITY_EXP, IDENTITY_TAM, IDENTITY_VAL, TENANT, SITE],
      );
      await c.query(`INSERT INTO scenarios (id, tenant_id, name) VALUES ($1,$2,'c')`, [SCENARIO, TENANT]);
      await c.query(
        `INSERT INTO scenario_versions (id, tenant_id, scenario_id, version, promotion_status, ir) VALUES ($1,$2,$3,1,'draft','{"nodes":[]}'::jsonb)`,
        [SCENARIO_VERSION, TENANT, SCENARIO],
      );
    });

    const past = "2020-01-01T00:00:00.000Z";
    const farFuture = "2099-01-01T00:00:00.000Z";
    // 진본·만료(expiresAt 과거, 정상 서명).
    const expiredToken = await codec.issue({ runId: RUN_EXPIRED as RunId, resumeNodeId: "n-exp", pageStateRef: "ps://exp" as ResumeTokenEnvelope["pageStateRef"], issuedAt: past as ResumeTokenEnvelope["issuedAt"], expiresAt: past as ResumeTokenEnvelope["expiresAt"] });
    // tamper: 정상 발행 후 hmac 1글자 변조.
    const okToken = await codec.issue({ runId: RUN_TAMPERED as RunId, resumeNodeId: "n-tam", pageStateRef: "ps://tam" as ResumeTokenEnvelope["pageStateRef"], issuedAt: past as ResumeTokenEnvelope["issuedAt"], expiresAt: past as ResumeTokenEnvelope["expiresAt"] });
    const tamperedToken: ResumeTokenEnvelope = { ...okToken, hmac: (okToken.hmac[0] === "a" ? "b" : "a") + okToken.hmac.slice(1) };
    // 유효(미만료).
    const validToken = await codec.issue({ runId: RUN_VALID as RunId, resumeNodeId: "n-val", pageStateRef: "ps://val" as ResumeTokenEnvelope["pageStateRef"], issuedAt: past as ResumeTokenEnvelope["issuedAt"], expiresAt: farFuture as ResumeTokenEnvelope["expiresAt"] });

    await seedRun(pool, RUN_EXPIRED, expiredToken);
    await seedRun(pool, RUN_TAMPERED, tamperedToken);
    await seedRun(pool, RUN_VALID, validToken);

    const worker = new PgRuntimeWorker(pool, {
      workerId: WORKER,
      browserLeasePlanResolver: planResolver,
      sessionRestorer: restorer,
      resumeTokenCodec: codec,
    });
    const run = (runId: string) => worker.handle({ kind: "run_resume", tenantId: TENANT as TenantId, runId: runId as RunId, correlationId: CORRELATION as CorrelationId });

    // 1) 진본·만료 → 재발행 → resume 성공.
    const r1 = await run(RUN_EXPIRED);
    check("진본·만료 토큰 run_resume completes", r1.kind === "completed", JSON.stringify(r1));
    check("진본·만료 → resume 성공(running, R20 아님)", (await runStatus(pool, RUN_EXPIRED)) === "running", await runStatus(pool, RUN_EXPIRED));
    const reissued = await storedToken(pool, RUN_EXPIRED);
    check("진본·만료 → resume_token 재발행(만료시각 미래로 갱신)", Date.parse(reissued.expiresAt) > Date.now(), reissued.expiresAt);
    check("재발행 토큰 payload 보존(resumeNodeId/pageStateRef)", reissued.resumeNodeId === "n-exp" && String(reissued.pageStateRef) === "ps://exp");

    // 2) tamper → 재발행 안 함 → R20.
    const r2 = await run(RUN_TAMPERED);
    check("tamper 토큰 run_resume completes(전이는 성공)", r2.kind === "completed", JSON.stringify(r2));
    check("tamper → R20(failed_system)", (await runStatus(pool, RUN_TAMPERED)) === "failed_system", await runStatus(pool, RUN_TAMPERED));
    check("tamper → 토큰 미재발행(hmac 불변)", (await storedToken(pool, RUN_TAMPERED)).hmac === tamperedToken.hmac);

    // 3) 유효 → 재발행 불요 → resume 성공 + 토큰 불변.
    const r3 = await run(RUN_VALID);
    check("유효 토큰 → resume 성공(running)", (await runStatus(pool, RUN_VALID)) === "running", await runStatus(pool, RUN_VALID));
    check("유효 토큰 → 재발행 안 함(issuedAt/expiresAt 불변)", (await storedToken(pool, RUN_VALID)).issuedAt === past && (await storedToken(pool, RUN_VALID)).expiresAt === farFuture);
  } finally {
    await pool.end();
  }
  if (failures > 0) { console.error(`\nFAIL: ${failures} check(s) failed`); process.exit(1); }
  console.log("\nPASS: resume_token 재발행 — 상태머신 감사 클러스터 C");
  process.exit(0);
}

void main();
