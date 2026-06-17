import { ErrorBoundary } from "./components/ErrorBoundary";
import { Layout } from "./components/Layout";
import { TokenGate } from "./components/TokenGate";
import { useHashRoute, type ViewKey } from "./router";
import { DashboardView } from "./views/Dashboard";
import { RunTraceView } from "./views/RunTrace";
import { WorkitemsView } from "./views/Workitems";
import { HumanTasksView } from "./views/HumanTasks";
import { SecurityView } from "./views/Security";
import { GatewayView } from "./views/Gateway";
import { ScenariosView } from "./views/Scenarios";
import { IrValidationView } from "./views/IrValidation";
import { PlaygroundView } from "./views/Playground";
import { OpenGateView } from "./views/OpenGate";
import { IdempotencyView } from "./views/Idempotency";
import { PlaceholderView } from "./views/Placeholder";

// 라우트 → 뷰. read 백엔드가 있는 뷰는 실 연결, 그 외는 정직한 placeholder(D7.2+ 워크플로우 대상).
function renderView(view: ViewKey): JSX.Element {
  switch (view) {
    case "dashboard":
      return <DashboardView />;
    case "runTrace":
      return <RunTraceView />;
    case "workitems":
      return <WorkitemsView />;
    case "humanTasks":
      return <HumanTasksView />;
    case "security":
      return <SecurityView />;
    case "llmGateway":
      return <GatewayView />;
    case "scenarioStudio":
      return <ScenariosView />;
    case "playground":
      return <PlaygroundView />;
    case "openGate":
      return <OpenGateView />;
    case "irValidation":
      return <IrValidationView />;
    case "idempotency":
      return <IdempotencyView />;
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
        <ErrorBoundary key={view}>{renderView(view)}</ErrorBoundary>
      </Layout>
    </TokenGate>
  );
}
