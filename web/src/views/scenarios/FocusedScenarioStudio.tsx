import { useApiClient } from "../../api/context";
import { StepCards } from "../../components/easy-create/StepCards";
import { ReviseControl } from "../../components/easy-create/ReviseControl";
import { useSavedReviseDiff } from "../../components/easy-create/use-saved-revise-diff";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { ClipboardCheck, FileCheck2, ListChecks, PlaySquare, ScrollText, Settings, X, type LucideIcon } from "lucide-react";

import { navigate } from "../../router";
import { formatDateTime } from "../../util/time";
import { RunModeBadge, StatusBadge } from "../../components/badges";
import { assessTestRunReadiness, runStatusLabel } from "../../components/readiness";
import type { RunItem, ScenarioItem } from "../../api/types";

type FocusTab = "plan" | "test" | "links" | "activity" | "versions" | "settings";

const FOCUS_TABS: readonly { readonly key: FocusTab; readonly label: string; readonly icon: LucideIcon }[] = [
  { key: "plan", label: "설계", icon: ListChecks },
  { key: "test", label: "테스트", icon: PlaySquare },
  { key: "links", label: "연결", icon: FileCheck2 },
  { key: "activity", label: "활동", icon: ScrollText },
  { key: "versions", label: "버전", icon: ClipboardCheck },
  { key: "settings", label: "설정", icon: Settings },
];

