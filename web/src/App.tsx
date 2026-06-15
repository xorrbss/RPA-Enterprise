import { Layout } from "./components/Layout";
import { useHashRoute, type ViewKey } from "./router";
import { DashboardView } from "./views/Dashboard";
import { RunTraceView } from "./views/RunTrace";
import { WorkitemsView } from "./views/Workitems";
import { HumanTasksView } from "./views/HumanTasks";
import { SecurityView } from "./views/Security";
import { GatewayView } from "./views/Gateway";
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
      return <PlaceholderView title="자동화 만들기" note="시나리오 편집/저장은 D7.2(저장→정적검증→승격 워크플로우)에서 연결됩니다." />;
    case "playground":
      return <PlaceholderView title="테스트 실행" note="dry-run 시험 실행은 D7.2에서 연결됩니다." />;
    case "openGate":
      return <PlaceholderView title="Product-open 점검" note="release-open-checklist 기반 점검 화면은 후속 슬라이스에서 연결됩니다." />;
    case "irValidation":
      return <PlaceholderView title="시나리오 검사" note="V1–V11 정적검증 결과는 scenario validate/promote 연결(D7.2)에서 표시됩니다." />;
    case "idempotency":
      return <PlaceholderView title="중복 방지" note="control_plane_idempotency_keys read 표면이 노출되면 연결됩니다." />;
    default:
      return <PlaceholderView title="알 수 없는 화면" note="대시보드로 이동하세요." />;
  }
}

export function App(): JSX.Element {
  const view = useHashRoute();
  return <Layout view={view}>{renderView(view)}</Layout>;
}
