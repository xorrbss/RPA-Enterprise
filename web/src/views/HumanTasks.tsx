import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import { useApiClient } from "../api/context";
import { useCan, useSubject } from "../api/permissions";
import type { ApiClient } from "../api/client";
import { useListView } from "../api/useListView";
import { QueryPanel } from "../components/QueryPanel";
import { ActionButton } from "../components/ActionButton";
import { FilterSelect } from "../components/FilterSelect";
import { HumanTaskReviewPanel } from "../components/HumanTaskReviewPanel";
import { SlideOver } from "../components/SlideOver";
import { StatusBadge, kindLabel, statusLabel } from "../components/badges";
import { ErrorState, Loading, desktopStateForError } from "../components/states";
import { mergeParams, navigate, useHashIdParam, useHashParam } from "../router";
import { formatDeadline } from "../util/time";
import { HUMANTASK_KINDS, HUMANTASK_STATES } from "./filters";
import { ApprovalInboxView } from "./ApprovalInbox";
import type { HumanTaskItem } from "../api/types";

const KEYS = [["human-tasks"]] as const;
const TERMINAL = new Set(["resolved", "expired", "cancelled"]);

function dueTime(task: HumanTaskItem): number {
  return task.timeout !== null ? Date.parse(task.timeout) : Number.POSITIVE_INFINITY;
}

function shortRef(id: string): string {
  return id.slice(0, 8);
}

function humanTaskRef(id: string): string {
  return `접수번호 #${shortRef(id)}`;
}

function principalLabel(
  assignee: string | null,
  principalOptions: readonly { value: string; label?: string }[],
): string {
  if (assignee === null) return "미배정";
  const match = principalOptions.find((option) => option.value === assignee);
  if (match?.label !== undefined && match.label.trim() !== "") return match.label;
  return "담당자 정보 확인 필요";
}

function timeoutActionLabel(value: string | null): string {
  switch (value) {
    case null:
      return "—";
    case "escalate":
      return "상위 담당자에게 이관";
    case "retry":
      return "자동 재검토";
    case "cancel":
      return "자동 종료";
    default:
      return "처리 정책 확인 필요";
  }
}

function DeadlineText({ value }: { value: string | null | undefined }): JSX.Element {
  const deadline = formatDeadline(value);
  if (deadline.text === "-") return <span className="subtle">-</span>;
  if (deadline.overdue) return <span className="badge red" title={value ?? undefined}>{deadline.text}</span>;
  return <span title={value ?? undefined}>{deadline.text}</span>;
}

function hasBusinessForm(task: HumanTaskItem): boolean {
  const schema = task.result_schema;
  return schema !== null && schema !== undefined && typeof schema === "object" && !Array.isArray(schema)
    && (schema as { version?: unknown }).version === "business_form_v1";
}

function artifactCount(task: HumanTaskItem): number {
  return task.artifact_refs?.length ?? 0;
}

function hasStructuredResultSchema(task: HumanTaskItem): boolean {
  const schema = task.result_schema;
  if (schema === null || schema === undefined) return false;
  if (typeof schema !== "object" || Array.isArray(schema)) return true;
  return Object.keys(schema as Record<string, unknown>).length > 0;
}

function requiresStructuredReviewInput(task: HumanTaskItem): boolean {
  return hasStructuredResultSchema(task) || artifactCount(task) > 0;
}

function isDocumentValidationTask(task: HumanTaskItem): boolean {
  return task.kind === "validation" && (hasBusinessForm(task) || artifactCount(task) > 0);
}

