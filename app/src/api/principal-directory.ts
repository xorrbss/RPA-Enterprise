/**
 * Principal 디렉터리 쓰기 경계 (name-picker 데이터 소스 — auth-rbac §3 / api-surface §3).
 *
 * human_tasks.assignee(= JWT sub, PrincipalId)를 사람이 이름으로 고를 수 있도록 sub↔display_name 매핑을
 * 적재한다. 쓰기 경로 ①: 인증 성공 시 JWT optional `name` 클레임으로 best-effort upsert(source='jwt').
 * (경로 ② admin 수동 등록 source='manual'은 후속 슬라이스.)
 *
 * 인증 경계(auth.ts)는 순수(DB 무접근) 유지가 계약이므로 upsert는 본 모듈로 분리하고 server.ts 인증 훅에서
 * best-effort로 호출한다 — 디렉터리 동기화는 인증/인가와 무관한 부수효과라 실패해도 요청은 진행하되 조용히
 * 삼키지 않고 호출측이 log.warn 한다(가정/은폐 금지).
 */
import { randomUUID } from "node:crypto";

import type { Pool } from "pg";

import { withTenantTx } from "../db/pool";

// 표시용 메타데이터 상한(방어심층): name 클레임은 사람 표시이름이라 길 필요가 없고, email은 RFC 5321 상한(320).
// 적대적/오설정 IdP가 과대 클레임으로 디렉터리/응답을 부풀리지 못하도록 INSERT 전에 잘라 둔다(표시용이라 truncate 무해).
const MAX_DISPLAY_NAME = 256;
const MAX_EMAIL = 320;

export interface PrincipalDirectoryWriter {
  /** JWT 클레임으로 디렉터리 upsert. `name` 클레임 부재 시 no-op(디렉터리에 표시이름 없는 행 추정 금지). */
  upsertFromClaims(
    tenantId: string,
    sub: string,
    claims: Readonly<Record<string, unknown>>,
  ): Promise<void>;
}

export class PgPrincipalDirectory implements PrincipalDirectoryWriter {
  constructor(private readonly pool: Pool) {}

  async upsertFromClaims(
    tenantId: string,
    sub: string,
    claims: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    const rawName = claims.name;
    // 표시이름(name 클레임)이 없으면 디렉터리 동기화하지 않는다 — sub만 아는 행은 picker에 무의미(이름 없는 항목 금지).
    if (typeof rawName !== "string" || rawName.length === 0) return;
    const name = rawName.slice(0, MAX_DISPLAY_NAME);
    const email =
      typeof claims.email === "string" && claims.email.length > 0 ? claims.email.slice(0, MAX_EMAIL) : null;

    await withTenantTx(this.pool, tenantId, async (c) => {
      // source='jwt'는 INSERT 경로에만. 기존 행(수동 'manual' 포함)은 source를 보존하고 표시이름/이메일만 갱신한다
      // (로그인 upsert가 admin 수동 등록을 덮어쓰지 않음). 변경 없는 경우 WHERE로 불필요 write를 건너뛴다.
      await c.query(
        `INSERT INTO principals (id, tenant_id, sub, display_name, email, source)
         VALUES ($1::uuid, $2::uuid, $3::text, $4::text, $5::text, 'jwt')
         ON CONFLICT (tenant_id, sub) DO UPDATE
           SET display_name = EXCLUDED.display_name,
               email        = EXCLUDED.email,
               updated_at   = now()
         WHERE principals.display_name IS DISTINCT FROM EXCLUDED.display_name
            OR principals.email        IS DISTINCT FROM EXCLUDED.email`,
        [randomUUID(), tenantId, sub, name, email],
      );
    });
  }
}
