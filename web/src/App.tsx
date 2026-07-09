import { lazy, Suspense } from "react";

import { ErrorBoundary } from "./components/ErrorBoundary";
import { Layout } from "./components/Layout";
import { TokenGate } from "./components/TokenGate";
import { useHashRoute, type ViewKey } from "./router";
import { PlaceholderView } from "./views/Placeholder";

const DashboardView = lazy(() => import("./views/Dashboard").then((module) => ({ default: module.DashboardView })));
const CoePipelineView = lazy(() => import("./views/CoePipeline").then((module) => ({ default: module.CoePipelineView })));
const CreateView = lazy(() => import("./views/Create").then((module) => ({ default: module.CreateView })));
const ConnectorCatalogView = lazy(() => import("./views/ConnectorCatalog").then((module) => ({ default: module.ConnectorCatalogView })));
const SiteElementsView = lazy(() => import("./views/SiteElements").then((module) => ({ default: module.SiteElementsView })));
const OrchestrationView = lazy(() => import("./views/Orchestration").then((module) => ({ default: module.OrchestrationView })));
const DocumentIdpView = lazy(() => import("./views/DocumentIdp").then((module) => ({ default: module.DocumentIdpView })));
const RunTraceView = lazy(() => import("./views/RunTrace").then((module) => ({ default: module.RunTraceView })));
const WorkitemsView = lazy(() => import("./views/Workitems").then((module) => ({ default: module.WorkitemsView })));
const HumanTasksView = lazy(() => import("./views/HumanTasks").then((module) => ({ default: module.HumanTasksView })));
const AdoptionEvidenceView = lazy(() => import("./views/AdoptionEvidence").then((module) => ({ default: module.AdoptionEvidenceView })));
const AuditExplorerView = lazy(() => import("./views/AuditExplorer").then((module) => ({ default: module.AuditExplorerView })));
const SecurityView = lazy(() => import("./views/Security").then((module) => ({ default: module.SecurityView })));
const GatewayView = lazy(() => import("./views/Gateway").then((module) => ({ default: module.GatewayView })));
const ScenariosView = lazy(() => import("./views/Scenarios").then((module) => ({ default: module.ScenariosView })));
const OpenGateView = lazy(() => import("./views/OpenGate").then((module) => ({ default: module.OpenGateView })));

// 라우트 → 뷰. read 백엔드가 있는 뷰는 실 연결, 그 외는 정직한 placeholder(D7.2+ 워크플로우 대상).
function renderView(view: ViewKey): JSX.Element {
  switch (view) {
    case "create":
      return <CreateView />;
    case "coePipeline":
      return <CoePipelineView />;
    case "connectorCatalog":
      return <ConnectorCatalogView />;
    case "objectRepository":
      return <SiteElementsView />;
    case "dashboard":
      return <DashboardView />;
    case "adoptionEvidence":
      return <AdoptionEvidenceView />;
    case "automationOps":
      return <OrchestrationView />;
    case "documentIdp":
      return <DocumentIdpView />;
    case "runTrace":
      return <RunTraceView />;
    case "workitems":
      return <WorkitemsView />;
    case "humanTasks":
      return <HumanTasksView />;
    case "auditExplorer":
      return <AuditExplorerView />;
    case "security":
      return <SecurityView />;
    case "llmGateway":
      return <GatewayView />;
    case "scenarioStudio":
      return <ScenariosView />;
    case "openGate":
      return <OpenGateView />;
    default:
      return <PlaceholderView title="알 수 없는 화면" note="대시보드로 이동하세요." />;
  }
}

export function App(): JSX.Element {
  const view = useHashRoute();
  return (
    <TokenGate>
      <Layout view={view}>
        {/* view 단위 key: 한 화면의 렌더 예외가 셸(내비/탑바)을 백지로 만들지 않고, 화면 이동 시 초기화 */}
        <ErrorBoundary key={view}>
          <Suspense fallback={<PlaceholderView title="화면 불러오는 중" note="잠시만 기다려 주세요." />}>
            {renderView(view)}
          </Suspense>
        </ErrorBoundary>
      </Layout>
    </TokenGate>
  );
}
