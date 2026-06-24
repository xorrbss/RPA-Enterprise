import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import { useApiClient } from "../api/context";
import { isUuid, useCan, useSubject } from "../api/permissions";
import type { ApiClient } from "../api/client";
import { useListView } from "../api/useListView";
import { QueryPanel } from "../components/QueryPanel";
import { ActionButton } from "../components/ActionButton";
import { FilterSelect } from "../components/FilterSelect";
import { HumanTaskReviewPanel } from "../components/HumanTaskReviewPanel";
import { SlideOver } from "../components/SlideOver";
import { StatusBadge, kindLabel, statusLabel } from "../components/badges";
import { ErrorState, Loading } from "../components/states";
import { mergeParams, navigate, useHashIdParam, useHashParam } from "../router";
import { HUMANTASK_KINDS, HUMANTASK_STATES } from "./filters";
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
  // ⚠ sub는 비-UUID OIDC 식별자(auth0|…·이메일)일 수 있다. 현재는 보수적으로 sub가 UUID일 때만 렌더(isUuid) —
  //   비-UUID sub의 self-assign 허용은 selfAssign 한정 별개 변경이라 본 PR(담당자 picker) 범위 밖. 비-UUID/부재면
  //   '담당자 지정'(아래)에서 picker/직접입력으로 처리(조용한 false 금지).
  const selfAssign = isUuid(subject) ? (
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
    <ActionButton label="이관" action="human_task.escalate" confirmText="이 업무를 상위 담당자에게 이관할까요?" run={(key) => api.escalateHumanTask(id, key)} invalidateKeys={KEYS} />
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

export function HumanTasksView(): JSX.Element {
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
    { refetchInterval: 5_000, initialFilter: runParam !== null ? { run_id: runParam } : undefined },
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
  const bulkAssignable = pageItems.filter((t) => t.state === "open" || t.state === "escalated");
  const bulkEscalatable = pageItems.filter((t) => t.state === "open" || t.state === "assigned" || t.state === "in_progress");
  const canFilterMine = isUuid(subject);
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
            title={canFilterMine ? undefined : "현재 로그인 식별자는 담당자 필터 형식으로 사용할 수 없습니다."}
            onClick={() => {
              // sub가 UUID일 때만(버튼 disabled 가드와 동치) — 비-UUID sub를 assignee 필터로 보내면 백엔드 uuidFilter가 422로 목록을 깨뜨린다.
              if (canFilterMine) lv.setFilter({ ...lv.filter, assignee: lv.filter.assignee === subject ? undefined : subject });
            }}
          >
            {lv.filter.assignee === subject ? "전체 업무 보기" : "내 업무만 보기"}
          </button>
          {!canFilterMine && <span className="badge amber">내 업무 필터를 쓰려면 담당자 디렉터리 매핑이 필요합니다.</span>}
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
                await Promise.all(bulkAssignable.map((task) => api.assignHumanTask(task.human_task_id, assignee, `${key}:${task.human_task_id}`)));
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
                await Promise.all(bulkEscalatable.map((task) => api.escalateHumanTask(task.human_task_id, `${key}:${task.human_task_id}`, "bulk_escalate")));
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
          { header: "마감", render: (r) => r.timeout ?? "—" },
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
  return (
    <SlideOver title={`검토 업무 상세 — ${humanTaskRef(humanTaskId)}`} onClose={onClose}>
      {detail.isLoading ? (
        <Loading />
      ) : detail.isError ? (
        <ErrorState message="검토 업무를 불러오지 못했습니다." onRetry={() => void detail.refetch()} />
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
            <dd style={{ margin: 0 }}>{detail.data.timeout ?? "—"}</dd>
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
