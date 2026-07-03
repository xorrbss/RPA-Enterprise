import type { ApiClient } from "../../api/client";
import { useSubject } from "../../api/permissions";
import type { HumanTaskItem } from "../../api/types";
import { ActionButton } from "../../components/ActionButton";
import { mergeParams } from "../../router";
import { HUMAN_TASK_TERMINAL_STATES } from "../humanTaskFilters";
import { requiresStructuredReviewInput } from "./labels";

export const KEYS = [["human-tasks"]] as const;

// 상태별 운영자 액션(state-machine H1/H2/H3/H5/H6). 권한/assignee 범위는 백엔드가 강제.
// principalOptions = /v1/principals 담당자 디렉터리(value=배정값 sub, label=표시이름). '배정' 입력의 datalist로만 쓰며 자유 입력 폴백은 유지.
export function HumanTaskActions({
  api,
  task,
  principalOptions,
  inDetail = false,
}: {
  api: ApiClient;
  task: HumanTaskItem;
  principalOptions: readonly { value: string; label?: string }[];
  inDetail?: boolean;
}): JSX.Element {
  const id = task.human_task_id;
  const subject = useSubject();
  // '내 담당으로 지정' 단축 — 현재 토큰 sub로 self-assign(직접입력 없이 가장 흔한 케이스). 검증은 백엔드가 최종 강제.
  //   sub는 비-UUID OIDC 식별자(auth0|…·이메일)여도 무방 — human_tasks.assignee 는 text 컬럼이고 필터도 `= $4::text`
  //   (uuid 캐스트 없음, principalIdFilter 는 임의 문자열 허용). 과거의 isUuid 보수 가드는 불필요라 제거(비-UUID 실증 테스트 동반).
  const selfAssign = subject !== null && subject.length > 0 ? (
    <ActionButton
      label="내 담당으로 지정"
      action="human_task.assign"
      confirmText="이 업무를 내 담당으로 지정할까요?"
      run={(key) => api.assignHumanTask(id, subject, key)}
      invalidateKeys={KEYS}
    />
  ) : null;
  // 타인 배정: /v1/principals 담당자 디렉터리(datalist, 이름 표시) + 자유 입력. assignee는 PrincipalId(JWT sub) 자유형
  //   string이라 디렉터리 밖 값도 허용(폴백). 디렉터리 항목은 이름(display_name)으로 보이고 배정값은 sub.
  const assign = (
    <ActionButton
      label="담당자 지정"
      action="human_task.assign"
      confirmText="이 업무의 담당자를 지정할까요?"
      inputLabel="담당자 선택 또는 직접 입력"
      inputOptions={principalOptions}
      run={(key, assignee) => {
        // 빈 값은 다이얼로그 확인 비활성으로 1차 차단 + 여기서도 방어(조용한 실패 금지).
        if (assignee === undefined || assignee === "") return Promise.reject(new Error("담당자를 입력하세요."));
        return api.assignHumanTask(id, assignee, key);
      }}
      invalidateKeys={KEYS}
    />
  );
  const escalate = (
    <ActionButton
      label="이관"
      action="human_task.escalate"
      confirmText="이 업무를 상위 담당자에게 이관할까요? 담당자가 비워지고 이관 대기 목록에 올라갑니다."
      inputLabel="이관 사유 (선택)"
      inputOptional
      run={(key, reason) => api.escalateHumanTask(id, key, reason !== undefined && reason.trim() !== "" ? reason.trim() : undefined)}
      invalidateKeys={KEYS}
    />
  );
  const requiresStructuredReview = requiresStructuredReviewInput(task);
  const structuredReviewAction = inDetail ? (
    <span className="subtle">위 검토 영역에서 결과를 제출하세요.</span>
  ) : (
    <button className="btn" type="button" onClick={() => mergeParams({ ht: id })}>
      검토 입력
    </button>
  );
  // U2-1: 구조화 검토 1건이 지정(확인)→시작(확인)→입력→제출 4단계였다 — 일괄 승인이 이미 쓰는 H1→H2 체인
  //   (task+step 결정형 멱등키, 재시도 안전)을 단건용으로 재사용해 확인 1회로 in_progress+검토 폼에 도달한다.
  //   타인에게 배정된 업무는 제외(가로채기 방지) — 그 경우 기존 시작/이관 경로 그대로.
  const reviewChain =
    subject !== null &&
    subject.length > 0 &&
    requiresStructuredReview &&
    (task.state === "open" || task.state === "escalated" || (task.state === "assigned" && task.assignee === subject)) ? (
      <ActionButton
        label="내가 검토 시작"
        action="human_task.assign"
        confirmText="이 업무를 내 담당으로 지정하고 바로 검토를 시작할까요? 검토 입력 화면이 열립니다."
        run={async (key) => {
          if (task.state === "open" || task.state === "escalated") {
            await api.assignHumanTask(id, subject, `${key}:a`);
          }
          await api.startHumanTask(id, `${key}:s`);
          mergeParams({ ht: id }); // 시작 즉시 상세(검토 폼)로 — in_progress 가 되면 판정 입력이 렌더된다.
          return { started: true };
        }}
        invalidateKeys={KEYS}
        successText="검토를 시작했습니다 — 검토 영역에서 판정을 입력하세요."
      />
    ) : null;
  return (
    <span style={{ display: "inline-flex", gap: 8, flexWrap: "wrap" }}>
      {task.state === "open" && (<>{reviewChain}{selfAssign}{assign}{escalate}</>)}
      {task.state === "assigned" && (
        <>
          {reviewChain}
          <ActionButton label="시작" action="human_task.start" confirmText="이 업무를 시작할까요?" run={(key) => api.startHumanTask(id, key)} invalidateKeys={KEYS} />
          {escalate}
        </>
      )}
      {task.state === "in_progress" && (
        <>
          {requiresStructuredReview ? (
            structuredReviewAction
          ) : (
            <ActionButton label="완료 처리" action={`human_task.resolve.${task.kind}`} confirmText="업무를 완료 처리하고 자동화를 이어서 진행할까요? (별도 입력 항목 없이 완료됩니다)" run={(key) => api.resolveHumanTask(id, key)} invalidateKeys={KEYS} />
          )}
          {escalate}
        </>
      )}
      {task.state === "escalated" && (<>{reviewChain}{selfAssign}{assign}</>)}
      {HUMAN_TASK_TERMINAL_STATES.has(task.state) && "—"}
    </span>
  );
}
