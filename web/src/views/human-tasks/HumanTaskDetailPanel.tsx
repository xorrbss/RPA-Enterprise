import type { UseQueryResult } from "@tanstack/react-query";

import type { ApiClient } from "../../api/client";
import type { HumanTaskItem } from "../../api/types";
import { HumanTaskReviewPanel } from "../../components/HumanTaskReviewPanel";
import { SlideOver } from "../../components/SlideOver";
import { StatusBadge, kindLabel } from "../../components/badges";
import { ErrorState, Loading, desktopStateForError } from "../../components/states";
import { navigate } from "../../router";
import { HumanTaskActions } from "./HumanTaskActions";
import { DeadlineText, humanTaskRef, principalLabel, timeoutActionLabel } from "./labels";

// 사람확인 상세 — getHumanTask(RLS 스코프). on_timeout=human_tasks.on_timeout 실 컬럼(만료 시 동작을 사전 확인).
// 전이 버튼은 인박스와 동일한 HumanTaskActions를 재사용(DRY — 중복 동선 아님). run_id 있으면 원본 실행 교차링크,
// null이면 미렌더(조용한 false 금지). 판정-데이터 입력은 불포함(v1 resolve=순수 continue 신호 — 상세는 관찰만 추가).
export function HumanTaskDetailPanel({
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
