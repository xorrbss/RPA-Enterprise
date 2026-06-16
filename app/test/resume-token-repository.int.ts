/**
 * ResumeTokenRepository.recover 통합 (RQ-016 resume step1). 실 PostgreSQL.
 *
 * runs.resume_token 봉투를 읽어 HmacResumeTokenCodec.verify 로 검증: 유효→recovered, 부재→invalid, 위변조(hmac)→
 * invalid(IR_EXPRESSION_RUNTIME), 만료→expired(CHALLENGE_UNRESOLVED), runId 불일치→invalid. mock SecretStore {kid,key}.
 *
 * 실행: node scripts/db-temp-postgres-gate.mjs -- npm --prefix app exec -- tsx app/test/resume-token-repository.int.ts
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { PlainSecret, SecretRef, SecretStore } from "../../ts/core-types";
import type { ResumeTokenEnvelope } from "../../ts/runtime-contract";
import type { RunId, TenantId } from "../../ts/security-middleware-contract";
import { createPool, withTenantTx } from "../src/db/pool";
import { HmacResumeTokenCodec } from "../src/runtime/resume-token-codec";
import { PgResumeTokenRepository } from "../src/runtime/resume-token-repository";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCHEMA = "rpa_resume_token_repo_int";
const TENANT = "00000000-0000-0000-0000-0000000000a1";
const SCEN = "70000000-0000-0000-0000-000000000a01";
const SVER = "70000000-0000-0000-0000-000000000a02";
const RUN_OK = "71000000-0000-0000-0000-000000000a01";
const RUN_MISSING = "71000000-0000-0000-0000-000000000a02";
const RUN_TAMPER = "71000000-0000-0000-0000-000000000a03";
const RUN_EXPIRED = "71000000-0000-0000-0000-000000000a04";
const RUN_WRONG = "71000000-0000-0000-0000-000000000a05";

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const fakeSecretStore: SecretStore = {
  resolve: async () => JSON.stringify({ kid: "kid-1", key: "repo-int-signing-key" }) as unknown as PlainSecret,
};
const REF = "secret://test/resume_token_hmac" as unknown as SecretRef;

function tokenInput(runId: string, expiresAtMs: number): Omit<ResumeTokenEnvelope, "kid" | "hmac"> {
  const now = Date.now();
  return {
    runId,
    resumeNodeId: "challenge",
    pageStateRef: "ps_after",
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(expiresAtMs).toISOString(),
  } as unknown as Omit<ResumeTokenEnvelope, "kid" | "hmac">;
}

async function main(): Promise<void> {
  const pool = createPool({ options: `-c search_path=${SCHEMA},public` });
  const codec = new HmacResumeTokenCodec(fakeSecretStore, REF);
  const repo = new PgResumeTokenRepository(pool, codec);
  try {
    const setup = await pool.connect();
    try {
      await setup.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
      await setup.query(`CREATE SCHEMA ${SCHEMA}`);
      await setup.query(`SET search_path = ${SCHEMA}, public`);
      await setup.query(readFileSync(`${ROOT}db/migration_concurrency_idempotency.sql`, "utf8"));
      await setup.query(readFileSync(`${ROOT}db/migration_core_entities.sql`, "utf8"));
    } finally {
      setup.release();
    }

    await withTenantTx(pool, TENANT, async (c) => {
      await c.query(`INSERT INTO scenarios (id, tenant_id, name) VALUES ($1,$2,'resume-repo')`, [SCEN, TENANT]);
      await c.query(
        `INSERT INTO scenario_versions (id, tenant_id, scenario_id, version, promotion_status, ir)
         VALUES ($1,$2,$3,1,'draft','{"nodes":[]}'::jsonb)`,
        [SVER, TENANT, SCEN],
      );
      for (const rid of [RUN_OK, RUN_MISSING, RUN_TAMPER, RUN_EXPIRED, RUN_WRONG]) {
        await c.query(
          `INSERT INTO runs (id, tenant_id, scenario_version_id, status, correlation_id) VALUES ($1,$2,$3,'suspended',$1)`,
          [rid, TENANT, SVER],
        );
      }
    });

    const future = Date.now() + 30 * 60 * 1000;
    const past = Date.now() - 1000;

    // 1) 유효: issue → save → recover → recovered.
    await repo.save({ tenantId: TENANT as TenantId, runId: RUN_OK as RunId, token: await codec.issue(tokenInput(RUN_OK, future)) });
    const recOk = await repo.recover({ tenantId: TENANT as TenantId, runId: RUN_OK as RunId });
    check("유효 토큰 → recovered", recOk.kind === "recovered", recOk.kind);

    // 2) 토큰 부재 → invalid.
    const recMissing = await repo.recover({ tenantId: TENANT as TenantId, runId: RUN_MISSING as RunId });
    check("토큰 부재 → invalid", recMissing.kind === "invalid", recMissing.kind);

    // 3) 위변조: 저장 후 hmac 손상 → invalid.
    await repo.save({ tenantId: TENANT as TenantId, runId: RUN_TAMPER as RunId, token: await codec.issue(tokenInput(RUN_TAMPER, future)) });
    await withTenantTx(pool, TENANT, (c) =>
      c.query(`UPDATE runs SET resume_token = jsonb_set(resume_token, '{hmac}', '"deadbeefdeadbeef"') WHERE id=$1::uuid`, [RUN_TAMPER]),
    );
    const recTamper = await repo.recover({ tenantId: TENANT as TenantId, runId: RUN_TAMPER as RunId });
    check("위변조(hmac) → invalid(IR_EXPRESSION_RUNTIME)", recTamper.kind === "invalid", recTamper.kind);

    // 4) 만료 → expired.
    await repo.save({ tenantId: TENANT as TenantId, runId: RUN_EXPIRED as RunId, token: await codec.issue(tokenInput(RUN_EXPIRED, past)) });
    const recExpired = await repo.recover({ tenantId: TENANT as TenantId, runId: RUN_EXPIRED as RunId });
    check("만료 → expired(CHALLENGE_UNRESOLVED)", recExpired.kind === "expired", recExpired.kind);

    // 5) runId 불일치: 다른 runId 봉투를 RUN_WRONG 에 저장 → invalid.
    await repo.save({ tenantId: TENANT as TenantId, runId: RUN_WRONG as RunId, token: await codec.issue(tokenInput(RUN_OK, future)) });
    const recWrong = await repo.recover({ tenantId: TENANT as TenantId, runId: RUN_WRONG as RunId });
    check("runId 불일치 → invalid", recWrong.kind === "invalid", recWrong.kind);
  } finally {
    await pool.end();
  }

  if (failures > 0) {
    console.error(`\nFAIL: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nPASS: PgResumeTokenRepository.recover — recovered/invalid/expired/runId (RQ-016 resume step1)");
  process.exit(0);
}

main().catch((e) => {
  console.error("resume-token-repository int fatal:", e);
  process.exit(1);
});
