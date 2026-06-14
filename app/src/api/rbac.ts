/**
 * 제어평면 RBAC 미들웨어 (D4.2 — auth-rbac.md §2 권한 매트릭스).
 *
 * 계약:
 *  - auth-rbac §2: 역할×액션 매트릭스. 명시 허용만 통과, 미허용 → 차단(typed 거부, "조용한 false 금지").
 *    다중 역할은 합집합 평가. tenant 불일치 → 차단(§3 cross-tenant 방지; RBAC은 동일 tenant 내에서만 의미).
 *  - ts/security-middleware-contract.ts: RbacMiddleware / AuthorizationCheck / AuthorizationDecision를 구현.
 *  - 거부 코드: 일반 역할/액션 권한 부족 → AUTHZ_FORBIDDEN(§2 거부 통일 코드).
 *    자원특정 액션은 SSoT의 보안 코드(artifact/secret→SECRET_ACCESS_DENIED,
 *    connector→CONNECTOR_PERMISSION_DENIED)를 직접 반환한다.
 *  - §2 비고 assignee 스코핑(human_task resolve: 역할 충족 AND assignee/assignee_role 일치)은 human_task
 *    resolve 라우트(D4.5)와 함께 추가한다(현재 wired 액션은 run.read뿐 — humanTask 컨텍스트 없음).
 *
 * 매트릭스 데이터의 SSoT는 auth-rbac §2(문서)다. 본 표는 그 미러이며 변경 시 §2와 동기화한다. (참조 스캐폴드
 * control-plane/fake-request-runner.ts는 같은 매트릭스를 따르며, D4 scenario 액션도 함께 동기화한다.)
 */
import type {
  AuthenticatedPrincipal,
  AuthorizationCheck,
  AuthorizationDecision,
  RbacAction,
  RbacMiddleware,
  Role,
} from "../../../ts/security-middleware-contract";

/** auth-rbac §2: 역할별 허용 액션 집합(합집합 평가). 표에 없는 액션은 해당 역할에 대해 거부. */
const ROLE_ACTIONS: Readonly<Record<Role, readonly RbacAction[]>> = {
  viewer: ["run.read", "workitem.read", "human_task.read", "artifact.read", "scenario.read"],
  operator: [
    "run.read",
    "run.create",
    "workitem.read",
    "human_task.read",
    "artifact.read",
    "run.abort",
    "human_task.assign",
    "human_task.start",
    "dlq.replay",
    "sink_dlq.replay",
    "scenario.read",
    "scenario.create",
    "scenario.update",
  ],
  reviewer: [
    "run.read",
    "run.create",
    "workitem.read",
    "human_task.read",
    "artifact.read",
    "run.abort",
    "human_task.assign",
    "human_task.escalate",
    "human_task.start",
    "dlq.replay",
    "sink_dlq.replay",
    "human_task.resolve.validation",
    "human_task.resolve.exception",
    "human_task.resolve.captcha",
    "human_task.resolve.mfa",
    "scenario.read",
    "scenario.create",
    "scenario.update",
  ],
  approver: [
    "run.read",
    "run.create",
    "workitem.read",
    "human_task.read",
    "artifact.read",
    "run.abort",
    "human_task.assign",
    "human_task.escalate",
    "human_task.start",
    "dlq.replay",
    "sink_dlq.replay",
    "human_task.resolve.validation",
    "human_task.resolve.exception",
    "human_task.resolve.captcha",
    "human_task.resolve.mfa",
    "human_task.resolve.approval",
    "node_policy.approve",
    "site.approve",
    "scenario.read",
    "scenario.create",
    "scenario.update",
  ],
  admin: [
    "run.read",
    "run.create",
    "workitem.read",
    "human_task.read",
    "artifact.read",
    "run.abort",
    "human_task.assign",
    "human_task.escalate",
    "human_task.start",
    "dlq.replay",
    "sink_dlq.replay",
    "human_task.resolve.validation",
    "human_task.resolve.exception",
    "human_task.resolve.captcha",
    "human_task.resolve.mfa",
    "human_task.resolve.approval",
    "node_policy.approve",
    "site.approve",
    "secret.resolve",
    "connector.enable",
    "gateway_policy.edit",
    "network_policy.edit",
    "rbac.grant",
    "scenario.read",
    "scenario.create",
    "scenario.update",
    "scenario.promote",
  ],
};

type AuthorizationDenyCode = Extract<AuthorizationDecision, { kind: "deny" }>["code"];

function roleActionDenyCode(action: RbacAction): AuthorizationDenyCode {
  if (action === "connector.enable") return "CONNECTOR_PERMISSION_DENIED";
  if (action === "artifact.read" || action === "secret.resolve") return "SECRET_ACCESS_DENIED";
  return "AUTHZ_FORBIDDEN";
}

export class RoleMatrixRbacMiddleware implements RbacMiddleware {
  async authorize(
    principal: AuthenticatedPrincipal,
    check: AuthorizationCheck,
  ): Promise<AuthorizationDecision> {
    // §3: 인증 tenant ≠ 자원 tenant면 cross-tenant 의심 → 차단(역할 평가 이전).
    if (principal.tenantId !== check.tenantId) {
      return { kind: "deny", action: check.action, code: "AUTHZ_FORBIDDEN", reason: "tenant_mismatch" };
    }
    // 합집합 평가: 보유 역할 중 하나라도 액션을 허용하면 통과.
    for (const role of principal.roles) {
      if (ROLE_ACTIONS[role].includes(check.action)) {
        return { kind: "allow", principal, action: check.action };
      }
    }
    return { kind: "deny", action: check.action, code: roleActionDenyCode(check.action), reason: "role_action_not_allowed" };
  }
}
