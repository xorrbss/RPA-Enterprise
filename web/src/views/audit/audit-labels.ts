import { ROLE_LABELS } from "../../api/permissions";
import type { AuditOutcome, AuditVerificationRun } from "../../api/types";

export const OUTCOME_LABEL: Record<AuditOutcome, string> = {
  allow: "허용",
  deny: "거부",
  blocked: "차단",
  error: "오류",
};

// 계약 ts/security-middleware-contract.ts SECURITY_AUDIT_REQUIRED_ACTIONS(30종) 전수 미러.
// audit_log 는 이 레지스트리 밖 action 을 fail-closed 로 거부하므로 여기 없는 값은 기록될 수 없다.
// 레지스트리에 action 을 추가하면 이 라벨 맵도 함께 갱신할 것(web/test/audit-explorer.test.tsx 가 전수 대조).
export const ACTION_LABEL: Record<string, string> = {
  "artifact.read": "증빙 조회",
  "secret.resolve": "자격증명 사용",
  "connector.enable": "연동 기능 사용 설정",
  "connector.install": "연동 기능 설치",
  "scenario.certify": "시나리오 인증",
  "scenario.decertify": "시나리오 인증 해제",
  "scenario_release.create": "배포본 생성",
  "scenario_release.submit": "배포본 승인 요청",
  "scenario_release.approve": "배포본 승인",
  "scenario_release.reject": "배포본 반려",
  "scenario_release.deploy": "배포본 적용",
  "scenario_release.rollback": "배포본 되돌리기",
  "run.create": "자동화 실행 시작",
  "run.rerun": "자동화 다시 실행",
  "run.resume": "자동화 재개",
  "run.pause": "자동화 일시 중지",
  "run.prioritize": "자동화 우선 처리",
  "credential.manage": "자격증명 관리",
  "worker_pool.manage": "작업 서버 관리",
  "rbac.grant": "권한 부여",
  "rbac.revoke": "권한 회수",
  "scim.sync": "계정 연동 동기화",
  "tenant_data.export": "회사 데이터 반출",
  "tenant_data.purge.request": "회사 데이터 삭제 요청",
  "tenant_data.purge.approve": "회사 데이터 삭제 승인",
  "network.request": "외부 접속 점검",
  "prompt.inspect": "AI 요청 점검",
  "ai_governance.manage": "AI 정책 관리",
  "ai_governance.enforce": "AI 정책 적용",
  "bypassrls.use": "시스템 보존 작업",
};

export const VERIFICATION_STATUS_LABEL: Record<AuditVerificationRun["status"], string> = {
  valid: "정상",
  invalid: "무결성 오류",
  failed: "검증 실패",
};

export function outcomeTone(outcome: AuditOutcome): string {
  if (outcome === "allow") return "green";
  if (outcome === "deny" || outcome === "blocked") return "red";
  return "amber";
}

export function verificationTone(status: AuditVerificationRun["status"]): string {
  return status === "valid" ? "green" : "red";
}

export function actionLabel(action: string): string {
  return ACTION_LABEL[action] ?? "기록된 업무";
}

export function actionFilterText(value: string | null): string {
  if (value === null) return "";
  return ACTION_LABEL[value] ?? value;
}

export function actionFilterValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) return "";
  const match = Object.entries(ACTION_LABEL).find(
    ([raw, label]) => raw === trimmed || label === trimmed,
  );
  return match?.[0] ?? trimmed;
}

export function permissionScopeText(roles: readonly string[]): string {
  const labels = roles.map((role) => ROLE_LABELS[role] ?? role);
  return labels.length > 0 ? labels.join(", ") : "권한 범위 미확인";
}

export function actorLabel(value: string | null): string {
  return value === null ? "담당자 미확인" : "처리자 확인됨";
}

export function hashStateLabel(value: string | null): string {
  return value === null ? "첫 감사 기록" : "이전 기록과 연결됨";
}

// datetime-local 값(TZ 없음)은 서버가 로컬 TZ 로 해석한다 — 운영자 브라우저 TZ 의도를 UTC ISO 로 고정해 전송.
// 파싱 불가 값은 원문을 그대로 보내 서버가 명시적으로 거부하게 둔다(조용한 필터 탈락 금지).
export function occurredAtParam(value: string): string {
  const trimmed = value.trim();
  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? trimmed : parsed.toISOString();
}
