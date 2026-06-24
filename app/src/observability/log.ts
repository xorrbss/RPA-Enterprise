/**
 * Worker/runtime 구조화 로깅(O3 관찰성). main.ts 의 `JSON.stringify({ at, msg, ... })` 패턴을 공유 헬퍼로 통일해
 * worker/runtime 의 free-text console.* (run_id 8자 절단·correlation 미키잉)를 대체한다. 전체 run_id + correlation_id 를
 * 실어 로그를 트레이스(observability/telemetry.ts span 의 correlation_id)와 join 할 수 있게 한다.
 *
 * 보안 경계: 임의 필드(`error` 등)는 문자열만 — secret-taint 룰이 PlainSecret 의 JSON.stringify/console 유입을 정적 차단한다.
 * 예외 메시지는 errText 로 message 만 추출(기존 `err instanceof Error ? err.message : String(err)` 동일 — 누출면 불변).
 */
export type WorkerLogLevel = "error" | "warn" | "info";

export interface WorkerLogFields {
  /** 컴포넌트 식별(예: "runtime-worker", "run-step-driver"). */
  readonly at: string;
  /** 짧은 이벤트 설명(운영자/개발자 register). */
  readonly msg: string;
  /** 전체 run id(절단 금지 — 트레이스 join 키). null=값 없음(날조 금지, JSON 에 null 로 방출). */
  readonly run_id?: string | null;
  readonly correlation_id?: string | null;
  readonly tenant_id?: string | null;
  readonly worker_id?: string | null;
  /** 추가 구조화 필드(outcome/reason/error/site_id 등). 값은 직렬화 가능해야 한다. */
  readonly [key: string]: unknown;
}

/** 예외에서 message 문자열만 추출(원 예외 객체/스택은 싣지 않음 — 기존 redaction 자세 보존). */
export function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 구조화 JSON 한 줄을 level 별 console 싱크로 방출(main.ts 패턴과 동형). */
export function workerLog(level: WorkerLogLevel, fields: WorkerLogFields): void {
  const line = JSON.stringify({ level, ...fields });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}
