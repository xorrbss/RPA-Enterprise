import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import { useApiClient } from "../api/context";
import { useCan, useSubject } from "../api/permissions";
import { useListView } from "../api/useListView";
import { QueryPanel } from "../components/QueryPanel";
import { DashboardEnvironmentState, environmentErrorKind, type DashboardEnvironmentError } from "../components/DashboardEnvironmentState";
import { ActionButton } from "../components/ActionButton";
import { FilterSelect } from "../components/FilterSelect";
import { StatusBadge, kindLabel, statusLabel } from "../components/badges";
import { mergeParams, useHashIdParam, useHashParam } from "../router";
import { HUMANTASK_KINDS, HUMANTASK_STATES } from "./filters";
import { ApprovalInboxView } from "./ApprovalInbox";
import type { HumanTaskItem } from "../api/types";
import { HUMAN_TASK_TERMINAL_STATES, isActiveHumanTask } from "./humanTaskFilters";
import {
  DeadlineText,
  artifactCount,
  dueTime,
  hasBusinessForm,
  humanTaskRef,
  isDocumentValidationTask,
  principalLabel,
  requiresStructuredReviewInput,
} from "./human-tasks/labels";
import { HumanTaskActions, KEYS } from "./human-tasks/HumanTaskActions";
import { HumanTaskDetailPanel } from "./human-tasks/HumanTaskDetailPanel";

// 통합 '사람 확인' 인박스 — 소스 탭: 확인 업무(@human_task 스트림) / 결재 목록(수집 아티팩트 리스트, 구 '결재 인박스' 메뉴 흡수).
// 탭 상태는 해시 파라미터(source)로 보존 → 딥링크·뒤로가기·레거시 #approvalInbox 리다이렉트(#humanTasks?source=approvals) 대응.
// 소스별 화면은 자식 컴포넌트로 분리(탭 전환 시 훅 순서 불변 — 조건부 훅 금지).
export function HumanTasksView(): JSX.Element {
  const source = useHashParam("source");
  const approvals = source === "approvals";
  return (
    <>
      <div className="quick-actions" style={{ marginBottom: 12 }} aria-label="사람 확인 소스 선택">
        <button className="btn" type="button" aria-pressed={!approvals} onClick={() => mergeParams({ source: null, ht: null })}>
          확인 업무
        </button>
        <button className="btn" type="button" aria-pressed={approvals} onClick={() => mergeParams({ source: "approvals", ht: null })}>
          결재 목록
        </button>
      </div>
      {approvals ? <ApprovalInboxView /> : <HumanTaskStreamView />}
    </>
  );
}

