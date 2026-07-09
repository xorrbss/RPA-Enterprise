import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { useApiClient } from "../api/context";
import { useCan } from "../api/permissions";
import { useListView } from "../api/useListView";
import { EmptyState, ErrorState, Loading } from "../components/states";
import { RunScenarioButton } from "../components/RunScenarioButton";
import { mergeParams, navigate, useHashIdParam } from "../router";
import type { ScenarioItem } from "../api/types";
import { StepCards } from "../components/easy-create/StepCards";
import { TestProgress } from "../components/easy-create/TestProgress";

// 테스트 실행(playground) — 저장된 자동화의 실행 계획(IR → 단계·흐름)을 정적으로 미리본 뒤, 그대로 실제 실행을
// 시작할 수 있다(RunScenarioButton = createRun, run.create 게이팅). 실제 브라우저 작업은 worker/Chrome가
// 연결된 환경에서 수행되고(architecture §9 D3), 진행 상황은 '실행 기록' 뷰에서 확인한다.

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// E2: 계획 미리보기는 공용 번역기(step-sentences→StepCards)를 소비 — 만들기 초안 확인과 동일 문장
// (원시 노드 id·IREL 원문 기본 노출 제거, 감사 P1-7 관리 콘솔 잔존 표면 해소).
function hasRunnablePlan(ir: unknown): boolean {
  return isRecord(ir) && isRecord(ir.nodes) && typeof ir.start === "string";
}

function TestProgressPanel(props: {
  readonly hasSelection: boolean;
  readonly selectedName: string | null;
  readonly planState: "idle" | "loading" | "ready" | "missing" | "error";
  readonly canRun: boolean;
  readonly canStartHere: boolean;
  readonly onViewRuns: () => void;
}): JSX.Element {
  const selectionReady = props.hasSelection;
  const planReady = props.planState === "ready";
  const canStart = props.canRun && props.canStartHere;
  const steps = [
    {
      title: "1. 자동화 선택",
      badge: selectionReady ? "완료" : "현재",
      tone: selectionReady ? "green" : "blue",
      current: !selectionReady,
      detail: selectionReady ? (props.selectedName ?? "선택한 자동화") : "목록에서 테스트할 자동화를 고릅니다.",
    },
    {
      title: "2. 계획 미리보기",
      badge:
        props.planState === "ready"
          ? "표시 중"
          : props.planState === "loading"
            ? "확인 중"
            : props.planState === "error"
              ? "확인 필요"
              : "대기",
      tone:
        props.planState === "ready"
          ? "green"
          : props.planState === "loading"
            ? "blue"
            : props.planState === "error"
              ? "amber"
              : "muted",
      current: selectionReady && !planReady,
      detail:
        props.planState === "ready"
          ? "아래 단계와 흐름을 확인합니다."
          : props.planState === "loading"
            ? "자동화 정의를 불러오는 중입니다."
            : props.planState === "missing"
              ? "표시할 실행 계획이 없습니다."
              : props.planState === "error"
                ? "자동화 정보를 다시 불러와야 합니다."
                : "자동화 선택 후 표시됩니다.",
    },
    {
      title: "3. 테스트 시작",
      badge: canStart ? "준비됨" : props.canRun ? "대기" : "권한 필요",
      tone: canStart ? "green" : props.canRun ? "muted" : "amber",
      current: planReady && !canStart,
      detail: canStart
        ? "실행 시작 시 테스트 run이 등록되고 아래 단계에 진행이 실시간 표시됩니다." // E4: 인라인 관찰(화면 이동 없음)
        : props.canRun
          ? "선택한 자동화가 현재 목록에 있을 때 실행 버튼이 표시됩니다."
          : "run.create 권한이 있어야 테스트를 시작할 수 있습니다.",
    },
    {
      title: "4. 기록/증빙 확인",
      badge: selectionReady ? "연결됨" : "대기",
      tone: selectionReady ? "blue" : "muted",
      current: false,
      detail: selectionReady ? "생성된 run은 실행 기록에서 상태와 산출물을 확인합니다." : "테스트 시작 후 실행 기록에서 확인합니다.",
    },
  ] as const;

  return (
    <section className="panel test-progress" aria-label="테스트 실행 준비 흐름">
      <div className="panel-head">
        <h2>테스트 실행 준비</h2>
        <button className="btn" type="button" onClick={props.onViewRuns}>
          기록/증빙 보기
        </button>
      </div>
      <div className="test-progress-body">
        <ol className="test-progress-steps">
          {steps.map((step) => (
            <li key={step.title} className={`test-progress-step${step.current ? " current" : ""}`}>
              <div className="test-progress-step-head">
                <strong>{step.title}</strong>
                <span className={`badge ${step.tone}`}>{step.badge}</span>
              </div>
              <span className="subtle">{step.detail}</span>
            </li>
          ))}
        </ol>
        <p className="subtle" style={{ margin: 0 }}>
          테스트 시작은 새 run을 만드는 실제 작업입니다. 진행과 결과는 아래에서 바로 확인하고, 상세 증빙은 실행 기록에서 봅니다.
        </p>
      </div>
    </section>
  );
}

