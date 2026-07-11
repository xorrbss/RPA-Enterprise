/**
 * DG-3 전용 워커 풀 — Graphile flags 기반 친화.
 *
 * run_claim/run_resume job 은 enqueue 시 `pool:<key>` flag 를 부착한다(key = 테넌트 배정 또는 'default').
 * 각 워커는 자기가 서비스하지 않는 풀의 flag 를 `forbiddenFlags` 로 선언 → Graphile 이 그 job 을 이 워커에
 * 디스패치하지 않는다(claim/drive 경로 무변경, 풀 내 병렬성 보존).
 *
 * forbidden = ({worker_pools 등록 풀} ∪ {'default'}) − {served}. 'default'는 미배정 런의 암묵 풀(예약어,
 * 레지스트리에 없음). served 기본 = ['default'](WORKER_POOL_KEYS 미설정 워커). 풀 미등록 시 forbidden = [] →
 * 모든 default job 을 모든 워커가 실행(기존 배포 무변경, opt-in).
 */
import type { PgPool } from "../db/pool";

const POOL_FLAG_PREFIX = "pool:";
const TENANT_FLAG_PREFIX = "tenant:";

/** run 의 풀 키(테넌트 배정 또는 'default')에 대응하는 Graphile job flag 문자열. */
export function poolFlagFor(poolKey: string): string {
  return POOL_FLAG_PREFIX + poolKey;
}

/**
 * job 의 테넌트를 나타내는 flag. 대기열 깊이를 테넌트별로 세기 위한 유일한 경로다 — graphile-worker 0.16 의
 * 공개 뷰 `graphile_worker.jobs` 는 payload 를 노출하지 않고(payload 는 RLS 가 걸린 `_private_jobs` 에만 존재해
 * 런타임 역할 rpa_app 은 행을 볼 수 없다), flags 는 노출한다. 소비자는 api/ops-health.ts readQueueDepth.
 *
 * forbiddenFlags 는 `pool:` 접두 flag 만 생성하므로(buildPoolForbiddenFlags) 이 flag 는 디스패치에 영향이 없다.
 */
export function tenantFlagFor(tenantId: string): string {
  return TENANT_FLAG_PREFIX + tenantId;
}

/**
 * 이 워커의 `forbiddenFlags` 동적 평가 함수. Graphile 이 poll 마다 호출해 등록 풀 변화에 대응한다.
 * worker_pools(인프라, non-RLS)를 읽어 미서비스 풀의 flag 목록을 반환한다.
 */
export function buildPoolForbiddenFlags(pool: PgPool, servedPoolKeys: readonly string[]): () => Promise<string[]> {
  const served = new Set(servedPoolKeys.length > 0 ? servedPoolKeys : ["default"]);
  return async () => {
    const res = await pool.query<{ pool_key: string; status: string }>(`SELECT pool_key, status FROM worker_pools`);
    const all = new Set<string>(["default", ...res.rows.map((row) => row.pool_key)]);
    const inactive = new Set(res.rows.filter((row) => row.status !== "active").map((row) => row.pool_key));
    const forbidden: string[] = [];
    for (const key of all) {
      if (!served.has(key) || inactive.has(key)) forbidden.push(poolFlagFor(key));
    }
    return forbidden;
  };
}
