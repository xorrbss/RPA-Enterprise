/**
 * D4.2 단위 테스트 — RoleMatrixRbacMiddleware가 auth-rbac §2 매트릭스를 따르는지 검증.
 *
 * 순수(외부 의존 없음): 역할×액션 허용/거부, 합집합 평가, tenant 불일치 차단을 확인한다.
 * 거부는 일반 역할/액션 부족은 AUTHZ_FORBIDDEN, 자원특정 액션은 SSoT 보안 코드를 확인한다.
 */
import { RoleMatrixRbacMiddleware } from "../src/api/rbac";
import type {
  AuthenticatedPrincipal,
  AuthorizationCheck,
  PrincipalId,
  RbacAction,
  Role,
  TenantId,
} from "../../ts/security-middleware-contract";

const TENANT = "00000000-0000-0000-0000-0000000000a1" as TenantId;
const OTHER_TENANT = "00000000-0000-0000-0000-0000000000b2" as TenantId;

const rbac = new RoleMatrixRbacMiddleware();

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  PASS  ${label}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function principal(roles: Role[], tenantId: TenantId = TENANT, subjectId = "p1"): AuthenticatedPrincipal {
  return { subjectId: subjectId as PrincipalId, tenantId, roles, source: "jwt", claims: {} };
}

async function expectAllow(roles: Role[], action: RbacAction): Promise<void> {
  const d = await rbac.authorize(principal(roles), { action, tenantId: TENANT });
  check(`${roles.join("+") || "∅"} allow ${action}`, d.kind === "allow", JSON.stringify(d));
}

async function expectDeny(roles: Role[], action: RbacAction, code = "AUTHZ_FORBIDDEN"): Promise<void> {
  const d = await rbac.authorize(principal(roles), { action, tenantId: TENANT });
  check(
    `${roles.join("+") || "∅"} deny ${action}`,
    d.kind === "deny" && d.code === code,
    JSON.stringify(d),
  );
}

async function expectAllowCheck(label: string, roles: Role[], check: AuthorizationCheck, subjectId = "p1"): Promise<void> {
  const d = await rbac.authorize(principal(roles, TENANT, subjectId), check);
  checkResult(label, d.kind === "allow", JSON.stringify(d));
}

async function expectDenyCheck(
  label: string,
  roles: Role[],
  authCheck: AuthorizationCheck,
  subjectId = "p1",
  reason?: string,
): Promise<void> {
  const d = await rbac.authorize(principal(roles, TENANT, subjectId), authCheck);
  checkResult(
    label,
    d.kind === "deny" && d.code === "AUTHZ_FORBIDDEN" && (reason === undefined || d.reason === reason),
    JSON.stringify(d),
  );
}

function checkResult(label: string, cond: boolean, detail?: string): void {
  check(label, cond, detail);
}

