import type { ApiClient } from "../src/api/client";

// 테스트용 fake ApiClient(백엔드 무의존). 뷰는 동일 포트로 주입되므로 fixture만 갈아끼운다.
export function fakeClient(overrides: Partial<ApiClient> = {}): ApiClient {
  const empty = async () => ({ items: [], next_cursor: null });
  return {
    listRuns: async () => ({
      items: [{ run_id: "11111111-aaaa-bbbb-cccc-000000000001", status: "running", current_node: "observe_reviews", as_of: "2026-06-15T00:00:00.000Z" }],
      next_cursor: null,
    }),
    listWorkitems: empty,
    listHumanTasks: empty,
    listDlq: empty,
    listScenarios: empty,
    listSites: empty,
    getGatewayPolicy: async () => ({ model: "gpt-4o-mini", capabilities: { jsonMode: true } }),
    abortRun: async () => ({ status: "cancelled" }),
    replayDeadLetter: async () => ({ status: "new" }),
    assignHumanTask: async () => ({ status: "assigned" }),
    startHumanTask: async () => ({ status: "in_progress" }),
    resolveHumanTask: async () => ({ status: "resolved" }),
    escalateHumanTask: async () => ({ status: "escalated" }),
    promoteScenario: async () => ({ version: 2, promotion_status: "prod" }),
    ...overrides,
  };
}
