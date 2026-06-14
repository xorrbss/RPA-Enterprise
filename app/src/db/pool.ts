/**
 * PostgreSQL 연결 + 테넌트 바인딩 트랜잭션 (D2 런타임).
 *
 * 권위:
 *  - auth-rbac.md §4 / security-contracts.md: RLS는 strict `current_setting('app.tenant_id')`,
 *    FORCE RLS. 모든 테넌트 스코프 DML은 트랜잭션 내 `app.tenant_id` 바인딩이 선행되어야 한다.
 *  - architecture.md §4: 단일 Postgres 스택, 상태변경+이벤트는 동일 트랜잭션(outbox).
 *
 * `pg`는 PGHOST/PGPORT/PGUSER/PGDATABASE/PGPASSWORD 환경변수에서 접속 정보를 읽는다.
 */
import pg from "pg";

export type PgPool = pg.Pool;
export type PgClient = pg.PoolClient;

export function createPool(config?: pg.PoolConfig): pg.Pool {
  return new pg.Pool(config);
}

/**
 * 테넌트 바인딩 트랜잭션.
 *
 * BEGIN → `set_config('app.tenant_id', <tenant>, true)`(local=트랜잭션 한정) → fn → COMMIT.
 * fn이 throw하면 ROLLBACK 후 재던짐(조용한 흡수 금지). 클라이언트는 항상 반납.
 *
 * `set_config(..., true)`의 local 플래그는 트랜잭션 종료 시 자동 해제되어 풀의 다음 사용자에게
 * 테넌트가 누설되지 않는다(SET LOCAL과 동치, RLS 격리 안전).
 */
export async function withTenantTx<T>(
  pool: pg.Pool,
  tenantId: string,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {
      /* ROLLBACK 실패는 원 예외를 가리지 않는다 */
    });
    throw err;
  } finally {
    client.release();
  }
}
