import { navigate } from "../../router";
import type { RunItem, ScenarioItem, SiteItem } from "../../api/types";
import {
  READINESS_LABELS,
  assessLoginSessionReadiness,
  assessSiteCollectionReadiness,
  assessTestRunReadiness,
  readinessTone,
  type ReadinessTone,
} from "../../components/readiness";

type CorridorQueryState = "checking" | "error" | "ready";
type CorridorStatus = "ready" | "needs" | "blocked" | "checking";

interface CorridorAction {
  readonly label: string;
  readonly run: () => void;
  readonly primary?: boolean;
}

interface CorridorStep {
  readonly key: string;
  readonly label: string;
  readonly status: CorridorStatus;
  readonly detail: string;
  readonly action?: CorridorAction;
}

export function queryState(query: { readonly isLoading: boolean; readonly isError: boolean; readonly data?: unknown }): CorridorQueryState {
  if (query.isError) return "error";
  if (query.isLoading || query.data === undefined) return "checking";
  return "ready";
}

function corridorStatusLabel(status: CorridorStatus): string {
  return READINESS_LABELS[status];
}

function corridorTone(status: CorridorStatus): ReadinessTone {
  return readinessTone(status);
}

function siteStep(
  state: CorridorQueryState,
  sites: readonly SiteItem[],
  canCreateSite: boolean,
  canUpdateSite: boolean,
): CorridorStep {
  if (state === "checking") {
    return { key: "site", label: "사이트", status: "checking", detail: "등록된 실행 대상 사이트를 확인하고 있습니다." };
  }
  if (state === "error") {
    return {
      key: "site",
      label: "사이트",
      status: "needs",
      detail: "사이트 목록을 불러오지 못했습니다. 설정 화면에서 상태를 다시 확인하세요.",
      action: canCreateSite || canUpdateSite ? { label: "사이트 설정 확인", run: () => navigate("security", { section: "sites" }) } : undefined,
    };
  }
  const decision = assessSiteCollectionReadiness(sites);
  if (decision.status === "ready") {
    return { key: "site", label: "사이트", status: "ready", detail: decision.detail };
  }
  if (decision.status === "blocked") {
    return {
      key: "site",
      label: "사이트",
      status: "blocked",
      detail: decision.detail,
      action: canUpdateSite ? { label: "사이트 승인 상태 보기", run: () => navigate("security", { section: "sites" }) } : undefined,
    };
  }
  return {
    key: "site",
    label: "사이트",
    status: "needs",
    detail: decision.detail,
    action: canCreateSite ? { label: "사이트 등록", run: () => navigate("security", { section: "sites", intent: "site-create" }), primary: true } : undefined,
  };
}

function sessionStep(
  state: CorridorQueryState,
  sites: readonly SiteItem[],
  firstMissingSession: SiteItem | null,
  canCaptureSession: boolean,
): CorridorStep {
  if (state === "checking") {
    return { key: "session", label: "로그인 세션", status: "checking", detail: "로그인이 필요한 사이트의 세션 상태를 확인하고 있습니다." };
  }
  if (state === "error") {
    return {
      key: "session",
      label: "로그인 세션",
      status: "needs",
      detail: "세션 준비도를 확인하지 못했습니다. 알 수 없는 상태는 준비 완료로 보지 않습니다.",
      action: canCaptureSession ? { label: "세션 설정 확인", run: () => navigate("security", { section: "sites" }) } : undefined,
    };
  }
  const decision = assessLoginSessionReadiness(sites);
  if (decision.status === "deferred") {
    return { key: "session", label: "로그인 세션", status: "needs", detail: decision.detail };
  }
  if (decision.status === "ready") {
    return { key: "session", label: "로그인 세션", status: "ready", detail: decision.detail };
  }
  return {
    key: "session",
    label: "로그인 세션",
    status: "needs",
    detail: decision.detail,
    action:
      canCaptureSession && (decision.siteId !== undefined || firstMissingSession !== null)
        ? { label: "세션 등록", run: () => navigate("security", { section: "sites", site: decision.siteId ?? firstMissingSession!.site_profile_id }), primary: true }
        : undefined,
  };
}

function draftStep(
  state: CorridorQueryState,
  scenarios: readonly ScenarioItem[],
  canCreateScenario: boolean,
  onCreateDraft: () => void,
): CorridorStep {
  if (state === "checking") {
    return { key: "draft", label: "자동화 초안", status: "checking", detail: "저장된 자동화 초안을 확인하고 있습니다." };
  }
  if (state === "error") {
    return {
      key: "draft",
      label: "자동화 초안",
      status: "needs",
      detail: "초안 목록을 불러오지 못했습니다. 다시 확인하거나 새 초안을 만들 수 있습니다.",
      action: canCreateScenario ? { label: "초안 만들기", run: onCreateDraft } : undefined,
    };
  }
  if (scenarios.length > 0) {
    return { key: "draft", label: "자동화 초안", status: "ready", detail: `${scenarios.length}개 초안 또는 자동화가 있습니다.` };
  }
  return {
    key: "draft",
    label: "자동화 초안",
    status: "needs",
    detail: "말로 업무를 설명해 첫 초안을 만들 수 있습니다.",
    action: canCreateScenario ? { label: "초안 만들기", run: onCreateDraft, primary: true } : undefined,
  };
}

