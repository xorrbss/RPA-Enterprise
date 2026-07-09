import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { useApiClient } from "../../api/context";
import type { RunDetail, StepSummary } from "../../api/types";
import { StatusBadge, errorCodeLabel } from "../badges";
import { navigate } from "../../router";
import { ErrorState } from "../states";
import { StepCards, type StepUiState } from "./StepCards";
import { SUSPENDED, TERMINAL, runDetailRefetchInterval } from "../../views/runtrace/constants";

// E4: 인라인 테스트 진행 — 실행을 시작해도 화면을 튕기지 않고(감사 근본원인 §2-4) 같은 화면에서
// 단계 카드에 실시간 상태를 오버레이한다. 데이터는 기존 관례 재사용: getRun 폴링(runDetailRefetchInterval,
// 터미널이면 중단) + listRunSteps 5초 + watchRunSteps SSE 무효화(StepTrace 패턴, 쿼리키 ["run-steps",runId] 공유).
// suspended 는 resolve 후 자동 재개(R13 이벤트) — UI는 폴링 지속만 한다(resume 직접 호출 금지, 계약 §reserved-handlers).

// step.status(9종, migration_core_entities) → 카드 오버레이 상태.
function stepUiState(status: string): StepUiState {
  switch (status) {
    case "started": return "running";
    case "success": return "success";
    case "failed_business":
    case "failed_system":
    case "failed_security": return "failed";
    case "failed_challenge": return "suspended";
    case "uncertain": return "uncertain";
    case "skipped": return "skipped";
    case "suspended": return "suspended";
    default: return "waiting";
  }
}

// run.status → 배너(§4.7 표). 어휘 체인: cancelled=취소됨.
function runBanner(status: string): { tone: "green" | "amber" | "red" | "blue" | "muted"; text: string } {
  if (status === "completed") return { tone: "green", text: "테스트 성공! 아래 단계별 결과를 확인하세요." };
  if (status === "failed_business") return { tone: "amber", text: "업무 확인이 필요해요 — 아래 실패 단계와 사유를 확인하세요." };
  if (status === "failed_system") return { tone: "red", text: "시스템 문제로 중단됐어요 — 잠시 후 다시 실행해 보세요." };
  if (status === "cancelled") return { tone: "muted", text: "취소됨" };
  if (SUSPENDED.has(status)) return { tone: "amber", text: "사람의 확인이 필요해요 — 사람 확인에서 처리하면 자동으로 이어집니다." };
  if (status === "resume_requested" || status === "resuming") return { tone: "blue", text: "이어서 실행 중입니다." };
  if (status === "queued" || status === "claimed") return { tone: "blue", text: "테스트 준비 중입니다." };
  return { tone: "blue", text: "실행 중입니다 — 단계가 실시간으로 갱신됩니다." };
}

export function TestProgress({ runId, ir }: { readonly runId: string; readonly ir: unknown }): JSX.Element {
  const api = useApiClient();
  const queryClient = useQueryClient();
  const run = useQuery({
    queryKey: ["run-detail", runId],
    queryFn: () => api.getRun(runId),
    refetchInterval: (query) => runDetailRefetchInterval((query.state.data as RunDetail | undefined)?.status),
  });
  const steps = useQuery({
    queryKey: ["run-steps", runId],
    queryFn: () => api.listRunSteps(runId, { limit: 100 }),
    refetchInterval: run.data !== undefined && TERMINAL.has(run.data.status) ? false : 5_000,
  });
  useEffect(() => {
    // SSE 변경 신호 → 쿼리 무효화(StepTrace 패턴 공유). 구독 해제는 unmount 시.
    const unsubscribe = api.watchRunSteps(runId, () => {
      void queryClient.invalidateQueries({ queryKey: ["run-steps", runId] });
      void queryClient.invalidateQueries({ queryKey: ["run-detail", runId] });
    });
    return unsubscribe;
  }, [api, queryClient, runId]);

  const stepItems: readonly StepSummary[] = steps.data?.items ?? [];
  // node_id별 최신 시도(attempt 최대)의 상태가 카드 상태 — 재시도 이력은 상세 트레이스 몫.
  const stepStates = new Map<string, StepUiState>();
  for (const step of stepItems) stepStates.set(step.node_id, stepUiState(step.status));

  if (run.isError) {
    return <ErrorState message="테스트 실행 상태를 불러오지 못했습니다." onRetry={() => void run.refetch()} />;
  }
  const status = run.data?.status;
  const banner = status !== undefined ? runBanner(status) : { tone: "blue" as const, text: "테스트 준비 중입니다." };
  const failureCode = run.data?.failure_reason?.code ?? null;
  return (
    <section className="inline-test-progress" aria-label="테스트 진행">
      <div className={`form-alert ${banner.tone}`} role="status">
        <span>{banner.text}</span>
        {status !== undefined && <StatusBadge status={status} />}
      </div>
      {failureCode !== null && (
        <p className="subtle inline-test-progress-failure">
          원인: {errorCodeLabel(failureCode, { terminal: true })}
          <code className="run-short-id"> {failureCode}</code>
        </p>
      )}
      <StepCards ir={ir} stepStates={stepStates} emptyMessage="단계 정의를 표시할 수 없습니다 — 실행 기록에서 확인하세요." />
      <div className="inline-actions">
        {status !== undefined && SUSPENDED.has(status) && (
          <button className="btn primary" type="button" onClick={() => navigate("humanTasks", { run: runId })}>
            사람 확인 처리하러 가기
          </button>
        )}
        <button className="btn" type="button" onClick={() => navigate("runTrace", { run: runId, focus: "artifacts" })}>
          실행 증거·상세 보기
        </button>
      </div>
    </section>
  );
}
