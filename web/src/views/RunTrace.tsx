import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import { useApiClient } from "../api/context";
import { useListView } from "../api/useListView";
import { QueryPanel } from "../components/QueryPanel";
import { ActionButton } from "../components/ActionButton";
import { ArtifactLookup, ArtifactRef } from "../components/ArtifactLookup";
import { StepTrace } from "../components/StepTrace";
import { FilterSelect } from "../components/FilterSelect";
import { StatusBadge, tone, type Tone } from "../components/badges";
import { ErrorState, Loading } from "../components/states";
import { RUN_STATES } from "./filters";
import { mergeParams, navigate, useHashParam } from "../router";
import type { RunArtifactItem, RunDetail, RunItem } from "../api/types";

const POLL_MS = 5_000; // 실시간 = outbox tail 폴링(v1)
const TERMINAL = new Set(["completed", "cancelled", "failed_business", "failed_system"]);
// '사람 확인 대기'가 확실한 비-터미널 status만(state-machine). StatusBadge가 suspended를 '사람 확인 대기'로 라벨링하는 것과 정합.
// suspending은 bookmark 저장 중 전이 상태(R11→suspended / R12→failed_system, 미정착)라 StatusBadge가 '보류 중'으로 라벨링하므로
// 배너의 '대기 중'과 어휘가 충돌 + '대기' 단정이 한 발 앞선다 → 제외(suspended 단일 게이팅 = 배지와 동일 출처 정합).
// resume_requested/resuming도 이미 resolve 진행 중이라 '대기' 단정이 과해 제외(보수적 게이팅).
const SUSPENDED = new Set(["suspended"]);

// F3 터미널 '도착' 톤 — 터미널 여부는 TERMINAL Set 단일 출처가 게이팅하고(비-터미널이면 null = 배너 없음),
// 색은 badges.tone()에 위임해 도착 배너 배경과 내부 StatusBadge 색이 한 출처에서 항상 일치하게 한다(DRY·드리프트 방지).
// (completed=green, 실패=red, cancelled=muted; 어휘 체인 abort→cancelled. 비-터미널 null = 조용한 false 금지.)
function arrivalTone(status: string): Tone | null {
  return TERMINAL.has(status) ? tone(status) : null;
}

export function RunTraceView(): JSX.Element {
  const api = useApiClient();
  // 딥링크 `#runTrace?status=<RunState>`(예: 대시보드 '실행 중' 카드)로 진입 시 상태 필터를 시드 → 카운트와 목록 모집단 일치.
  const statusParam = useHashParam("status");
  const initialFilter = statusParam !== null && (RUN_STATES as readonly string[]).includes(statusParam) ? { status: statusParam } : undefined;
  const lv = useListView<RunItem>(["runs"], (p) => api.listRuns(p), { refetchInterval: POLL_MS, initialFilter });
  // 선택 run을 해시(`#runTrace?run=<id>`)에 보존 → 딥링크·뒤로가기로 드릴다운 복원(useState 휘발 대체).
  const sel = useHashParam("run");
  const detail = useQuery({ queryKey: ["run-detail", sel], queryFn: () => api.getRun(sel as string), enabled: sel !== null });

  return (
    <div>
      <ArtifactLookup />
      {sel !== null && <RunDetailPanel runId={sel} detail={detail} onClose={() => { mergeParams({ run: null, artifact: null }); }} />}
      <QueryPanel<RunItem>
        title="실행 기록"
        query={lv.query}
        pager={lv.pager}
        actions={<FilterSelect label="상태" value={lv.filter.status} options={RUN_STATES} onChange={(v) => lv.setFilter({ status: v })} />}
        rowKey={(r) => r.run_id}
        emptyMessage="조건에 맞는 실행 기록이 없습니다."
        columns={[
          { header: "실행 ID", render: (r) => <code>{r.run_id.slice(0, 8)}</code> },
          {
            header: "상태",
            render: (r) => (
              <span style={{ display: "inline-flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                <StatusBadge status={r.status} />
                {r.failure_reason !== null && r.failure_reason !== undefined && (
                  <span className="badge red">{r.failure_reason.code}</span>
                )}
              </span>
            ),
          },
          { header: "기준 시각", render: (r) => r.as_of ?? "—" },
          {
            header: "작업",
            render: (r) => (
              <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                <button className="btn" type="button" onClick={() => { mergeParams({ run: r.run_id, artifact: null }); }}>
                  상세
                </button>
                {!TERMINAL.has(r.status) && (
                  <ActionButton
                    label="취소"
                    action="run.abort"
                    confirmText={`실행 ${r.run_id.slice(0, 8)}을(를) 취소할까요? (abort→cancelled)`}
                    run={(key) => api.abortRun(r.run_id, key)}
                    invalidateKeys={[["runs"]]}
                  />
                )}
              </span>
            ),
          },
        ]}
      />
    </div>
  );
}

// 실행 상세 — getRun(RLS 스코프) + run_steps 단계 트레이스(GET /v1/runs/{id}/steps, api-surface §1).
function RunDetailPanel({
  runId,
  detail,
  onClose,
}: {
  runId: string;
  detail: UseQueryResult<RunDetail>;
  onClose: () => void;
}): JSX.Element {
  return (
    <section className="panel" style={{ marginBottom: 16, padding: 16 }} aria-label="실행 상세">
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <strong>실행 상세 — {runId.slice(0, 8)}</strong>
        <button className="btn" type="button" onClick={onClose}>
          닫기
        </button>
      </header>
      {detail.isLoading ? (
        <Loading />
      ) : detail.isError ? (
        <ErrorState message="실행을 불러오지 못했습니다." onRetry={() => void detail.refetch()} />
      ) : detail.data !== undefined ? (
        <>
        <ArrivalBanner status={detail.data.status} attempts={detail.data.attempts} reason={detail.data.failure_reason ?? null} />
        <dl style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "6px 16px", margin: 0 }}>
          <dt className="subtle">상태</dt>
          <dd style={{ margin: 0 }}>
            <StatusBadge status={detail.data.status} />
          </dd>
          <dt className="subtle">워커</dt>
          <dd style={{ margin: 0 }}>{detail.data.worker_id ?? "— (미할당)"}</dd>
          <dt className="subtle">시도 횟수</dt>
          <dd style={{ margin: 0 }}>{detail.data.attempts}</dd>
          <dt className="subtle">기준 시각(as_of)</dt>
          <dd style={{ margin: 0 }}>{detail.data.as_of ?? "—"}</dd>
        </dl>
        {/* suspended 계열(사람 확인 대기)일 때만 인박스 교차 동선 노출 — 막다른 길 해소. 게이팅은 RunDetail.status(실 필드)뿐.
            RunDetail에 human_task_id가 없고 GET /v1/human-tasks가 run_id 필터를 honor하지 않으므로(reads.ts:331 SELECT만)
            정확한 human_task 자동선택은 조용한 false라 약속하지 않는다 — 인박스 처리 동선만 안내(status 재단정 없음).
            TODO: [BLOCKED]
              violated: KISS(run→정확한 human_task 직접 점프가 더 단순하나)
              reason: RunDetail.human_task_id 부재 + GET /v1/human-tasks ?run_id 필터 미honor(계약/백엔드=오너 영역)
              required_change: GET /v1/human-tasks 의 run_id 필터 추가(또는 RunDetail.human_task_id 투영) — 계약 변경 선행 */}
        {SUSPENDED.has(detail.data.status) && (
          <p className="badge amber" role="status" style={{ display: "block", margin: "8px 0 0", whiteSpace: "normal" }}>
            이 실행은 사람 확인 대기 중입니다 — {" "}
            <button className="linklike" type="button" onClick={() => navigate("humanTasks")}>
              사람 확인 인박스에서 처리하기 <span aria-hidden="true">→</span>
            </button>
          </p>
        )}
        </>
      ) : null}
      <StepTrace runId={runId} />
      <RunArtifactsList runId={runId} />
    </section>
  );
}

