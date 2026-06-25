import { ALL_RBAC_ACTIONS, RBAC_ROLE_ACTIONS } from "../../../../ts/rbac-policy";

import { ROLE_LABELS, useRoles } from "../../api/permissions";
import { ReadinessMetric } from "./shared";

type RbacRoleKey = keyof typeof RBAC_ROLE_ACTIONS;
type RbacActionKey = (typeof ALL_RBAC_ACTIONS)[number];

const RBAC_ROLES = Object.keys(RBAC_ROLE_ACTIONS) as RbacRoleKey[];

const RBAC_ACTION_LABELS: Partial<Record<RbacActionKey, string>> = {
  "run.create": "자동화 실행 시작",
  "run.abort": "실행 중단",
  "trigger.manage": "스케줄·이벤트 트리거 관리",
  "automation_idea.manage": "업무 후보·ROI 관리",
  "automation_idea.approve": "업무 후보 승인·반려",
  "document_job.manage": "문서 자동화 작업",
  "human_task.assign": "확인 업무 배정",
  "human_task.escalate": "확인 업무 에스컬레이션",
  "human_task.resolve.validation": "검증 업무 완료",
  "human_task.resolve.approval": "승인 업무 완료",
  "site.approve": "고위험 사이트 승인",
  "approval.decide": "결재 인박스 처리",
  "scenario.create": "시나리오 작성",
  "scenario.promote": "운영 버전 승격",
  "scenario_release.read": "릴리스 조회",
  "scenario_release.submit": "릴리스 요청 제출",
  "scenario_release.approve": "릴리스 승인·반려",
  "scenario_release.deploy": "환경 배포",
  "scenario_release.rollback": "환경 롤백",
  "connector.read": "커넥터 카탈로그 조회",
  "connector.enable": "커넥터 활성화",
  "session.capture": "로그인 세션 등록",
  "audit.read": "감사 로그 조회",
  "secret.resolve": "SecretRef 사용",
  "gateway_policy.edit": "AI 게이트웨이 정책 편집",
  "principal.manage": "담당자 디렉터리 관리",
  "rbac.grant": "RBAC 역할 부여",
};

const RBAC_MATRIX_ACTIONS = [
  "run.create",
  "run.abort",
  "trigger.manage",
  "automation_idea.manage",
  "automation_idea.approve",
  "document_job.manage",
  "human_task.assign",
  "human_task.escalate",
  "human_task.resolve.validation",
  "human_task.resolve.approval",
  "site.approve",
  "approval.decide",
  "scenario.create",
  "scenario.promote",
  "scenario_release.read",
  "scenario_release.submit",
  "scenario_release.approve",
  "scenario_release.deploy",
  "scenario_release.rollback",
  "connector.read",
  "connector.enable",
  "session.capture",
  "audit.read",
  "secret.resolve",
  "gateway_policy.edit",
  "principal.manage",
  "rbac.grant",
] as const satisfies readonly RbacActionKey[];

export function RbacMatrixPanel(): JSX.Element {
  const rawRoles = useRoles();
  const currentRoles = rawRoles.filter((role): role is RbacRoleKey => isKnownRole(role));
  const unknownRoles = rawRoles.filter((role) => !isKnownRole(role));
  const currentAllowed = ALL_RBAC_ACTIONS.filter((action) => rolesAllowAction(currentRoles, action));
  const adminOnlyCount = ALL_RBAC_ACTIONS.filter((action) => {
    const allowed = allowedRolesForAction(action);
    return allowed.length === 1 && allowed[0] === "admin";
  }).length;

  return (
    <section className="panel" aria-label="RBAC 역할 권한 매트릭스" style={{ marginBottom: 12 }}>
      <div className="panel-head">
        <h2>RBAC 역할 권한 매트릭스</h2>
        <span className="badge blue">{RBAC_ROLES.length}개 역할</span>
      </div>
      <div className="rbac-matrix">
        <div className="summary-grid">
          <ReadinessMetric label="현재 토큰 역할" value={currentRoleLabel(currentRoles, unknownRoles)} tone={currentRoles.length > 0 ? "blue" : "amber"} />
          <ReadinessMetric label="허용 권한" value={`${currentAllowed.length}/${ALL_RBAC_ACTIONS.length}개`} tone={currentAllowed.length > 0 ? "green" : "amber"} />
          <ReadinessMetric label="관리자 전용" value={`${adminOnlyCount}개`} tone="amber" />
          <ReadinessMetric label="권한 원천" value="계약 매트릭스" tone="blue" />
        </div>
        {unknownRoles.length > 0 && (
          <ul className="notice-list" aria-label="미등록 RBAC 역할">
            {unknownRoles.map((role) => <li key={role}>토큰에 미등록 역할이 포함되어 있습니다: {role}</li>)}
          </ul>
        )}
        <p className="subtle rbac-matrix-note">미허용 액션은 백엔드 RBAC에서 차단되며, 이 표는 같은 권한 매트릭스를 화면에 표시합니다.</p>
        <div className="table-wrap">
          <table className="ops-table rbac-table">
            <thead>
              <tr>
                <th scope="col">권한</th>
                {RBAC_ROLES.map((role) => <th key={role} scope="col">{ROLE_LABELS[role]}</th>)}
                <th scope="col">내 토큰</th>
              </tr>
            </thead>
            <tbody>
              {RBAC_MATRIX_ACTIONS.map((action) => (
                <tr key={action}>
                  <th scope="row">
                    <span>{rbacActionLabel(action)}</span>
                    <details className="audit-technical-details">
                      <summary>액션명 보기</summary>
                      <code>{action}</code>
                    </details>
                  </th>
                  {RBAC_ROLES.map((role) => (
                    <td key={`${action}-${role}`}>
                      <RbacDecisionBadge allowed={roleAllowsAction(role, action)} />
                    </td>
                  ))}
                  <td>
                    <RbacDecisionBadge allowed={rolesAllowAction(currentRoles, action)} deniedLabel="차단" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

function RbacDecisionBadge({ allowed, deniedLabel = "—" }: { allowed: boolean; deniedLabel?: string }): JSX.Element {
  return allowed ? <span className="badge green">허용</span> : <span className="badge muted">{deniedLabel}</span>;
}

function isKnownRole(role: string): role is RbacRoleKey {
  return Object.prototype.hasOwnProperty.call(RBAC_ROLE_ACTIONS, role);
}

function roleAllowsAction(role: RbacRoleKey, action: RbacActionKey): boolean {
  return RBAC_ROLE_ACTIONS[role].includes(action);
}

function rolesAllowAction(roles: readonly RbacRoleKey[], action: RbacActionKey): boolean {
  return roles.some((role) => roleAllowsAction(role, action));
}

function allowedRolesForAction(action: RbacActionKey): RbacRoleKey[] {
  return RBAC_ROLES.filter((role) => roleAllowsAction(role, action));
}

function rbacActionLabel(action: RbacActionKey): string {
  return RBAC_ACTION_LABELS[action] ?? action;
}

function currentRoleLabel(currentRoles: readonly RbacRoleKey[], unknownRoles: readonly string[]): string {
  if (currentRoles.length === 0 && unknownRoles.length === 0) return "권한 미확인";
  const knownLabels = currentRoles.map((role) => ROLE_LABELS[role]);
  if (unknownRoles.length === 0) return knownLabels.join(", ");
  return [...knownLabels, `미등록 ${unknownRoles.length}개`].join(", ");
}
