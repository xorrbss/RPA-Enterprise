/**
 * ResumeTokenRepository 구현 (RQ-016 resume 경로 step1). 계약 ts/runtime-contract.ts.
 *
 * recover: runs.resume_token(봉투)를 읽어 HmacResumeTokenCodec.verify 로 검증 후 recovered|expired|invalid 반환.
 * 조용한 false/unknown 금지 — 검증 실패는 verify 코드(expired=CHALLENGE_UNRESOLVED, invalid=IR_EXPRESSION_RUNTIME)로 표면화.
 * save: 비-원자 caller 용(suspend 경로 driveSuspend 는 R11 과 원자성을 위해 인라인 저장 — 이 save 미사용).
 */
import type { Pool } from "pg";

import type {
  ResumeTokenCodec,
  ResumeTokenEnvelope,
  ResumeTokenRecovery,
  ResumeTokenRepository,
} from "../../../ts/runtime-contract";
import type { RunId, TenantId } from "../../../ts/security-middleware-contract";
import { withTenantTx } from "../db/pool";

export class PgResumeTokenRepository implements ResumeTokenRepository {
  constructor(
    private readonly pool: Pool,
    private readonly codec: ResumeTokenCodec,
  ) {}

  async save(input: { tenantId: TenantId; runId: RunId; token: ResumeTokenEnvelope }): Promise<void> {
    const r = await withTenantTx(this.pool, input.tenantId, (c) =>
      c.query(
        `UPDATE runs SET resume_token = $3::jsonb, updated_at = now() WHERE tenant_id = $1::uuid AND id = $2::uuid`,
        [input.tenantId, input.runId, JSON.stringify(input.token)],
      ),
    );
    if (r.rowCount !== 1) {
      throw new Error(`PgResumeTokenRepository.save: affected ${r.rowCount ?? 0} rows (run 부재/테넌트 불일치)`);
    }
  }

  async recover(input: { tenantId: TenantId; runId: RunId }): Promise<ResumeTokenRecovery> {
    const row = await withTenantTx(this.pool, input.tenantId, async (c) => {
      const r = await c.query<{ resume_token: unknown }>(
        `SELECT resume_token FROM runs WHERE tenant_id = $1::uuid AND id = $2::uuid`,
        [input.tenantId, input.runId],
      );
      return r.rows[0] ?? null;
    });
    if (row === null || row.resume_token === null || row.resume_token === undefined) {
      return { kind: "invalid", code: "IR_EXPRESSION_RUNTIME", reason: "resume_token 부재(미발행 또는 run 부재)" };
    }
    const envelope = row.resume_token as ResumeTokenEnvelope;
    if (envelope.runId !== input.runId) {
      // run-bound 토큰 — 다른 run 의 토큰이 실리면 위변조/혼선. 조용히 수용 금지.
      return { kind: "invalid", code: "IR_EXPRESSION_RUNTIME", reason: `resume_token.runId(${envelope.runId}) != ${input.runId}` };
    }
    const verification = await this.codec.verify(envelope);
    if (verification.kind === "valid") {
      return { kind: "recovered", token: verification.token };
    }
    return verification; // expired(CHALLENGE_UNRESOLVED) | invalid(IR_EXPRESSION_RUNTIME)
  }
}
