import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import { useApiClient } from "../api/context";
import { isUuid, useCan, useSubject } from "../api/permissions";
import type { ApiClient } from "../api/client";
import { useListView } from "../api/useListView";
import { QueryPanel } from "../components/QueryPanel";
import { ActionButton } from "../components/ActionButton";
import { FilterSelect } from "../components/FilterSelect";
import { SlideOver } from "../components/SlideOver";
import { StatusBadge, kindLabel, statusLabel } from "../components/badges";
import { ErrorState, Loading } from "../components/states";
import { mergeParams, navigate, useHashParam } from "../router";
import { HUMANTASK_KINDS, HUMANTASK_STATES } from "./filters";
import type { HumanTaskItem } from "../api/types";

const KEYS = [["human-tasks"]] as const;
const TERMINAL = new Set(["resolved", "expired", "cancelled"]);

function dueTime(task: HumanTaskItem): number {
  return task.timeout !== null ? Date.parse(task.timeout) : Number.POSITIVE_INFINITY;
}

// 상태별 운영자 액션(state-machine H1/H2/H3/H5/H6). 권한/assignee 범위는 백엔드가 강제.
function HumanTaskActions({ api, task }: { api: ApiClient; task: HumanTaskItem }): JSX.Element {
  const id = task.human_task_id;
  const subject = useSubject();
  // '내게 배정' 단축 — 현재 토큰 sub로 self-assign(uuid 직접입력 없이 가장 흔한 케이스). 검증은 백엔드가 최종 강제.
  // ⚠ sub는 비-UUID OIDC 식별자(auth0|…·이메일)일 수 있고 백엔드 assignee는 uuid만 허용(422) → sub가 UUID일 때만 렌더(isUuid).
  //   비-UUID/부재면 미렌더(조용한 false 금지) + uuid 직접입력 '배정' 폴백만. 이름 picker는 principals read 부재로 별도 TODO[BLOCKED].
  const selfAssign = isUuid(subject) ? (
    <ActionButton
      label="내게 배정"
      action="human_task.assign"
      confirmText="이 업무를 내게 배정할까요?"
      run={(key) => api.assignHumanTask(id, subject, key)}
      invalidateKeys={KEYS}
    />
  ) : null;
  // 타인 배정은 uuid 직접입력(아래 '배정')을 유지. 이름 검색 picker는 백엔드 선행이 필요:
  // TODO: [BLOCKED]
  //   violated: 가정 금지 — 없는 데이터로 UI를 채우지 않는다
  //   reason: 배정 가능한 사용자 목록 read 엔드포인트가 계약(api-surface)·라우트에 전무 → 이름↔uuid 매핑 소스 없음
  //   required_change: /v1/users(또는 principals) 목록 + 표시명 투영(versioned 계약) → 그 후 uuid 입력을 이름 picker로 대체
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
      {task.state === "open" && (<>{selfAssign}{assign}{escalate}</>)}
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
      {task.state === "escalated" && (<>{selfAssign}{assign}</>)}
      {["resolved", "expired", "cancelled"].includes(task.state) && "—"}
    </span>
  );
}