async function main(): Promise<void> {
  // viewer: 조회 허용, 변경 거부
  await expectAllow(["viewer"], "run.read");
  await expectAllow(["viewer"], "artifact.read");
  await expectAllow(["viewer"], "scenario.read");
  await expectAllow(["viewer"], "site.read");
  await expectAllow(["viewer"], "gateway_policy.read");
  await expectAllow(["viewer"], "trigger.read");
  await expectAllow(["viewer"], "ops_alert.read");
  await expectAllow(["viewer"], "automation_idea.read");
  await expectAllow(["viewer"], "connector.read");
  await expectAllow(["viewer"], "document_job.read");
  await expectAllow(["viewer"], "audit.read");
  await expectDeny(["viewer"], "run.create");
  await expectDeny(["viewer"], "trigger.manage");
  await expectDeny(["viewer"], "automation_idea.manage");
  await expectDeny(["viewer"], "automation_idea.approve");
  await expectDeny(["viewer"], "document_job.manage");
  await expectDeny(["viewer"], "site.approve");
  await expectDeny(["viewer"], "site.create");
  await expectDeny(["viewer"], "gateway_policy.edit");
  await expectDeny(["viewer"], "run.abort");
  await expectDeny(["viewer"], "run.resume");
  await expectDeny(["viewer"], "scenario.create");
  await expectDeny(["viewer"], "scenario.update");
  await expectDeny(["viewer"], "scenario.promote");
  await expectDeny(["viewer"], "connector.enable", "CONNECTOR_PERMISSION_DENIED");

  // operator: run create/abort·DLQ replay 허용, resolve·promote 거부
  await expectAllow(["operator"], "run.read");
  await expectAllow(["operator"], "run.create");
  await expectAllow(["operator"], "run.abort");
  await expectAllow(["operator"], "run.resume");
  await expectAllow(["operator"], "human_task.assign");
  await expectAllow(["operator"], "dlq.replay");
  await expectAllow(["operator"], "scenario.create");
  await expectAllow(["operator"], "scenario.update");
  await expectAllow(["operator"], "site.create");
  await expectAllow(["operator"], "trigger.manage");
  await expectAllow(["operator"], "automation_idea.manage");
  await expectAllow(["operator"], "connector.read");
  await expectAllow(["operator"], "document_job.read");
  await expectAllow(["operator"], "document_job.manage");
  await expectAllow(["operator"], "audit.read");
  await expectDeny(["operator"], "human_task.resolve.validation");
  await expectDeny(["operator"], "human_task.escalate");
  await expectDeny(["operator"], "scenario.promote");
  await expectDeny(["operator"], "automation_idea.approve");

  // reviewer: validation/exception/captcha/mfa resolve + escalate 허용, approval resolve 거부
  await expectDeny(["reviewer"], "human_task.resolve.validation");
  await expectAllowCheck(
    "reviewer allow human_task.resolve.validation with assignee scope",
    ["reviewer"],
    {
      action: "human_task.resolve.validation",
      tenantId: TENANT,
      humanTask: { kind: "validation", assigneeId: "p1" as PrincipalId, assigneeRole: "reviewer" },
    },
  );
  await expectAllowCheck(
    "reviewer allow human_task.resolve.mfa with assignee scope",
    ["reviewer"],
    {
      action: "human_task.resolve.mfa",
      tenantId: TENANT,
      humanTask: { kind: "mfa", assigneeId: "p1" as PrincipalId, assigneeRole: "reviewer" },
    },
  );
  await expectDenyCheck(
    "reviewer deny human_task.resolve.exception wrong assignee",
    ["reviewer"],
    {
      action: "human_task.resolve.exception",
      tenantId: TENANT,
      humanTask: { kind: "exception", assigneeId: "other" as PrincipalId, assigneeRole: "reviewer" },
    },
    "p1",
    "human_task_assignee_mismatch",
  );
  await expectDenyCheck(
    "reviewer deny human_task.resolve.exception wrong assignee_role",
    ["reviewer"],
    {
      action: "human_task.resolve.exception",
      tenantId: TENANT,
      humanTask: { kind: "exception", assigneeId: "p1" as PrincipalId, assigneeRole: "approver" },
    },
    "p1",
    "human_task_assignee_role_mismatch",
  );
  await expectAllow(["reviewer"], "human_task.escalate");
  await expectDeny(["reviewer"], "human_task.resolve.approval");
  await expectDeny(["reviewer"], "node_policy.approve");
  await expectDeny(["reviewer"], "automation_idea.approve");

  // approver: approval resolve·node_policy·site 승인 허용, secret/promote 거부
  await expectAllowCheck(
    "approver allow human_task.resolve.approval with assignee scope",
    ["approver"],
    {
      action: "human_task.resolve.approval",
      tenantId: TENANT,
      humanTask: { kind: "approval", assigneeId: "p1" as PrincipalId, assigneeRole: "approver" },
    },
  );
  await expectAllow(["approver"], "node_policy.approve");
  await expectAllow(["approver"], "site.approve");
  await expectAllow(["approver"], "automation_idea.approve");
  await expectDeny(["approver"], "secret.resolve", "SECRET_ACCESS_DENIED");
  await expectDeny(["approver"], "connector.enable", "CONNECTOR_PERMISSION_DENIED");
  await expectDeny(["approver"], "scenario.promote");

  // admin: 전권
  await expectAllow(["admin"], "scenario.promote");
  await expectAllow(["admin"], "secret.resolve");
  await expectAllow(["admin"], "connector.enable");
  await expectAllow(["admin"], "gateway_policy.edit");
  await expectAllow(["admin"], "network_policy.edit");
  await expectAllow(["admin"], "rbac.grant");

  // 다중 역할 합집합: viewer는 abort 불가지만 operator 보유 시 통과
  await expectAllow(["viewer", "operator"], "run.abort");
  await expectAllow(["viewer", "operator"], "run.resume");

  // 역할 없음(빈 집합) → 어떤 액션도 거부
  await expectDeny([], "run.read");

  // tenant 불일치 → admin이라도 거부(§3)
  const mismatch = await rbac.authorize(principal(["admin"], TENANT), {
    action: "run.read",
    tenantId: OTHER_TENANT,
  });
  check(
    "tenant mismatch → deny (admin)",
    mismatch.kind === "deny" && mismatch.code === "AUTHZ_FORBIDDEN" && mismatch.reason === "tenant_mismatch",
    JSON.stringify(mismatch),
  );

  if (failures > 0) {
    console.error(`\nFAIL: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nPASS: D4.2 RBAC matrix unit green");
}

main().catch((err) => {
  console.error("FAIL: rbac unit threw:", err);
  process.exit(1);
});