// F3 터미널 '도착 순간' 배너 — 실행이 완료/실패/취소로 종료되었음을 분명히 알린다(구매 모먼트의 '도착').
// 도착 판정=detail.status(실 필드)만. 시도횟수=detail.attempts(실 필드). 실패 사유(reason)는 RunDetail에 없으므로
// 만들지 않고 단계 트레이스의 exception.code(이미 진실원천)로 유도한다. 비-터미널이면 배너 없음(조용한 false 금지).
function ArrivalBanner({
  status,
  attempts,
  reason,
}: {
  status: string;
  attempts: number;
  reason: { code: string; message: string } | null;
}): JSX.Element | null {
  const bannerTone = arrivalTone(status); // arrivalTone이 badges.tone()에 위임(색 단일 출처)
  if (bannerTone === null) return null;
  const failed = bannerTone === "red";
  return (
    <div className={`arrival-banner badge ${bannerTone}`} role="status">
      <StatusBadge status={status} />
      <span>실행이 종료되었습니다{attempts > 1 ? ` · 시도 ${attempts}회` : ""}.</span>
      {failed && reason !== null && <span>{reason.code}: {reason.message}</span>}
      {failed && reason === null && <span className="subtle">자세한 원인은 아래 단계 트레이스를 확인하세요.</span>}
    </div>
  );
}

// 산출물(artifact) 목록 — metadata-only(종류/redaction/보존). 본문은 artifact_id를 위 '산출물 조회'(#129)에 입력(redaction→RBAC→audit 게이트). 라이브=폴링.
function RunArtifactsList({ runId }: { runId: string }): JSX.Element {
  const api = useApiClient();
  const q = useQuery({
    queryKey: ["run-artifacts", runId],
    queryFn: () => api.listRunArtifacts(runId, { limit: 100 }),
    refetchInterval: POLL_MS,
  });
  const items: readonly RunArtifactItem[] = q.data?.items ?? [];
  return (
    <div style={{ marginTop: 14 }}>
      <strong style={{ fontSize: 13 }}>산출물(artifact)</strong>
      {q.isLoading ? (
        <Loading />
      ) : q.isError ? (
        <ErrorState message="산출물 목록을 불러오지 못했습니다." onRetry={() => void q.refetch()} />
      ) : items.length === 0 ? (
        <p className="subtle" style={{ margin: "8px 0 0" }}>표시할 산출물이 없습니다.</p>
      ) : (
        <div className="table-wrap" style={{ marginTop: 8 }}>
          <table>
            <thead>
              <tr><th>artifact_id</th><th>종류</th><th>redaction</th><th>보존 만료</th><th>legal hold</th></tr>
            </thead>
            <tbody>
              {items.map((a) => (
                <tr key={a.artifact_id}>
                  <td><ArtifactRef id={a.artifact_id} /></td>
                  <td>{a.type}</td>
                  <td><span className="badge muted">{a.redaction_status}</span></td>
                  <td>{a.retention_until ?? "—"}</td>
                  <td>{a.legal_hold ? "예" : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