export function HumanTasksView(): JSX.Element {
  const api = useApiClient();
  const can = useCan();
  const subject = useSubject();
  const [dueOnly, setDueOnly] = useState(false);
  const runParam = useHashParam("run_id");
  const lv = useListView<HumanTaskItem>(
    ["human-tasks"],
    (p) => api.listHumanTasks(p),
    { refetchInterval: 5_000, initialFilter: runParam !== null ? { run_id: runParam } : undefined },
  );
  // 선택 사람확인 업무를 해시(`#humanTasks?ht=<id>`)에 보존 → 딥링크·뒤로가기로 드릴다운 복원(RunTrace 패턴 재사용).
  const sel = useHashParam("ht");
  const detail = useQuery({ queryKey: ["humantask-detail", sel], queryFn: () => api.getHumanTask(sel as string), enabled: sel !== null });
  const pageItems = lv.query.data?.items ?? [];
  const dueItems = useMemo(() => pageItems.filter((t) => !TERMINAL.has(t.state) && t.timeout !== null).sort((a, b) => dueTime(a) - dueTime(b)), [pageItems]);
  const nextTask = useMemo(() => [...pageItems].filter((t) => !TERMINAL.has(t.state)).sort((a, b) => dueTime(a) - dueTime(b))[0], [pageItems]);
  const visibleItems = dueOnly ? dueItems : pageItems;
  const panelQuery: typeof lv.query = lv.query.data !== undefined
    ? ({ ...lv.query, data: { ...lv.query.data, items: visibleItems } } as typeof lv.query)
    : lv.query;
  const bulkAssignable = pageItems.filter((t) => t.state === "open" || t.state === "escalated");
  const bulkEscalatable = pageItems.filter((t) => t.state === "open" || t.state === "assigned" || t.state === "in_progress");
  return (
    <>
      {sel !== null && <HumanTaskDetailPanel api={api} humanTaskId={sel} detail={detail} onClose={() => { mergeParams({ ht: null }); }} />}
      <section className="panel queue-controls" aria-label="사람 확인 큐 제어">
        <div>
          <strong>큐 처리</strong>
          <p className="subtle">현재 페이지 기준으로 담당·마감·다음 건을 빠르게 좁힙니다.</p>
        </div>
        <div className="quick-actions">
          <button
            className="btn"
            type="button"
            disabled={!isUuid(subject)}
            onClick={() => {
              // sub가 UUID일 때만(버튼 disabled 가드와 동치) — 비-UUID sub를 assignee 필터로 보내면 백엔드 uuidFilter가 422로 목록을 깨뜨린다.
              if (isUuid(subject)) lv.setFilter({ ...lv.filter, assignee: lv.filter.assignee === subject ? undefined : subject });
            }}
          >
            {lv.filter.assignee === subject ? "전체 담당 보기" : "내 담당만 보기"}
          </button>
          <button className="btn" type="button" aria-pressed={dueOnly} onClick={() => setDueOnly((v) => !v)}>
            마감 임박 {dueItems.length}
          </button>
          <button className="btn" type="button" disabled={nextTask === undefined} onClick={() => { if (nextTask !== undefined) mergeParams({ ht: nextTask.human_task_id }); }}>
            다음 건 처리
          </button>
          {can("human_task.assign") && bulkAssignable.length > 0 && (
            <ActionButton
              label={`현재 페이지 ${bulkAssignable.length}건 배정`}
              action="human_task.assign"
              inputLabel="담당자 ID(uuid)"
              confirmText="현재 페이지의 미배정/이관 업무를 같은 담당자에게 배정할까요?"
              run={async (key, assignee) => {
                if (assignee === undefined || assignee === "") throw new Error("담당자 미입력");
                await Promise.all(bulkAssignable.map((task) => api.assignHumanTask(task.human_task_id, assignee, `${key}:${task.human_task_id}`)));
              }}
              invalidateKeys={KEYS}
            />
          )}
          {can("human_task.escalate") && bulkEscalatable.length > 0 && (
            <ActionButton
              label={`현재 페이지 ${bulkEscalatable.length}건 이관`}
              action="human_task.escalate"
              confirmText="현재 페이지의 미종결 업무를 에스컬레이션할까요?"
              run={async (key) => {
                await Promise.all(bulkEscalatable.map((task) => api.escalateHumanTask(task.human_task_id, `${key}:${task.human_task_id}`, "bulk_escalate")));
              }}
              invalidateKeys={KEYS}
            />
          )}
        </div>
      </section>
      <QueryPanel<HumanTaskItem>
        title="사람 확인 인박스"
        query={panelQuery}
        pager={lv.pager}
        actions={
          <>
            <FilterSelect label="상태" value={lv.filter.status} options={HUMANTASK_STATES} labelFor={statusLabel} onChange={(v) => lv.setFilter({ ...lv.filter, status: v })} />
            <FilterSelect label="종류" value={lv.filter.kind} options={HUMANTASK_KINDS} labelFor={kindLabel} onChange={(v) => lv.setFilter({ ...lv.filter, kind: v })} />
          </>
        }
        rowKey={(r) => r.human_task_id}
        emptyMessage="조건에 맞는 사람 확인 업무가 없습니다."
        columns={[
          { header: "종류", render: (r) => kindLabel(r.kind) },
          { header: "상태", render: (r) => <StatusBadge status={r.state} /> },
          { header: "담당자", render: (r) => (r.assignee ? <code>{r.assignee.slice(0, 8)}</code> : "미배정") },
          { header: "마감", render: (r) => r.timeout ?? "—" },
          {
            header: "상세",
            render: (r) => (
              <button className="btn" type="button" onClick={() => { mergeParams({ ht: r.human_task_id }); }}>
                상세
              </button>
            ),
          },
          { header: "작업", render: (r) => <HumanTaskActions api={api} task={r} /> },
        ]}
      />
    </>
  );
}

