/**
 * runtime-worker run-context primitives — runtime-worker.ts 협력객체 분해(CLAUDE.md #7)의 leaf 모듈.
 *
 * run claim/resume/abort 핸들러와 그 지원 메서드(loadExpectedRun/loadRunDriveInputs/acquireBrowserLease/
 * recordWorkerInit*)가 쓰는 run-record 모양 타입·params 정규화·worker/lease 기본 상수를 모은다(RunRow·
 * RunClaimDriveInputs 는 지원↔핸들러 양쪽 공유, 나머지는 지원 클러스터 전속). 값 의존이 양쪽으로 흐르지 않게
 * (value-cycle 차단) 지원 클러스터·run-drive 핸들러 추출 전에 먼저 분리한다. 외부 계약 타입만 import 하는 순수
 * leaf — runtime-worker.ts 를 역참조하지 않는다.
 */
import type { RunState } from "../../../ts/state-machine-types";
import type { LeaseCleanupPolicy, LeaseIsolation } from "../../../ts/runtime-contract";

// A.1 run-drive: claim tx 에서 캡처해 tx 밖(Phase B)에서 driveClaimedRun 에 넘기는 입력(브라우저 작업은 커넥션 밖).
export interface RunClaimDriveInputs {
  readonly scenarioVersionId: string;
  readonly model?: string;
  readonly correlationId: string;
  readonly leaseId: string;
  readonly siteProfileId: string;
  readonly browserIdentityId: string;
  readonly browserIdentityVersion: number;
  readonly networkPolicyId: string;
  readonly networkAllowedDomains: readonly string[];
  readonly isolation: LeaseIsolation;
  readonly cleanupPolicy: LeaseCleanupPolicy;
  readonly params?: Record<string, unknown>;
}

export type RunRow = { status: RunState; correlation_id: string };

// runs.params(jsonb) 정규화: 문자열이면 파싱, null/부재면 undefined(빈 {} 와 구분 — navigate 키 해소가 loud 실패). run-loop 와 동형.
export function normalizeRunParams(raw: unknown): Record<string, unknown> | undefined {
  const v = typeof raw === "string" ? (JSON.parse(raw) as unknown) : raw;
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

export const DEFAULT_BROWSER_LEASE_TTL_MS = 300_000;
// ops-defaults.md §3 worker.circuit: consecutive_failures=5(임계) / open_duration=1m(cooldown) / half_open_close_threshold=2. 코드 상수 금지 규약 — inline 인용.
export const DEFAULT_WORKER_CIRCUIT_THRESHOLD = 5;
export const DEFAULT_WORKER_CIRCUIT_OPEN_MS = 60_000;
export const DEFAULT_WORKER_CIRCUIT_CLOSE_THRESHOLD = 2;
