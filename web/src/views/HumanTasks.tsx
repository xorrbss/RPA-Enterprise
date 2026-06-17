import { useApiClient } from "../api/context";
import type { ApiClient } from "../api/client";
import { useListView } from "../api/useListView";
import { QueryPanel } from "../components/QueryPanel";
import { ActionButton } from "../components/ActionButton";
import { FilterSelect } from "../components/FilterSelect";
import { StatusBadge, kindLabel } from "../components/badges";
import { HUMANTASK_KINDS, HUMANTASK_STATES } from "./filters";
import type { HumanTaskItem } from "../api/types";

const KEYS = [["human-tasks"]] as const;

// 상태별 운영자 액션(state-machine H1/H2/H3/H5/H6). 권한/assignee 범위는 백엔드가 강제.
function HumanTaskActions({ api, task }: { api: ApiClient; task: HumanTaskItem }): JSX.Element {
  const id = task.human_task_id;
  const assign = (
    <ActionButton
      label="배정"
      action="human_task.assign"
      confirmText="담당자를 배정할까요?"
      inputLabel="담당자 ID(uuid)"
      run={(key, assignee) => {
        // 빈 값은 다이얼로그 확인 비활성으로 1차 차단 + 여기서도 방어(조용한 실패 금지).
        if (assignee === undefined || assignee === "") return Promise.reject(new Error("담당자 미입력"));
        return api.assignHumanTask(id, assignee, key);
      }}
      invalidateKeys={KEYS}
    />
  );
  const escalate = (
    <ActionButton label="에스컬레이션" action="human_task.escalate" confirmText="이 업무를 에스컬레이션할까요?" run={(key) => api.escalateHumanTask(id, key)} invalidateKeys={KEYS} />
  );
  return (
    <span style={{ display: "inline-flex", gap: 8, flexWrap: "wrap" }}>
      {task.state === "open" && (<>{assign}{escalate}</>)}
      {task.state === "assigned" && (
        <>
          <ActionButton label="시작" action="human_task.start" confirmText="이 업무를 시작할까요?" run={(key) => api.startHumanTask(id, key)} invalidateKeys={KEYS} />
          {escalate}
        </>
      )}
      {task.state === "in_progress" && (
        <>
          {/* v1: resolve는 판정-데이터 입력이 아니라 '승인하고 계속' continue 신호(reserved-handlers, api-surface §4 note). */}
          <ActionButton label="처리완료" action={`human_task.resolve.${task.kind}`} confirmText="승인/처리 완료로 표시하고 실행을 재개할까요? (판정 데이터 입력 없이 다음 단계로 진행됩니다)" run={(key) => api.resolveHumanTask(id, key)} invalidateKeys={KEYS} />
          {escalate}
        </>
      )}
      {task.state === "escalated" && assign}
      {["resolved", "expired", "cancelled"].includes(task.state) && "—"}
    </span>
  );
}

export function HumanTasksView(): JSX.Element {
  const api = useApiClient();
  const lv = useListView<HumanTaskItem>(["human-tasks"], (p) => api.listHumanTasks(p), { refetchInterval: 5_000 });
  return (
    <QueryPanel<HumanTaskItem>
      title="사람 확인 인박스"
      query={lv.query}
      pager={lv.pager}
      actions={
        <>
          <FilterSelect label="상태" value={lv.filter.status} options={HUMANTASK_STATES} onChange={(v) => lv.setFilter({ ...lv.filter, status: v })} />
          <FilterSelect label="종류" value={lv.filter.kind} options={HUMANTASK_KINDS} onChange={(v) => lv.setFilter({ ...lv.filter, kind: v })} />
        </>
      }
      rowKey={(r) => r.human_task_id}
      emptyMessage="조건에 맞는 사람 확인 업무가 없습니다."
      columns={[
        { header: "종류", render: (r) => kindLabel(r.kind) },
        { header: "상태", render: (r) => <StatusBadge status={r.state} /> },
        { header: "담당자", render: (r) => (r.assignee ? <code>{r.assignee.slice(0, 8)}</code> : "미배정") },
        { header: "마감", render: (r) => r.timeout ?? "—" },
        { header: "작업", render: (r) => <HumanTaskActions api={api} task={r} /> },
      ]}
    />
  );
}