function HumanTaskStreamView(): JSX.Element {
  const api = useApiClient();
  const can = useCan();
  const subject = useSubject();
  const [dueOnly, setDueOnly] = useState(false);
  const [documentOnly, setDocumentOnly] = useState(false);
  // 담당자 picker 제안 목록 — 배정 권한이 있을 때만 조회(viewer는 picker 미노출 → 불필요 쿼리 회피).
  //   /v1/principals = 테넌트 담당자 디렉터리. 배정값은 sub, 표시는 display_name. 자유 입력 폴백이 있어 목록이 비어도 배정 가능.
  const principalsQuery = useQuery({
    queryKey: ["principals"],
    queryFn: () => api.listPrincipals({ limit: 200 }),
    enabled: can("human_task.assign"),
    refetchInterval: 30_000,
  });
  const principalOptions = useMemo(
    () => (principalsQuery.data?.items ?? []).map((p) => ({ value: p.sub, label: p.display_name })),
    [principalsQuery.data],
  );
  const runParam = useHashParam("run_id");
  const terminalParam = useHashParam("terminal");
  const unassignedParam = useHashParam("unassigned");
  const hashStatus = useHashParam("status");
  const activeOnly = terminalParam === "false";
  const activeFilter = activeOnly ? { terminal: "false" as const } : {};
  const initialFilter = runParam !== null
    ? { run_id: runParam }
    : unassignedParam === "true"
      ? { unassigned: true, ...activeFilter }
      : hashStatus !== null && hashStatus.length > 0
        ? { status: hashStatus }
        : activeOnly
          ? activeFilter
          : (subject !== null && subject.length > 0 ? { assignee: subject } : undefined);
  const lv = useListView<HumanTaskItem>(
    ["human-tasks"],
    (p) => api.listHumanTasks(p),
    // 디폴트 = 내게 배정(내 업무 먼저). run_id 딥링크가 있으면 그 우선. sub 부재(미로그인)면 필터 없음.
    { refetchInterval: 5_000, initialFilter },
  );
  // 선택 사람확인 업무를 해시(`#humanTasks?ht=<id>`)에 보존 → 딥링크·뒤로가기로 드릴다운 복원(RunTrace 패턴 재사용).
  const sel = useHashIdParam("ht");
  const detail = useQuery({ queryKey: ["humantask-detail", sel], queryFn: () => api.getHumanTask(sel as string), enabled: sel !== null });
  const unassignedQuery = useQuery({ queryKey: ["human-tasks", "unassigned-count", "active"], queryFn: () => api.listHumanTasks({ unassigned: true, terminal: "false", limit: 50 }), refetchInterval: 5_000 });
  const pageItems = lv.query.data?.items ?? [];
  const activeItems = useMemo(() => pageItems.filter(isActiveHumanTask), [pageItems]);
  const baseItems = activeOnly ? activeItems : pageItems;
  const dueItems = useMemo(() => baseItems.filter((t) => isActiveHumanTask(t) && t.timeout !== null).sort((a, b) => dueTime(a) - dueTime(b)), [baseItems]);
  const documentItems = useMemo(() => baseItems.filter((t) => isActiveHumanTask(t) && isDocumentValidationTask(t)), [baseItems]);
  const documentWithArtifacts = useMemo(() => documentItems.filter((t) => artifactCount(t) > 0), [documentItems]);
  const documentWithForm = useMemo(() => documentItems.filter(hasBusinessForm), [documentItems]);
  const visibleItems = useMemo(() => {
    const base = documentOnly ? documentItems : baseItems;
    if (!dueOnly) return base;
    return base.filter((t) => isActiveHumanTask(t) && t.timeout !== null).sort((a, b) => dueTime(a) - dueTime(b));
  }, [baseItems, documentItems, documentOnly, dueOnly]);
  const nextTask = useMemo(() => [...visibleItems].filter(isActiveHumanTask).sort((a, b) => dueTime(a) - dueTime(b))[0], [visibleItems]);
  const panelQuery: typeof lv.query = lv.query.data !== undefined
    ? ({ ...lv.query, data: { ...lv.query.data, items: visibleItems } } as typeof lv.query)
    : lv.query;
  // 일괄 대상은 화면에 실제로 보이는 목록(visibleItems = 문서/마감 필터 반영) 기준이어야 한다.
  // pageItems(필터 미반영) 기준이면 '현재 목록 N건' 라벨과 처리 범위가 어긋나 보이지 않는 업무까지 배정/이관된다(안전 직결).
  const bulkAssignable = visibleItems.filter((t) => t.state === "open" || t.state === "escalated");
  const bulkEscalatable = visibleItems.filter((t) => t.state === "open" || t.state === "assigned" || t.state === "in_progress");
  // 일괄 승인 대상 — **구조화 검토가 필요 없는**(입력 양식/증빙 없는) 업무만: 양식 검토를 안 보고 blanket 승인하는 것을 차단.
  //   resolve 는 assignee-identity 스코프(리졸버 sub=assignee 여야 200)라, 미배정(open/escalated)은 체인에서 self-assign 하고
  //   이미 배정된 업무(assigned/in_progress)는 **내게 배정된 것만** 포함(타인 업무 가로채기 방지). 권한은 kind 별 resolve 로 프리필터.
  const bulkApprovable = visibleItems.filter(
    (t) =>
      !HUMAN_TASK_TERMINAL_STATES.has(t.state) &&
      !requiresStructuredReviewInput(t) &&
      can(`human_task.resolve.${t.kind}`) &&
      (t.state === "open" || t.state === "escalated" || ((t.state === "assigned" || t.state === "in_progress") && t.assignee === subject)),
  );
  const canFilterMine = subject !== null && subject.length > 0;
  const unassignedCount = unassignedQuery.data?.items.filter(isActiveHumanTask).length ?? 0;
  const unassignedCountLabel = unassignedQuery.data?.next_cursor !== null && unassignedQuery.data?.next_cursor !== undefined ? `${unassignedCount}+` : String(unassignedCount);
  const pageErrors: DashboardEnvironmentError[] = [];
  if (lv.query.isError) pageErrors.push({ label: "확인 업무 목록", error: lv.query.error, onRetry: () => void lv.query.refetch() });
  if (unassignedQuery.isError) pageErrors.push({ label: "미배정 업무", error: unassignedQuery.error, onRetry: () => void unassignedQuery.refetch() });
  if (principalsQuery.isError) pageErrors.push({ label: "담당자 목록", error: principalsQuery.error, onRetry: () => void principalsQuery.refetch() });
  const pageErrorKind = environmentErrorKind(pageErrors);
  const hasListData = lv.query.data !== undefined;
  const visibleActiveCount = visibleItems.filter(isActiveHumanTask).length;
  const ownerScopeLabel = lv.filter.unassigned === true
    ? "미배정 업무"
    : lv.filter.assignee === subject
      ? "내 업무"
      : typeof lv.filter.assignee === "string" && lv.filter.assignee.length > 0
        ? `담당자 ${principalLabel(lv.filter.assignee, principalOptions)}`
        : "전체 담당자";
  const viewFilterLabels = [
    ownerScopeLabel,
    activeOnly ? "미종결 업무" : null,
    dueOnly ? "마감 임박" : null,
    documentOnly ? "문서 검증" : null,
    typeof lv.filter.status === "string" && lv.filter.status.length > 0 ? `상태 ${statusLabel(lv.filter.status)}` : null,
    typeof lv.filter.kind === "string" && lv.filter.kind.length > 0 ? `종류 ${kindLabel(lv.filter.kind)}` : null,
    runParam !== null ? `실행 ${runParam}` : null,
  ].filter((label): label is string => label !== null);
  const currentViewLabel = hasListData
    ? `현재 보기 ${visibleItems.length}건 · 처리 대기 ${visibleActiveCount}건`
    : lv.query.isError
      ? "현재 보기 확인 실패"
      : "현재 보기 불러오는 중";
  const nextTaskDetails = nextTask === undefined ? [] : [
    `종류 ${kindLabel(nextTask.kind)}`,
    nextTask.assignee === null ? "미배정" : principalLabel(nextTask.assignee, principalOptions),
    isDocumentValidationTask(nextTask) ? "문서 검증" : null,
    hasBusinessForm(nextTask) ? "입력 항목 있음" : null,
    artifactCount(nextTask) > 0 ? `증빙 ${artifactCount(nextTask)}건` : null,
  ].filter((label): label is string => label !== null);
  return (
    <>
      {sel !== null && <HumanTaskDetailPanel api={api} humanTaskId={sel} detail={detail} principalOptions={principalOptions} onClose={() => { mergeParams({ ht: null }); }} />}
      <DashboardEnvironmentState errors={pageErrors} />
      <section className="metrics human-task-metrics" aria-label="문서 검증 업무 요약">
        <button className="metric metric-link" type="button" onClick={() => setDocumentOnly((value) => !value)} aria-pressed={documentOnly}>
          <span className="label">검증 대기 문서</span>
          <span className="value">{documentItems.length}</span>
          <span className="subtle metric-hint">{documentOnly ? "전체 업무 보기" : "문서 검증만 보기"}</span>
        </button>
        <button className="metric metric-link" type="button" onClick={() => setDocumentOnly(true)} disabled={documentWithArtifacts.length === 0}>
          <span className="label">증빙 자료 있음</span>
          <span className="value">{documentWithArtifacts.length}</span>
          <span className="subtle metric-hint">증빙 자료 포함</span>
        </button>
        <button className="metric metric-link" type="button" onClick={() => setDocumentOnly(true)} disabled={documentWithForm.length === 0}>
          <span className="label">업무 입력 필요</span>
          <span className="value">{documentWithForm.length}</span>
          <span className="subtle metric-hint">입력 항목 포함</span>
        </button>
      </section>
      <section className="panel" style={{ padding: 16, marginBottom: 12, display: "grid", gap: 12 }} aria-label="사람 확인 현재 보기 요약">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
          <div>
            <span className="badge blue">현재 보기</span>
            <h2 style={{ margin: "8px 0 4px", fontSize: 18 }}>{currentViewLabel}</h2>
            <p className="subtle" style={{ margin: 0 }}>{viewFilterLabels.join(" · ")}</p>
          </div>
          <div className="quick-actions" aria-label="현재 보기 필터 요약">
            {viewFilterLabels.map((label, index) => <span key={`${index}:${label}`} className="badge muted">{label}</span>)}
          </div>
        </div>
        {lv.query.isError ? (
          <p className="form-alert red" role="alert" style={{ margin: 0 }}>업무 목록을 불러오지 못해 다음 처리를 판단할 수 없습니다.</p>
        ) : !hasListData ? (
          <p className="subtle" role="status" style={{ margin: 0 }}>업무 목록을 불러오고 있습니다.</p>
        ) : nextTask === undefined ? (
          <p className="form-alert amber" role="status" style={{ margin: 0 }}>현재 보기에서 처리 대기 업무가 없습니다.</p>
        ) : (
          <div className="quick-actions" aria-label="다음 처리 업무 요약">
            <strong>다음 처리</strong>
            <span title={humanTaskRef(nextTask.human_task_id)}>{humanTaskRef(nextTask.human_task_id)}</span>
            <span><DeadlineText value={nextTask.timeout} /></span>
            {nextTaskDetails.map((label, index) => <span key={`${index}:${label}`} className="badge muted">{label}</span>)}
            <button className="btn primary" type="button" onClick={() => mergeParams({ ht: nextTask.human_task_id })}>
              다음 처리 열기
            </button>
          </div>
        )}
      </section>
      <section className="panel queue-controls" aria-label="검토 업무 목록 제어">
        <div>
          <strong>업무 목록 관리</strong>
          <p className="subtle">{documentOnly ? "증빙 자료나 입력 항목이 있는 문서 검증 업무만 보고 있습니다." : "현재 목록에서 담당자, 마감, 다음 처리 업무를 빠르게 확인합니다."}</p>
        </div>
        <div className="quick-actions">
          <button
            className="btn"
            type="button"
            disabled={!canFilterMine}
            title={canFilterMine ? undefined : "로그인이 필요합니다."}
            onClick={() => {
              // assignee 필터는 `= $4::text`(any 문자열) — 비-UUID sub 도 안전. 토글: 내게 배정 ↔ 전체.
              if (canFilterMine) lv.setFilter({ ...lv.filter, assignee: lv.filter.assignee === subject ? undefined : subject, unassigned: undefined });
            }}
          >
            {lv.filter.assignee === subject ? "전체 업무 보기" : "내 업무만 보기"}
          </button>
          {!canFilterMine && <span className="badge amber">로그인이 필요합니다.</span>}
          <button className="btn" type="button" aria-pressed={lv.filter.unassigned === true} title="담당자가 없는 활성 업무만 봅니다." onClick={() => lv.setFilter({ ...lv.filter, assignee: undefined, unassigned: lv.filter.unassigned === true ? undefined : true })}>
            미배정 {unassignedCountLabel}건
          </button>
          <button className="btn" type="button" aria-pressed={dueOnly} title="마감 시각이 있는 현재 보기 업무만 봅니다." onClick={() => setDueOnly((v) => !v)}>
            마감 임박 {dueItems.length}건
          </button>
          <button className="btn" type="button" aria-pressed={documentOnly} title="증빙 또는 입력 항목이 있는 검증 업무만 봅니다." onClick={() => setDocumentOnly((v) => !v)}>
            문서 검증 업무 {documentItems.length}건
          </button>
          <button className="btn" type="button" disabled={nextTask === undefined} onClick={() => { if (nextTask !== undefined) mergeParams({ ht: nextTask.human_task_id }); }}>
            다음 업무 열기
          </button>
          {can("human_task.assign") && bulkAssignable.length > 0 && (
            <ActionButton
              label={`현재 목록 ${bulkAssignable.length}건 담당자 지정`}
              action="human_task.assign"
              inputLabel="담당자 선택 또는 직접 입력"
              inputOptions={principalOptions}
              confirmText="현재 목록의 미배정/이관 업무를 같은 담당자로 지정할까요?"
              run={async (key, assignee) => {
                if (assignee === undefined || assignee === "") throw new Error("담당자를 입력하세요.");
                // 부분 실패를 집계해 표면화한다(조용한 false 금지). 멱등키는 task별 결정형이라 재시도 안전.
                let failedCount = 0;
                for (const task of bulkAssignable) {
                  try {
                    await api.assignHumanTask(task.human_task_id, assignee, `${key}:${task.human_task_id}`);
                  } catch {
                    failedCount += 1;
                  }
                }
                if (failedCount > 0) {
                  const succeededCount = bulkAssignable.length - failedCount;
                  throw new Error(`${failedCount}건 지정 실패${succeededCount > 0 ? ` — ${succeededCount}건은 처리됨` : ""}`);
                }
              }}
              invalidateKeys={KEYS}
            />
          )}
          {can("human_task.escalate") && bulkEscalatable.length > 0 && (
            <ActionButton
              label={`현재 목록 ${bulkEscalatable.length}건 이관`}
              action="human_task.escalate"
              confirmText="현재 목록의 미종결 업무를 상위 담당자에게 이관할까요?"
              run={async (key) => {
                // 부분 실패 집계 표면화(조용한 false 금지). 멱등키 task별 결정형 → 재시도 안전.
                let failedCount = 0;
                for (const task of bulkEscalatable) {
                  try {
                    await api.escalateHumanTask(task.human_task_id, `${key}:${task.human_task_id}`, "bulk_escalate");
                  } catch {
                    failedCount += 1;
                  }
                }
                if (failedCount > 0) {
                  const succeededCount = bulkEscalatable.length - failedCount;
                  throw new Error(`${failedCount}건 이관 실패${succeededCount > 0 ? ` — ${succeededCount}건은 처리됨` : ""}`);
                }
              }}
              invalidateKeys={KEYS}
            />
          )}
          {canFilterMine && bulkApprovable.length > 0 && (
            <ActionButton
              label={`현재 목록 ${bulkApprovable.length}건 일괄 승인`}
              action="human_task.assign"
              confirmText={`선택 없이 현재 목록의 단순 확인 업무 ${bulkApprovable.length}건을 모두 승인 처리합니다. 승인하면 자동화가 이어서 실제 동작을 진행하며 되돌릴 수 없습니다.`}
              run={async (key) => {
                // 상태머신 체인(H1→H2→H3): 미배정은 내게 배정 후 시작, 배정됨은 시작, 진행중은 바로 승인. resolve 는
                //   assignee-identity 스코프라 self-assign 이 선행 필수. 부분 실패 집계 표면화(조용한 false 금지),
                //   단계별 멱등키(task+step 결정형) → 재시도 안전(이미 지난 단계는 replay/422 로 무해).
                let failedCount = 0;
                for (const task of bulkApprovable) {
                  try {
                    if (task.state === "open" || task.state === "escalated") {
                      await api.assignHumanTask(task.human_task_id, subject as string, `${key}:a:${task.human_task_id}`);
                      await api.startHumanTask(task.human_task_id, `${key}:s:${task.human_task_id}`);
                    } else if (task.state === "assigned") {
                      await api.startHumanTask(task.human_task_id, `${key}:s:${task.human_task_id}`);
                    }
                    await api.resolveHumanTask(task.human_task_id, `${key}:r:${task.human_task_id}`, { decision: "approve" });
                  } catch {
                    failedCount += 1;
                  }
                }
                if (failedCount > 0) {
                  const succeededCount = bulkApprovable.length - failedCount;
                  throw new Error(`${failedCount}건 승인 실패${succeededCount > 0 ? ` — ${succeededCount}건은 승인됨` : ""}`);
                }
              }}
              invalidateKeys={KEYS}
            />
          )}
        </div>
      </section>
      <QueryPanel<HumanTaskItem>
        title="검토 업무 목록"
        query={panelQuery}
        pager={lv.pager}
        collapsedErrorKind={pageErrorKind}
        actions={
          <>
            <FilterSelect label="상태" value={lv.filter.status} options={HUMANTASK_STATES} labelFor={statusLabel} onChange={(v) => lv.setFilter({ ...lv.filter, status: v })} />
            <FilterSelect label="종류" value={lv.filter.kind} options={HUMANTASK_KINDS} labelFor={kindLabel} onChange={(v) => lv.setFilter({ ...lv.filter, kind: v })} />
          </>
        }
        rowKey={(r) => r.human_task_id}
        emptyMessage="조건에 맞는 검토 업무가 없습니다."
        columns={[
          { header: "업무", render: (r) => <span title={humanTaskRef(r.human_task_id)}>{humanTaskRef(r.human_task_id)}</span> },
          { header: "종류", render: (r) => kindLabel(r.kind) },
          { header: "상태", render: (r) => <StatusBadge status={r.state} /> },
          { header: "담당자", render: (r) => <span title={principalLabel(r.assignee, principalOptions)}>{principalLabel(r.assignee, principalOptions)}</span> },
          { header: "마감", render: (r) => <DeadlineText value={r.timeout} /> },
          {
            header: "검토 필요사항",
            render: (r) => (
              <span className="human-task-flags">
                {isDocumentValidationTask(r) ? <span className="badge blue">문서 검증</span> : <span className="subtle">—</span>}
                {hasBusinessForm(r) && <span className="badge muted">입력 항목</span>}
                {artifactCount(r) > 0 && <span className="badge muted">증빙 {artifactCount(r)}건</span>}
              </span>
            ),
          },
          {
            header: "상세",
            render: (r) => (
              <button className="btn" type="button" onClick={() => { mergeParams({ ht: r.human_task_id }); }}>
                상세
              </button>
            ),
          },
          { header: "작업", render: (r) => <HumanTaskActions api={api} task={r} principalOptions={principalOptions} /> },
        ]}
      />
    </>
  );
}
