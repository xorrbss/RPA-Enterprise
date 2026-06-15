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
    getRun: async (id) => ({ run_id: id, status: "running", worker_id: null, attempts: 1, as_of: null }),
    getWorkitem: async (id) => ({ workitem_id: id, status: "new", unique_reference: "wi", target_id: null }),
    getHumanTask: async (id) => ({ human_task_id: id, state: "open", kind: "approval", assignee: null, timeout: null, run_id: null }),
    getScenario: async (id) => ({ scenario_id: id, name: "s", version: 1, promotion_status: "draft" }),
    getSite: async (id) => ({ site_profile_id: id, risk: "green", approval_status: "pending", circuit_status: "closed" }),
    validateScenario: async () => ({ valid: true, report: { errors: [], warnings: [] } }),
    createScenario: async () => ({ scenario_id: "00000000-0000-0000-0000-0000000000c1", version: 1, promotion_status: "draft" }),
    updateScenario: async (_id, _ir, version) => ({ scenario_id: "00000000-0000-0000-0000-0000000000c1", version: version + 1, promotion_status: "draft" }),
    createRun: async () => ({ run_id: "00000000-0000-0000-0000-000000000099", status: "queued" }),
    ...overrides,
  };
}