// 상태별 운영자 액션(state-machine H1/H2/H3/H5/H6). 권한/assignee 범위는 백엔드가 강제.
// principalOptions = /v1/principals 담당자 디렉터리(value=배정값 sub, label=표시이름). '배정' 입력의 datalist로만 쓰며 자유 입력 폴백은 유지.
function HumanTaskActions({
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
          {requiresStructuredReview ? (
            structuredReviewAction
          ) : (
            <ActionButton label="완료 처리" action={`human_task.resolve.${task.kind}`} confirmText="업무를 완료 처리하고 자동화를 이어서 진행할까요? (별도 입력 항목 없이 완료됩니다)" run={(key) => api.resolveHumanTask(id, key)} invalidateKeys={KEYS} />
          )}
          {escalate}
        </>
      )}
      {task.state === "escalated" && (<>{selfAssign}{assign}</>)}
      {["resolved", "expired", "cancelled"].includes(task.state) && "—"}
    </span>
  );
}

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
  const lv = useListView<HumanTaskItem>(
    ["human-tasks"],
    (p) => api.listHumanTasks(p),
    // 디폴트 = 내게 배정(내 업무 먼저). run_id 딥링크가 있으면 그 우선. sub 부재(미로그인)면 필터 없음.
    { refetchInterval: 5_000, initialFilter: runParam !== null ? { run_id: runParam } : (subject !== null && subject.length > 0 ? { assignee: subject } : undefined) },
  );
  // 선택 사람확인 업무를 해시(`#humanTasks?ht=<id>`)에 보존 → 딥링크·뒤로가기로 드릴다운 복원(RunTrace 패턴 재사용).
  const sel = useHashIdParam("ht");
  const detail = useQuery({ queryKey: ["humantask-detail", sel], queryFn: () => api.getHumanTask(sel as string), enabled: sel !== null });
  const pageItems = lv.query.data?.items ?? [];
  const dueItems = useMemo(() => pageItems.filter((t) => !TERMINAL.has(t.state) && t.timeout !== null).sort((a, b) => dueTime(a) - dueTime(b)), [pageItems]);
  const documentItems = useMemo(() => pageItems.filter((t) => !TERMINAL.has(t.state) && isDocumentValidationTask(t)), [pageItems]);
  const documentWithArtifacts = useMemo(() => documentItems.filter((t) => artifactCount(t) > 0), [documentItems]);
  const documentWithForm = useMemo(() => documentItems.filter(hasBusinessForm), [documentItems]);
  const nextTask = useMemo(() => [...pageItems].filter((t) => !TERMINAL.has(t.state)).sort((a, b) => dueTime(a) - dueTime(b))[0], [pageItems]);
  const visibleItems = useMemo(() => {
    const base = documentOnly ? documentItems : pageItems;
    if (!dueOnly) return base;
    return base.filter((t) => !TERMINAL.has(t.state) && t.timeout !== null).sort((a, b) => dueTime(a) - dueTime(b));
  }, [documentItems, documentOnly, dueOnly, pageItems]);
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
      !TERMINAL.has(t.state) &&
      !requiresStructuredReviewInput(t) &&
      can(`human_task.resolve.${t.kind}`) &&
      (t.state === "open" || t.state === "escalated" || ((t.state === "assigned" || t.state === "in_progress") && t.assignee === subject)),
  );
  const canFilterMine = subject !== null && subject.length > 0;
  return (
    <>
      {sel !== null && <HumanTaskDetailPanel api={api} humanTaskId={sel} detail={detail} principalOptions={principalOptions} onClose={() => { mergeParams({ ht: null }); }} />}
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
              if (canFilterMine) lv.setFilter({ ...lv.filter, assignee: lv.filter.assignee === subject ? undefined : subject });
            }}
          >
            {lv.filter.assignee === subject ? "전체 업무 보기" : "내 업무만 보기"}
          </button>
          {!canFilterMine && <span className="badge amber">로그인이 필요합니다.</span>}
          <button className="btn" type="button" aria-pressed={dueOnly} onClick={() => setDueOnly((v) => !v)}>
            마감 임박 {dueItems.length}
          </button>
          <button className="btn" type="button" aria-pressed={documentOnly} onClick={() => setDocumentOnly((v) => !v)}>
            문서 검증 업무 {documentItems.length}
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

// 사람확인 상세 — getHumanTask(RLS 스코프). on_timeout=human_tasks.on_timeout 실 컬럼(만료 시 동작을 사전 확인).
// 전이 버튼은 인박스와 동일한 HumanTaskActions를 재사용(DRY — 중복 동선 아님). run_id 있으면 원본 실행 교차링크,
// null이면 미렌더(조용한 false 금지). 판정-데이터 입력은 불포함(v1 resolve=순수 continue 신호 — 상세는 관찰만 추가).
function HumanTaskDetailPanel({
  api,
  humanTaskId,
  detail,
  principalOptions,
  onClose,
}: {
  api: ApiClient;
  humanTaskId: string;
  detail: UseQueryResult<HumanTaskItem>;
  principalOptions: readonly { value: string; label?: string }[];
  onClose: () => void;
}): JSX.Element {
  const errorState = detail.isError ? desktopStateForError(detail.error) : null;
  return (
    <SlideOver title={`검토 업무 상세 — ${humanTaskRef(humanTaskId)}`} onClose={onClose}>
      {detail.isLoading ? (
        <Loading />
      ) : detail.isError ? (
        <ErrorState
          title={errorState?.title}
          message={`검토 업무를 확인하지 못했습니다. ${errorState?.message ?? ""}`}
          details={errorState?.details}
          onRetry={() => void detail.refetch()}
        />
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
            <dd style={{ margin: 0 }}>
              <span title={principalLabel(detail.data.assignee, principalOptions)}>{principalLabel(detail.data.assignee, principalOptions)}</span>
            </dd>
            <dt className="subtle">마감</dt>
            <dd style={{ margin: 0 }}><DeadlineText value={detail.data.timeout} /></dd>
            <dt className="subtle">만료 시 처리</dt>
            <dd style={{ margin: 0 }}>
              <span title={timeoutActionLabel(detail.data.on_timeout)}>{timeoutActionLabel(detail.data.on_timeout)}</span>
            </dd>
            {detail.data.run_id !== null && (
              <>
                <dt className="subtle">연결된 실행</dt>
                <dd style={{ margin: 0 }}>
                  <button className="linklike" type="button" onClick={() => { navigate("runTrace", { run: detail.data!.run_id as string }); }}>
                    연결된 실행 보기 <span aria-hidden="true">→</span>
                  </button>
                </dd>
              </>
            )}
            {detail.data.escalation_reason !== null && detail.data.escalation_reason !== undefined && detail.data.escalation_reason !== "" && (
              <>
                <dt className="subtle">이관 사유</dt>
                <dd style={{ margin: 0, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{detail.data.escalation_reason}</dd>
              </>
            )}
          </dl>
          <HumanTaskReviewPanel api={api} task={detail.data} />
          <div style={{ marginTop: 14 }}>
            <strong style={{ fontSize: 13 }}>업무 처리</strong>
            <div style={{ marginTop: 8 }}>
              <HumanTaskActions api={api} task={detail.data} principalOptions={principalOptions} inDetail />
            </div>
          </div>
        </>
      ) : null}
    </SlideOver>
  );
}