export function ScenarioTestWorkbench({
  embedded = false,
  createRoute = "scenarioStudio",
}: {
  readonly embedded?: boolean;
  readonly createRoute?: "create" | "scenarioStudio";
} = {}): JSX.Element {
  const api = useApiClient();
  const can = useCan();
  const scenarioParam = useHashIdParam("scenario");
  // E4: 시작한 테스트 run 을 해시에 보존 — 새로고침/딥링크로 인라인 진행이 복원된다(§2.2).
  const testRunId = useHashIdParam("run");
  const list = useListView<ScenarioItem>(
    ["scenarios", "playground"],
    (params) => api.listScenarios(params),
    { limit: 50, refetchInterval: 10_000 },
  );
  const [sel, setSel] = useState<string>(() => scenarioParam ?? "");
  const detail = useQuery({ queryKey: ["scenario-detail", sel], queryFn: () => api.getScenario(sel), enabled: sel !== "" });

  const items: readonly ScenarioItem[] = list.query.data?.items ?? [];
  const selected = items.find((s) => s.scenario_id === sel);
  const selectedName = selected?.name ?? detail.data?.name ?? null;
  const planState =
    sel === ""
      ? "idle"
      : detail.isLoading
        ? "loading"
        : detail.isError
          ? "error"
          : hasRunnablePlan(detail.data?.ir)
            ? "ready"
            : "missing";

  useEffect(() => {
    if (scenarioParam !== null && scenarioParam !== sel) setSel(scenarioParam);
  }, [scenarioParam, sel]);

  function selectScenario(next: string): void {
    setSel(next);
    mergeParams({ scenario: next.length > 0 ? next : null, run: null });
  }

  return (
    <section className={embedded ? "scenario-test-workbench" : undefined} aria-label="계획·테스트 작업대">
      <p className="badge" style={{ display: "block", marginBottom: 12, whiteSpace: "normal" }}>
        실행 계획(단계·흐름)을 미리 본 뒤 그대로 실제 실행을 시작할 수 있습니다. 실행을 시작하면 아래 단계에 진행 상태가 실시간으로 표시되고, 상세 증빙은 실행 기록에서 확인합니다.
      </p>
      {!embedded && can("scenario.create") && (
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 12 }}>
          <button className="btn primary" type="button" onClick={() => navigate(createRoute, { creator: "ai" })}>
            자연어로 자동화 만들기
          </button>
          <span className="subtle">저장 후 실행까지 이어지는 자동화 생성 화면으로 이동합니다.</span>
        </div>
      )}
      <TestProgressPanel
        hasSelection={sel !== ""}
        selectedName={selectedName}
        planState={planState}
        canRun={can("run.create")}
        canStartHere={selected !== undefined}
        onViewRuns={() => navigate("runTrace", sel !== "" ? { scenario: sel } : undefined)}
      />
      {list.query.isLoading ? (
        <Loading />
      ) : list.query.isError ? (
        <ErrorState message="자동화 목록을 불러오지 못했습니다. 자동화가 아직 없으면 자동화 만들기에서 먼저 생성하세요. 계속 실패하면 API 연결 또는 권한을 확인하세요." onRetry={() => void list.query.refetch()} />
      ) : (
        <>
          <label style={{ display: "block", marginBottom: 12 }}>
            <span className="subtle">자동화 선택</span>
            <br />
            <select value={sel} onChange={(e) => selectScenario(e.target.value)} style={{ padding: "6px 8px", fontSize: 14, minWidth: 280 }}>
              <option value="">— 자동화를 선택하세요 —</option>
              {items.map((s) => (
                <option key={s.scenario_id} value={s.scenario_id}>
                  {s.name} (변경 {s.version})
                </option>
              ))}
            </select>
            <span className="subtle" style={{ display: "block", marginTop: 6 }}>
              현재 {list.pager.pageIndex + 1}페이지 {items.length}
              {(list.query.data?.next_cursor ?? null) !== null ? "+" : ""}건을 표시합니다.
            </span>
          </label>
          {(list.pager.hasPrev || list.pager.hasNext) && (
            <div className="inline-actions" style={{ marginBottom: 12 }}>
              <button className="btn" type="button" onClick={list.pager.onPrev} disabled={!list.pager.hasPrev}>
                이전
              </button>
              <button className="btn" type="button" onClick={list.pager.onNext} disabled={!list.pager.hasNext}>
                다음
              </button>
              <span className="subtle">찾는 자동화가 없으면 다음 페이지를 확인하세요.</span>
            </div>
          )}
          {sel === "" ? (
            <EmptyState message="자동화를 선택하면 실행 계획이 표시됩니다." />
          ) : (
            <>
              {selected !== undefined ? (
                <div style={{ position: "relative", display: "flex", gap: 8, alignItems: "center", marginBottom: 12, flexWrap: "wrap" }}>
                  {/* E4: 테스트 시작이 화면을 튕기지 않는다 — 같은 화면에서 단계 카드에 진행을 오버레이(인라인 관찰). */}
                  {can("run.create") && (
                    <RunScenarioButton scenario={selected} runMode="test" onStarted={(runId) => mergeParams({ run: runId })} />
                  )}
                  <button className="btn" type="button" onClick={() => navigate("runTrace", { scenario: selected.scenario_id })}>실행 기록 보기</button>
                  {can("run.create") && <span className="subtle">실행을 시작하면 아래 단계에 진행 상태가 실시간으로 표시됩니다.</span>}
                </div>
              ) : (
                <p className="subtle" role="status" style={{ margin: "0 0 12px" }}>
                  선택한 자동화의 실행 버튼은 현재 목록 페이지에 있을 때 표시됩니다. 계획은 아래에서 확인할 수 있습니다.
                </p>
              )}
              {detail.isLoading ? (
                <Loading />
              ) : detail.isError ? (
                <ErrorState message="선택한 자동화 정보를 불러오지 못했습니다. 목록을 새로고침하거나 다른 자동화를 선택하세요." onRetry={() => void detail.refetch()} />
              ) : testRunId !== null ? (
                <TestProgress runId={testRunId} ir={detail.data?.ir} />
              ) : (
                <StepCards ir={detail.data?.ir} emptyMessage="실행 계획을 표시할 자동화 정의가 없습니다." />
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}

export function PlaygroundView(): JSX.Element {
  return <ScenarioTestWorkbench />;
}
