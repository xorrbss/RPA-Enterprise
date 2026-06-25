/**
 * audit_log 체인 검증자 통합 (적대감사 #C1/#C2). 실 PostgreSQL.
 *
 * computeAuditHash 가 영속 컬럼만으로 hash 를 계산하므로 verifyAuditChain 이 저장 행에서 재계산·연속성을 검증할 수 있다
 * (기존: security-audit writer 가 비영속 resource 를 해싱→재계산 불가). 정상 체인 valid + 변조(잘못된 hash 삽입) 탐지 +
 * 테넌트 격리를 검증한다. (DB prevent_audit_log_mutation 트리거는 UPDATE/DELETE 예방, verifier 는 INSERT 변조·트리거
 * 우회 탐지.)
 *
 * 실행: node scripts/db-temp-postgres-gate.mjs -- npx tsx app/test/audit-chain-verifier.int.ts
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  SECURITY_AUDIT_PAYLOAD_SCHEMA_REF,
  type CorrelationId,
  type IdempotencyKey,
  type IsoDateTime,
  type PrincipalId,
  type SecurityAuditDecisionAppendInput,
  type TenantId,
} from "../../ts/security-middleware-contract";
import { createPool, withTenantTx } from "../src/db/pool";
import { PgDurableSecurityAuditDecisionWriter } from "../src/api/security-audit";
import { verifyAuditChain } from "../src/api/audit-record-hash";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCHEMA = "rpa_audit_chain_verifier_int";
const TENANT = "00000000-0000-0000-0000-0000000000c1" as TenantId;
const TENANT_B = "00000000-0000-0000-0000-0000000000c2" as TenantId;
const SUBJECT = "10000000-0000-0000-0000-0000000000c1" as PrincipalId;
const CORRELATION = "20000000-0000-0000-0000-0000000000c1" as CorrelationId;

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` - ${detail}` : ""}`);
  }
}

function auditInput(tenant: TenantId, key: string, occurredAt: string): SecurityAuditDecisionAppendInput {
  return {
    tenantId: tenant,
    actor: { subjectId: SUBJECT, roles: ["admin"] },
    action: "artifact.read",
    outcome: "deny",
    resource: { kind: "artifact", id: "artifact-chain-int" },
    reason: "redaction pending",
    correlationId: CORRELATION,
    idempotencyKey: key as IdempotencyKey,
    occurredAt: occurredAt as IsoDateTime,
    retentionUntil: "2026-09-12T00:00:00Z" as IsoDateTime,
    payloadSchemaRef: SECURITY_AUDIT_PAYLOAD_SCHEMA_REF,
    payload: { decision_kind: "artifact.read", artifact_id: "artifact-chain-int" },
    failClosed: true,
  };
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
    } finally {
      setup.release();
    }

    const writer = new PgDurableSecurityAuditDecisionWriter(pool);
    // 정상 체인 3행(genesis + 2 chained) — 서로 다른 occurredAt(밀리초 정밀) 로 timestamptz 왕복 정규화도 검증.
    await writer.recordDecision(auditInput(TENANT, "chain-1", "2026-06-14T00:00:00Z"), { kind: "blocked" });
    await writer.recordDecision(auditInput(TENANT, "chain-2", "2026-06-14T00:00:01.250Z"), { kind: "blocked" });
    await writer.recordDecision(auditInput(TENANT, "chain-3", "2026-06-14T01:02:03+09:00"), { kind: "blocked" });
    // 다른 테넌트(격리 검증용).
    await writer.recordDecision(auditInput(TENANT_B, "chain-b1", "2026-06-14T00:00:00Z"), { kind: "blocked" });

    // 1) 정상 체인 → valid (저장 행에서 hash 재계산 일치 + 연속성).
    const ok = await verifyAuditChain(pool, TENANT);
    check("정상 체인 valid (재계산 일치)", ok.valid === true, JSON.stringify(ok.violations));
    check("rowsChecked = 3", ok.rowsChecked === 3, String(ok.rowsChecked));
    check("위반 0건", ok.violations.length === 0, JSON.stringify(ok.violations));

    // 2) 테넌트 격리 — TENANT_B 는 독립 체인(genesis 1행) valid.
    const okB = await verifyAuditChain(pool, TENANT_B);
    check("테넌트 B 독립 체인 valid (격리)", okB.valid === true && okB.rowsChecked === 1, JSON.stringify(okB));

    // 3) 변조 탐지 — seq4 행을 잘못된 hash 로 INSERT(FK 만족 위해 previous_hash=직전 hash). UPDATE 가 트리거로 막히므로
    //    INSERT 경로로 변조 시뮬레이션(트리거 우회 침해 대역). verifier 가 hash_mismatch 탐지해야.
    await withTenantTx(pool, TENANT, async (c) => {
      const last = await c.query<{ hash: string }>(
        `SELECT hash FROM audit_log WHERE tenant_id=$1::uuid ORDER BY sequence_no DESC LIMIT 1`, [TENANT],
      );
      await c.query(
        `INSERT INTO audit_log (id, tenant_id, sequence_no, actor, action, outcome, reason, correlation_id,
            idempotency_key, occurred_at, payload, payload_schema_ref, retention_until, previous_hash, hash)
         VALUES (gen_random_uuid(),$1::uuid,4,$2::jsonb,'artifact.read','deny','tampered',$3::uuid,
            'chain-tamper','2026-06-14T02:00:00Z',$4::jsonb,$5,'2026-09-12T00:00:00Z',$6,'sha256:TAMPERED')`,
        [TENANT, JSON.stringify({ subjectId: SUBJECT, roles: ["admin"] }), CORRELATION,
         JSON.stringify({ decision_kind: "artifact.read" }), SECURITY_AUDIT_PAYLOAD_SCHEMA_REF, last.rows[0]!.hash],
      );
    });
    const tampered = await verifyAuditChain(pool, TENANT);
    check("변조 hash → valid=false", tampered.valid === false, JSON.stringify(tampered));
    check("hash_mismatch 위반 탐지(seq 4)", tampered.violations.some((v) => v.kind === "hash_mismatch" && v.sequenceNo === 4), JSON.stringify(tampered.violations));
    check("정상 3행은 위반 없음(변조 1건만)", tampered.violations.length === 1, JSON.stringify(tampered.violations));
  } finally {
    await pool.end();
  }

  if (failures > 0) {
    console.error(`\nFAIL: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nPASS: audit_log 체인 검증자 — 정상 valid·재계산 일치·변조 탐지·테넌트 격리 (적대감사 #C1/#C2)");
  process.exit(0);
}

main().catch((e) => {
  console.error("audit-chain-verifier int fatal:", e);
  process.exit(1);
});
