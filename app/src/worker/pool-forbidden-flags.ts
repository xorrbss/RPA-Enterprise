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

/** run 의 풀 키(테넌트 배정 또는 'default')에 대응하는 Graphile job flag 문자열. */
export function poolFlagFor(poolKey: string): string {
  return POOL_FLAG_PREFIX + poolKey;
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