function testStep(
  state: CorridorQueryState,
  runs: readonly RunItem[],
  latestScenario: ScenarioItem | undefined,
  canCreateRun: boolean,
  onOpenTest: (scenarioId?: string) => void,
): CorridorStep {
  if (state === "checking") {
    return { key: "test", label: "테스트 실행", status: "checking", detail: "최근 테스트 실행 이력을 확인하고 있습니다." };
  }
  if (state === "error") {
    return {
      key: "test",
      label: "테스트 실행",
      status: "needs",
      detail: "실행 이력을 불러오지 못했습니다. 테스트 화면에서 직접 확인하세요.",
      action: canCreateRun ? { label: "테스트 화면", run: () => onOpenTest() } : undefined,
    };
  }
  const decision = assessTestRunReadiness(runs);
  if (decision.status === "ready") {
    return { key: "test", label: "테스트 실행", status: "ready", detail: decision.detail };
  }
  if (decision.status === "blocked" || decision.status === "checking") {
    return {
      key: "test",
      label: "테스트 실행",
      status: decision.status,
      detail: decision.detail,
      action:
        canCreateRun && latestScenario !== undefined
          ? { label: "계획 확인으로 이동", run: () => onOpenTest(latestScenario.scenario_id), primary: decision.status === "blocked" }
          : undefined,
    };
  }
  return {
    key: "test",
    label: "테스트 실행",
    status: "needs",
    detail: latestScenario === undefined ? "초안을 만든 뒤 계획 확인과 테스트 실행으로 이어갑니다." : "저장된 초안으로 계획을 확인하고 테스트하세요.",
    action:
      canCreateRun && latestScenario !== undefined
        ? { label: "계획 확인으로 이동", run: () => onOpenTest(latestScenario.scenario_id), primary: true }
        : undefined,
  };
}

function evidenceStep(state: CorridorQueryState, completedRun: RunItem | null, canReadEvidence: boolean): CorridorStep {
  if (state === "checking") {
    return { key: "evidence", label: "증빙", status: "checking", detail: "완료된 실행과 증빙 확인 경로를 찾고 있습니다." };
  }
  if (state === "error") {
    return {
      key: "evidence",
      label: "증빙",
      status: "needs",
      detail: "증빙 상태를 확인하지 못했습니다. 실행 상세에서 다시 확인하세요.",
      action: canReadEvidence ? { label: "증빙 화면", run: () => navigate("runTrace", { focus: "artifacts" }) } : undefined,
    };
  }
  if (completedRun !== null) {
    return {
      key: "evidence",
      label: "증빙",
      status: "needs",
      detail: "완료된 실행이 있습니다. 증빙 목록은 실행 상세에서 확인해야 합니다.",
      action: canReadEvidence ? { label: "증빙 확인", run: () => navigate("runTrace", { run: completedRun.run_id, focus: "artifacts" }), primary: true } : undefined,
    };
  }
  return { key: "evidence", label: "증빙", status: "needs", detail: "테스트를 완료한 뒤 실행 산출물과 감사 증빙을 확인합니다." };
}

export function ScenarioSetupCorridor({
  sites,
  siteState,
  scenarios,
  scenarioState,
  recentRuns,
  runState,
  latestScenario,
  latestCompletedRun,
  firstLoginSiteNeedingSession,
  canCreateSite,
  canUpdateSite,
  canCaptureSession,
  canCreateScenario,
  canCreateRun,
  canReadEvidence,
  onCreateDraft,
  onOpenTest = (scenarioId?: string) => navigate("scenarioStudio", scenarioId === undefined ? { focus: "test" } : { scenario: scenarioId, focus: "test" }),
}: {
  sites: readonly SiteItem[];
  siteState: CorridorQueryState;
  scenarios: readonly ScenarioItem[];
  scenarioState: CorridorQueryState;
  recentRuns: readonly RunItem[];
  runState: CorridorQueryState;
  latestScenario: ScenarioItem | undefined;
  latestCompletedRun: RunItem | null;
  firstLoginSiteNeedingSession: SiteItem | null;
  canCreateSite: boolean;
  canUpdateSite: boolean;
  canCaptureSession: boolean;
  canCreateScenario: boolean;
  canCreateRun: boolean;
  canReadEvidence: boolean;
  onCreateDraft: () => void;
  onOpenTest?: (scenarioId?: string) => void;
}): JSX.Element {
  const steps = [
    siteStep(siteState, sites, canCreateSite, canUpdateSite),
    sessionStep(siteState, sites, firstLoginSiteNeedingSession, canCaptureSession),
    draftStep(scenarioState, scenarios, canCreateScenario, onCreateDraft),
    testStep(runState, recentRuns, latestScenario, canCreateRun, onOpenTest),
    evidenceStep(runState, latestCompletedRun, canReadEvidence),
  ];
  const firstAction = steps.find((step) => step.status !== "ready" && step.action !== undefined)?.action;
  return (
    <section className="panel setup-corridor" aria-label="자동화 준비 단계">
      <div className="panel-head">
        <div>
          <h2>자동화 준비 단계</h2>
          <p className="subtle">사이트, 세션, 초안, 테스트, 증빙을 현재 확인된 데이터 기준으로 보여줍니다.</p>
        </div>
        {firstAction !== undefined && (
          <button className="btn primary" type="button" onClick={firstAction.run}>
            다음: {firstAction.label}
          </button>
        )}
      </div>
      <ol className="setup-corridor-steps">
        {steps.map((step) => (
          <li key={step.key} className={`setup-corridor-step ${step.status}`}>
            <span className={`badge ${corridorTone(step.status)}`}>{corridorStatusLabel(step.status)}</span>
            <span className="setup-corridor-copy">
              <strong>{step.label}</strong>
              <span className="subtle">{step.detail}</span>
            </span>
            {step.action !== undefined && (
              <button className={step.action.primary === true ? "btn primary" : "btn"} type="button" onClick={step.action.run}>
                {step.action.label}
              </button>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