export function FocusedScenarioStudio({
  scenario,
  requestedScenarioId,
  latestRun,
  recentRuns,
  loading,
  canCreateRun,
  canReadEvidence,
  canUpdateScenario,
  onTest,
  onEvidence,
  onEdit,
  onVersions,
  onReleases,
  onExit,
}: {
  scenario: ScenarioItem | null;
  requestedScenarioId: string | null;
  latestRun: RunItem | null;
  recentRuns: readonly RunItem[];
  loading: boolean;
  canCreateRun: boolean;
  canReadEvidence: boolean;
  canUpdateScenario: boolean;
  onTest: (scenarioId: string) => void;
  onEvidence: (runId: string) => void;
  onEdit: (scenario: ScenarioItem) => void;
  onVersions: (scenario: ScenarioItem) => void;
  onReleases: (scenario: ScenarioItem) => void;
  onExit: () => void;
}): JSX.Element {
  const [activeTab, setActiveTab] = useState<FocusTab>("plan");

  useEffect(() => {
    setActiveTab("plan");
  }, [scenario?.scenario_id, requestedScenarioId]);

  if (scenario === null) {
    return (
      <section className="panel focused-studio" aria-label="집중 자동화 스튜디오">
        <div className="panel-head">
          <div>
            <h2>{loading ? "자동화 불러오는 중" : "자동화를 찾을 수 없습니다"}</h2>
            <p className="subtle">
              {loading
                ? "선택한 자동화의 최신 목록과 실행 상태를 확인하고 있습니다."
                : requestedScenarioId === null
                  ? "목록에서 자동화를 선택하면 집중 작업 화면을 열 수 있습니다."
                  : "요청한 자동화가 현재 목록에 없습니다. 보관되었거나 권한이 바뀌었는지 확인해 주세요."}
            </p>
          </div>
          <button className="btn" type="button" onClick={onExit}>
            <X size={14} aria-hidden="true" />
            목록으로
          </button>
        </div>
      </section>
    );
  }

  const latestRunTime = formatDateTime(latestRun?.as_of ?? latestRun?.updated_at);
  const hasEvidencePath = latestRun !== null && canReadEvidence;
  const runCompleted = latestRun?.status === "completed";
  const testReadiness = assessTestRunReadiness(recentRuns);
  const testBadgeLabel = testReadiness.status === "ready" ? "성공 테스트" : testReadiness.status === "blocked" ? "재확인 필요" : testReadiness.status === "checking" ? "확인 중" : "확인 필요";

  return (
    <section className="panel focused-studio" aria-label="집중 자동화 스튜디오">
      <div className="focused-studio-bar">
        <div>
          <p className="eyebrow">집중 자동화 스튜디오</p>
          <h2>{scenario.name}</h2>
          <div className="inline-facts">
            <span className="badge blue">v{scenario.version}</span>
            <span className={`badge ${scenario.promotion_status === "prod" ? "green" : "muted"}`}>
              {scenario.promotion_status === "prod" ? "운영 기준" : "초안"}
            </span>
            {latestRun !== null && <StatusBadge status={latestRun.status} />}
          </div>
        </div>
        <span className="focused-studio-actions">
          <button className="btn primary" type="button" onClick={() => onTest(scenario.scenario_id)} disabled={!canCreateRun}>
            <PlaySquare size={14} aria-hidden="true" />
            테스트
          </button>
          <button className="btn" type="button" onClick={() => latestRun !== null && onEvidence(latestRun.run_id)} disabled={!hasEvidencePath}>
            <ClipboardCheck size={14} aria-hidden="true" />
            증빙
          </button>
          <button className="btn icon-btn" type="button" aria-label="집중 작업 닫기" onClick={onExit}>
            <X size={15} aria-hidden="true" />
          </button>
        </span>
      </div>

      <div className="focused-studio-tabs" role="tablist" aria-label="자동화 작업 탭">
        {FOCUS_TABS.map((tab) => {
          const Icon = tab.icon;
          return (
            <button
              key={tab.key}
              className={activeTab === tab.key ? "active" : ""}
              type="button"
              role="tab"
              aria-selected={activeTab === tab.key}
              onClick={() => setActiveTab(tab.key)}
            >
              <Icon size={14} aria-hidden="true" />
              {tab.label}
            </button>
          );
        })}
      </div>

      <div className="focused-studio-grid">
        <div className="focused-studio-main" role="tabpanel" aria-label={`${FOCUS_TABS.find((tab) => tab.key === activeTab)?.label ?? "작업"} 내용`}>
          {activeTab === "plan" && (
            <ol className="focus-step-list">
              <li>
                <span className="badge blue">초안 있음</span>
                <strong>현재 초안 v{scenario.version}</strong>
                <p className="subtle">아래에 업무 순서를 사람 말 단계로 보여줍니다. 원문 정의는 [정의 보기 (전문가)]에만 둡니다.</p>
                {/* E5′: 설계 탭이 실제 초안을 사람 말 카드로 보여준다 — 만들 때 본 문장과 동일(step-sentences 공유). */}
                <DesignStepCards scenarioId={scenario.scenario_id} />
              </li>
              <li>
                <span className={`badge ${testReadiness.tone}`}>{testBadgeLabel}</span>
                <strong>테스트 실행</strong>
                <p className="subtle">
                  {latestRun === null
                    ? "아직 연결된 최근 테스트 실행이 없습니다. 먼저 테스트를 돌려 결과를 남기세요."
                    : `최근 실행은 ${latestRunTime} 기준으로 ${runStatusLabel(latestRun.status)} 상태입니다.`}
                </p>
              </li>
              <li>
                <span className={`badge ${runCompleted ? "green" : "amber"}`}>{runCompleted ? "확인 가능" : "대기"}</span>
                <strong>증빙 확인</strong>
                <p className="subtle">
                  {runCompleted ? "완료된 실행의 산출물과 감사 증빙으로 이어질 수 있습니다." : "성공 실행이 생기면 증빙 확인이 첫 번째 후속 행동입니다."}
                </p>
              </li>
            </ol>
          )}
          {activeTab === "test" && (
            <div className="focused-studio-copy">
              <h3>테스트로 바로 확인</h3>
              <p className="subtle">아래 작업대에서 선택된 자동화를 테스트 모드로 실행하고, 완료되면 실행 기록의 증빙 영역으로 이어집니다.</p>
              <button className="btn primary" type="button" onClick={() => onTest(scenario.scenario_id)} disabled={!canCreateRun}>
                <PlaySquare size={14} aria-hidden="true" />
                테스트 작업대로 이동
              </button>
            </div>
          )}
          {activeTab === "links" && (
            <div className="focused-studio-copy">
              <h3>사이트·세션·보안 연결</h3>
              <p className="subtle">정확한 준비 상태는 위 준비 단계가 기준입니다. 알 수 없는 값은 준비됨으로 표시하지 않습니다.</p>
              <button className="btn" type="button" onClick={() => navigate("security", { section: "sites" })}>
                사이트·세션 확인
              </button>
            </div>
          )}
          {activeTab === "activity" && <FocusedActivityTab recentRuns={recentRuns} />}
          {activeTab === "versions" && (
            <div className="focused-studio-copy">
              <h3>버전과 배포</h3>
              <p className="subtle">버전 이력과 배포 판단은 기존 관리 패널을 그대로 사용합니다.</p>
              <span className="inline-actions">
                <button className="btn" type="button" onClick={() => onVersions(scenario)}>
                  버전 이력
                </button>
                <button className="btn" type="button" onClick={() => onReleases(scenario)}>
                  배포 상태
                </button>
              </span>
            </div>
          )}
          {activeTab === "settings" && (
            <div className="focused-studio-copy">
              <h3>자동화 설정</h3>
              <p className="subtle">이름과 정의 수정은 권한이 있을 때만 열립니다. 운영 기준 지정은 관리 작업에서 별도로 승인 흐름을 탑니다.</p>
              <button className="btn" type="button" onClick={() => onEdit(scenario)} disabled={!canUpdateScenario}>
                <Settings size={14} aria-hidden="true" />
                설정 편집
              </button>
            </div>
          )}
        </div>
        <aside className="focused-studio-rail" aria-label="최근 상태 요약">
          <div>
            <strong>최근 실행</strong>
            <p className="subtle">{latestRun === null ? "아직 연결된 최근 실행 없음" : latestRunTime}</p>
            {latestRun !== null && (
              <span className="inline-facts">
                <StatusBadge status={latestRun.status} />
                {latestRun.run_mode !== undefined && <RunModeBadge runMode={latestRun.run_mode} />}
              </span>
            )}
          </div>
          <div>
            <strong>다음 추천</strong>
            <p className="subtle">{runCompleted ? "증빙을 먼저 확인하고 운영 예약으로 이어가세요." : "테스트 실행으로 자동화가 실제로 동작하는지 확인하세요."}</p>
          </div>
        </aside>
      </div>
    </section>
  );
}

