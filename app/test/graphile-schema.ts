/**
 * 테스트용 실 graphile-worker 스키마 설치.
 *
 * 이전에는 큐를 읽는 테스트가 `CREATE TABLE graphile_worker.jobs (id, locked_at, payload jsonb)` 로 가짜
 * 테이블을 세웠다. graphile-worker 0.16 의 실제 `graphile_worker.jobs` 는 **payload 가 없는 뷰**이고 payload 는
 * RLS 가 걸린 `_private_jobs` 에만 있다 — 가짜가 실 스키마와 어긋난 탓에 "큐 미설치"로 오판하는 결함
 * (production readiness graphile_queue 게이트 영구 blocked)이 테스트를 통과했다.
 * 큐 표면을 읽는 테스트는 반드시 실 runMigrations 산출물을 쓴다.
 */
import { runMigrations } from "graphile-worker";

export function graphileConnectionString(): string {
  const host = process.env.PGHOST ?? "127.0.0.1";
  const port = process.env.PGPORT ?? "5432";
  const user = process.env.PGUSER ?? "postgres";
  const database = process.env.PGDATABASE ?? "postgres";
  const password = process.env.PGPASSWORD;
  const auth = password !== undefined && password !== ""
    ? `${encodeURIComponent(user)}:${encodeURIComponent(password)}`
    : encodeURIComponent(user);
  return `postgres://${auth}@${host}:${port}/${database}`;
}

/** graphile_worker 스키마를 실제 마이그레이션으로 설치한다(이미 있으면 no-op). */
export async function installGraphileSchema(): Promise<void> {
  await runMigrations({ connectionString: graphileConnectionString() });
}
