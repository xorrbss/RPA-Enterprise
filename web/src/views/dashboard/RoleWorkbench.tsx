import { ROLE_LABELS } from "../../api/permissions";
import { getInternalNavFlags, type NavPolicyFlags } from "../../navPolicy";
import { navigate, type ViewKey } from "../../router";

function roleFocus(roles: readonly string[], can: (a: string) => boolean, flags: NavPolicyFlags): { title: string; note: string; actions: readonly { label: string; view: ViewKey; params?: Record<string, string> }[] } {
  const known = roles.map((r) => ROLE_LABELS[r] ?? r);
  const roleText = known.length > 0 ? known.join(" · ") : "권한 미확인";
  if (roles.includes("admin")) {
    const actions: { label: string; view: ViewKey; params?: Record<string, string> }[] = [
      { label: "사이트 접근 정책", view: "security" },
      { label: "AI 모델 정책", view: "llmGateway" },
    ];
    if (flags.showInternalOpenGate) actions.push({ label: "Product-open 점검", view: "openGate" });
    return {
      title: `관리자 작업대 · ${roleText}`,
      note: "정책 충돌, 사이트 승인, 모델 기본값처럼 운영 전체를 막을 수 있는 설정을 먼저 확인합니다.",
      actions,
    };
  }
  if (roles.includes("approver")) {
    return {
      title: `승인자 작업대 · ${roleText}`,
      note: "결재, 고위험 사이트 승인, 사람 확인 대기를 먼저 처리해 자동화 재개 시간을 줄입니다.",
      actions: [
        { label: "사람 확인", view: "humanTasks" }, // 결재 목록도 사람 확인의 결재 탭으로 통합됨(구 결재 인박스 흡수).
        { label: "감사 이력", view: "auditExplorer" },
      ],
    };
  }
  if (roles.includes("reviewer")) {
    return {
      title: `검토자 작업대 · ${roleText}`,
      note: "보안문자, 추가 인증, 검증 업무를 빠르게 처리하고 원본 실행으로 되돌아갑니다.",
      actions: [
        { label: "사람 확인", view: "humanTasks" },
        { label: "실행 기록", view: "runTrace" },
      ],
    };
  }
  if (can("run.create")) {
    return {
      title: `운영자 작업대 · ${roleText}`,
      note: "실패, 재처리 대기, 실행 중인 자동화를 먼저 보고 재처리 또는 취소까지 이어갑니다.",
      actions: [
        { label: "실패 실행", view: "runTrace", params: { status: "failed_system" } },
        { label: "작업 목록", view: "workitems" },
        { label: "자동화 만들기", view: "scenarioStudio" },
      ],
    };
  }
  return {
    title: `조회 작업대 · ${roleText}`,
    note: "읽기 권한으로 운영 상태와 증빙을 확인합니다. 명령은 권한 있는 담당자에게 요청하세요.",
    actions: [
      { label: "실행 기록", view: "runTrace" },
      { label: "작업 목록", view: "workitems" },
    ],
  };
}

export function RoleWorkbench({ roles, can }: { roles: readonly string[]; can: (a: string) => boolean }): JSX.Element {
  const focus = roleFocus(roles, can, getInternalNavFlags());
  return (
    <section className="panel role-workbench" aria-label="역할별 작업대">
      <div>
        <h2>{focus.title}</h2>
        <p className="subtle">{focus.note}</p>
      </div>
      <div className="quick-actions">
        {focus.actions.map((a) => (
          <button key={`${a.view}-${a.label}`} className="btn" type="button" onClick={() => navigate(a.view, a.params)}>
            {a.label}
          </button>
        ))}
      </div>
    </section>
  );
}