function FocusedActivityTab({ recentRuns }: { recentRuns: readonly RunItem[] }): JSX.Element {
  return (
    <div className="focused-studio-copy focused-activity">
      <h3>최근 활동</h3>
      <p className="subtle">상세 감사는 감사 이력이 기준입니다. 이 요약에는 실행 metadata만 표시합니다.</p>
      {recentRuns.length === 0 ? (
        <p className="form-alert amber" role="note">아직 이 자동화에 연결된 최근 실행이 없습니다. 감사 이벤트는 실행 후 확인해야 합니다.</p>
      ) : (
        <ol className="focus-timeline">
          {recentRuns.map((run) => (
            <li key={run.run_id}>
              <span className="focus-timeline-marker" aria-hidden="true" />
              <div>
                <strong>{formatDateTime(run.as_of ?? run.updated_at)}</strong>
                <p className="subtle">실행 상태 metadata · 감사 이벤트 확인 필요</p>
                <span className="inline-facts">
                  <StatusBadge status={run.status} />
                  {run.run_mode !== undefined && <RunModeBadge runMode={run.run_mode} />}
                </span>
              </div>
              <span className="inline-actions">
                <button className="btn" type="button" onClick={() => navigate("runTrace", { run: run.run_id, focus: "artifacts" })}>
                  실행 증빙
                </button>
                <button className="btn" type="button" onClick={() => navigate("auditExplorer")}>
                  감사 이력
                </button>
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

// E5′: 설계 탭 전용 초안 로더 — 상세(ir)는 필요할 때만 조회(쿼리키는 기존 scenario-detail 관례 공유).
// F2: 아래에 말로 고치기 섹션을 붙인다 — 최신 generation 1건으로 revise, 성공 시 변경 표시를 카드에 겹친다.
//     generation이 없거나 확인 불가면 사유를 항상 문장으로 표기한다(조용한 미노출 금지).
function DesignStepCards({ scenarioId }: { readonly scenarioId: string }): JSX.Element {
  const api = useApiClient();
  const detail = useQuery({
    queryKey: ["scenario-detail", scenarioId],
    queryFn: () => api.getScenario(scenarioId),
  });
  const generations = useQuery({
    queryKey: ["scenario-generations", "by-scenario", scenarioId],
    queryFn: () => api.listScenarioGenerations({ scenario_id: scenarioId, limit: 1 }),
  });
  // N1: revise 성공 diff 는 저장본끼리(v1 vs v2) 비교한다 — 스냅샷·새 저장본 도착 대기 로직은
  // GenerationResult(저장 완료 경로)와 공유한다(근거·타이밍 규칙은 use-saved-revise-diff 참조).
  const savedRevise = useSavedReviseDiff(detail.data);
  const { reset: resetSavedRevise } = savedRevise;
  useEffect(() => {
    resetSavedRevise();
  }, [scenarioId, resetSavedRevise]);

  if (detail.isLoading) return <p className="subtle">초안을 불러오는 중입니다.</p>;
  if (detail.isError) return <p className="subtle">초안을 불러오지 못했습니다 — 새로고침 후 다시 확인하세요.</p>;
  const latestGeneration = generations.data?.items[0] ?? null;
  return (
    <>
      <StepCards
        ir={detail.data?.ir}
        changeMarks={savedRevise.result?.diff.marks}
        removedCount={savedRevise.result?.diff.removedCount}
        fullReplacement={savedRevise.result?.diff.fullReplacement}
        emptyMessage="표시할 초안 단계가 없습니다."
      />
      {generations.isLoading && <p className="subtle">말로 고치기 가능 여부를 확인하는 중입니다.</p>}
      {generations.isError && (
        <p className="subtle" role="note">말로 고치기 상태를 확인하지 못했습니다 — 새로고침 후 다시 확인해 주세요.</p>
      )}
      {generations.isSuccess && latestGeneration === null && (
        <p className="subtle" role="note">
          이 자동화에는 말로 만든 요청 기록이 없어 말로 고치기를 쓸 수 없습니다.{" "}
          <button className="linklike" type="button" onClick={() => navigate("create")}>
            만들기 홈에서 새 요청으로 만들기
          </button>
        </p>
      )}
      {latestGeneration !== null && (
        <ReviseControl
          generationId={latestGeneration.generation_id}
          scenarioId={scenarioId}
          onRevised={() => savedRevise.begin(scenarioId, detail.data)}
        />
      )}
    </>
  );
}