// 사람확인 상세 — getHumanTask(RLS 스코프). on_timeout=human_tasks.on_timeout 실 컬럼(만료 시 동작을 사전 확인).
// 전이 버튼은 인박스와 동일한 HumanTaskActions를 재사용(DRY — 중복 동선 아님). run_id 있으면 원본 실행 교차링크,
// null이면 미렌더(조용한 false 금지). 판정-데이터 입력은 불포함(v1 resolve=순수 continue 신호 — 상세는 관찰만 추가).
function HumanTaskDetailPanel({
  api,
  humanTaskId,
  detail,
  onClose,
}: {
  api: ApiClient;
  humanTaskId: string;
  detail: UseQueryResult<HumanTaskItem>;
  onClose: () => void;
}): JSX.Element {
  return (
    <SlideOver title={`사람확인 상세 — ${humanTaskId.slice(0, 8)}`} onClose={onClose}>
      {detail.isLoading ? (
        <Loading />
      ) : detail.isError ? (
        <ErrorState message="사람 확인 업무를 불러오지 못했습니다." onRetry={() => void detail.refetch()} />
      ) : detail.data !== undefined ? (
        <>
          <dl style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "6px 16px", margin: 0 }}>
            <dt className="subtle">종류</dt>
            <dd style={{ margin: 0 }}>{kindLabel(detail.data.kind)}</dd>
            <dt className="subtle">상태</dt>
            <dd style={{ margin: 0 }}>
              <StatusBadge status={detail.data.state} />
            </dd>
            <dt className="subtle">담당자</dt>
            <dd style={{ margin: 0 }}>{detail.data.assignee !== null ? <code>{detail.data.assignee.slice(0, 8)}</code> : "미배정"}</dd>
            <dt className="subtle">마감</dt>
            <dd style={{ margin: 0 }}>{detail.data.timeout ?? "—"}</dd>
            <dt className="subtle">만료 시 처리</dt>
            <dd style={{ margin: 0 }}>{detail.data.on_timeout ?? "—"}</dd>
            {detail.data.run_id !== null && (
              <>
                <dt className="subtle">원본 실행</dt>
                <dd style={{ margin: 0 }}>
                  <button className="linklike" type="button" onClick={() => { navigate("runTrace", { run: detail.data!.run_id as string }); }}>
                    원본 실행 보기 <span aria-hidden="true">→</span>
                  </button>
                </dd>
              </>
            )}
          </dl>
          <div style={{ marginTop: 14 }}>
            <strong style={{ fontSize: 13 }}>작업</strong>
            <div style={{ marginTop: 8 }}>
              <HumanTaskActions api={api} task={detail.data} />
            </div>
          </div>
        </>
      ) : null}
    </SlideOver>
  );
}
