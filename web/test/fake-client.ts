import type { ApiClient } from "../src/api/client";

// 테스트용 fake ApiClient(백엔드 무의존). 뷰는 동일 포트로 주입되므로 fixture만 갈아끼운다.
export function fakeClient(overrides: Partial<ApiClient> = {}): ApiClient {
  const empty = async () => ({ items: [], next_cursor: null });
  return {
    listRuns: async () => ({
      items: [{ run_id: "11111111-aaaa-bbbb-cccc-000000000001", status: "running", current_node: "observe_reviews", as_of: "2026-06-15T00:00:00.000Z" }],
      next_cursor: null,
    }),
    listRunSteps: async () => ({
      items: [
        { step_id: "s1", node_id: "open", attempt: 0, action: "navigate", status: "success", cache_mode: "bypass", artifact_ids: [], stagehand_calls: [], started_at: null, ended_at: null, duration_ms: 820, exception: null },
        { step_id: "s2", node_id: "extract", attempt: 0, action: "extract", status: "success", cache_mode: "hit", artifact_ids: ["72000000-0000-0000-0000-000000000001"], stagehand_calls: [{ model: "gpt-4o-mini", transport: "sse", stream_status: "done", ttfb_ms: 120, input_tokens: 500, output_tokens: 200, cost: "0.001234" }], started_at: null, ended_at: null, duration_ms: 1200, exception: null },
      ],
      next_cursor: null,
    }),
    listRunArtifacts: async () => ({
      items: [
        { artifact_id: "72000000-0000-0000-0000-000000000001", type: "screenshot", redaction_status: "redacted", retention_until: "2026-09-01T00:00:00.000Z", legal_hold: false, created_at: "2026-06-15T00:00:02.000Z" },
      ],
      next_cursor: null,
    }),
    listWorkitems: empty,
    listHumanTasks: empty,
    listDlq: empty,
    listScenarios: empty,
    listSites: empty,
    getGatewayPolicy: async () => ({ model: "gpt-4o-mini", version: 1, capabilities: { jsonMode: true }, budget: { maxInputTokens: 1000 } }),
    updateGatewayPolicy: async (version) => ({ model: "gpt-4o-mini", version: version + 1 }),
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
    getArtifact: async (id) => ({ artifact_id: id, type: "screenshot", sha256: "abc123", redaction_status: "redacted", retention_until: null, content: "redacted artifact content" }),
    approveSite: async () => ({ site_profile_id: "s", approval_status: "approved" }),
    createSite: async () => ({ site_profile_id: "s", name: "n", url_pattern: "https://x.example", risk: "green", approved: false }),
    updateSite: async (siteId: string, name: string) => ({ site_profile_id: siteId, name }),
    captureSession: async (_siteId: string, _key: string) => ({ capture_session_id: "c", site_profile_id: "s", status: "launching" }),
    validateScenario: async () => ({ valid: true, report: { errors: [], warnings: [] } }),
    createScenario: async () => ({ scenario_id: "00000000-0000-0000-0000-0000000000c1", version: 1, promotion_status: "draft" }),
    updateScenario: async (_id, _ir, version) => ({ scenario_id: "00000000-0000-0000-0000-0000000000c1", version: version + 1, promotion_status: "draft" }),
    createRun: async () => ({ run_id: "00000000-0000-0000-0000-000000000099", status: "queued" }),
    ...overrides,
  };
}
