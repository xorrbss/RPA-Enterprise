import { beforeEach, describe, expect, test } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { App } from "../src/App";
import { ApiClientProvider } from "../src/api/context";
import type { ApiClient } from "../src/api/client";
import type { GatewayPolicyUpdate, HumanTaskItem, RunItem } from "../src/api/types";
import { COLLECT_SCENARIO_NAME, APPROVAL_ARTIFACT_TYPE } from "../src/api/approval-inbox";
import { fakeClient } from "./fake-client";

function renderApp(client: ApiClient = fakeClient()): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ApiClientProvider client={client}>
        <App />
      </ApiClientProvider>
    </QueryClientProvider>,
  );
}

function jwt(roles: readonly string[], sub = "u"): string {
  const payload = btoa(JSON.stringify({ sub, tenant_id: "t", roles })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `e30.${payload}.sig`;
}

function run(id: string, status: string, code?: string): RunItem {
  return {
    run_id: id,
    status,
    current_node: null,
    as_of: "2026-06-18T00:00:00.000Z",
    failure_reason: code !== undefined ? { code, message: code } : null,
  };
}

function inboxClient(rows: readonly Record<string, unknown>[]): ApiClient {
  return fakeClient({
    listScenarios: async () => ({
      items: [{ scenario_id: "sc-collect", name: COLLECT_SCENARIO_NAME, version: 1, latest_version_id: "ver-collect" }],
      next_cursor: null,
    }),
    listRuns: async (p) =>
      p?.scenario_version_id === "ver-collect"
        ? { items: [{ run_id: "run-collect", status: "completed", current_node: null, as_of: "2026-06-18T09:00:00.000Z" }], next_cursor: null }
        : { items: [], next_cursor: null },
    listRunArtifacts: async () => ({
      items: [{ artifact_id: "art-inbox", type: APPROVAL_ARTIFACT_TYPE, redaction_status: "redacted", retention_until: null, legal_hold: false, created_at: "2026-06-18T09:00:01.000Z" }],
      next_cursor: null,
    }),
    getArtifact: async (id) => ({ artifact_id: id, type: APPROVAL_ARTIFACT_TYPE, sha256: "x", redaction_status: "redacted", retention_until: null, content: JSON.stringify({ rows }) }),
  });
}

describe("goal UX improvements", () => {
  beforeEach(() => {
    location.hash = "";
    localStorage.setItem("rpa.token", jwt(["operator", "approver", "admin"]));
  });

  test("dashboard shows a role workbench and actionable Top 5 queue", async () => {
    renderApp(
      fakeClient({
        listRuns: async (p) => {
          if (p?.status === "failed_system") return { items: [run("fs-00000001", "failed_system", "SYS_DOWN")], next_cursor: null };
          if (p?.status === "failed_business") return { items: [run("fb-00000001", "failed_business", "BIZ_RULE")], next_cursor: null };
          if (p?.status === "running") return { items: [run("rn-00000001", "running")], next_cursor: null };
          return { items: [run("rn-00000001", "running")], next_cursor: null };
        },
        listHumanTasks: async () => ({
          items: [{ human_task_id: "ht-00000001", state: "open", kind: "approval", assignee: null, timeout: "2026-06-18T10:00:00.000Z", on_timeout: "escalate", run_id: null }],
          next_cursor: null,
        }),
        listDlq: async (kind) => ({
          items: [{ dead_letter_id: `${kind}-dlq-1`, kind, status: "DEAD_LETTER", source_id: "wi-source-1" }],
          next_cursor: null,
        }),
        listSites: async () => ({
          items: [{ site_profile_id: "site-red-1", name: "민감 포털", risk: "red", approval_status: "pending", circuit_status: "closed" }],
          next_cursor: null,
        }),
      }),
    );

    expect(await screen.findByRole("region", { name: "역할별 작업대" })).toHaveTextContent("관리자 작업대");
    const queue = await screen.findByRole("region", { name: "지금 처리해야 할 Top 5" });
    expect(queue).toHaveTextContent("시스템 실패 실행");
    expect(queue).toHaveTextContent("SYS_DOWN");

    within(queue).getByRole("button", { name: /Top 1 처리 항목 SYS_DOWN/ }).click();
    await waitFor(() => expect(location.hash).toContain("status=failed_system"));
    expect(location.hash).toContain("run=fs-00000001");
  });

  test("easy automation templates collect URL, rules, and success criteria into the generated IR", async () => {
    let captured: unknown = null;
    renderApp(
      fakeClient({
        listScenarios: async () => ({ items: [], next_cursor: null }),
        createScenario: async (ir) => {
          captured = ir;
          return { scenario_id: "sc-new", version: 1, promotion_status: "draft" };
        },
      }),
    );
    location.hash = "#scenarioStudio";

    fireEvent.click(await screen.findByRole("button", { name: "+ 새 자동화 만들기" }));
    fireEvent.change(await screen.findByLabelText("업무 템플릿"), { target: { value: "attachment_download" } });
    fireEvent.change(screen.getByLabelText("② 자동화할 페이지 주소 (전체 주소를 붙여넣으세요)"), { target: { value: "https://office.example/docs" } });
    fireEvent.change(screen.getByLabelText(/⑤ 성공 기준/), { target: { value: "첨부가 없으면 데이터 없음으로 종료한다." } });
    fireEvent.click(screen.getByRole("button", { name: "저장" }));

    await waitFor(() => expect(captured).not.toBeNull());
    const serialized = JSON.stringify(captured);
    expect(serialized).toContain("첨부 확인 자동화");
    expect(serialized).toContain("https://office.example/docs");
    expect(serialized).toContain("성공 기준: 첨부가 없으면 데이터 없음으로 종료한다.");
  });

  test("run panel shows pre-run readiness checks and fix paths", async () => {
    renderApp(
      fakeClient({
        listScenarios: async () => ({
          items: [{ scenario_id: "sc-run", name: "주문 수집", version: 1, latest_version_id: "ver-run", promotion_status: "draft" }],
          next_cursor: null,
        }),
        getScenario: async () => ({
          scenario_id: "sc-run",
          name: "주문 수집",
          version: 1,
          promotion_status: "draft",
          ir: { start: "open", nodes: { open: { what: [{ action: "navigate", url_ref: "orders_url" }], next: "done" }, done: { terminal: "success" } } },
        }),
        listGatewayPolicies: async () => ({
          items: [
            { model: "gpt-4o", version: 1, capabilities: {}, budget: {}, is_default: false },
            { model: "gpt-4o-mini", version: 1, capabilities: {}, budget: {}, is_default: false },
          ],
          next_cursor: null,
        }),
        validateScenario: async () => ({ valid: false, report: { errors: [{ rule: "V3", message: "missing target" }], warnings: [] } }),
      }),
    );
    location.hash = "#scenarioStudio";

    fireEvent.click(await screen.findByRole("button", { name: "실행" }));
    const readiness = await screen.findByRole("region", { name: "실행 전 준비 점검" });
    expect(readiness).toHaveTextContent("실행값");
    expect(readiness).toHaveTextContent("정적 검증");
    expect(readiness).toHaveTextContent("모델 정책");
    expect(readiness).toHaveTextContent("사이트/세션");
    expect(screen.getByRole("button", { name: "실행 시작" })).toBeDisabled();

    within(readiness).getByRole("button", { name: "정책 보기" }).click();
    await waitFor(() => expect(location.hash).toBe("#llmGateway"));
  });

  test("details open as slide-over panels while preserving hash deep links", async () => {
    renderApp(
      fakeClient({
        listRuns: async () => ({ items: [run("run-slide-1", "running")], next_cursor: null }),
        getRun: async (id) => ({ run_id: id, status: "running", worker_id: "worker-1", attempts: 1, as_of: null }),
      }),
    );
    location.hash = "#runTrace";

    fireEvent.click(await screen.findByRole("button", { name: "상세" }));
    const detail = await screen.findByRole("region", { name: "실행 상세" });
    expect(detail).toHaveClass("slide-over");
    expect(location.hash).toContain("run=run-slide-1");
  });

  test("human task queue supports due filtering, next task, and permitted bulk assignment", async () => {
    const tasks: HumanTaskItem[] = [
      { human_task_id: "ht-due", state: "open", kind: "captcha", assignee: null, timeout: "2026-06-18T10:00:00.000Z", on_timeout: "escalate", run_id: null },
      { human_task_id: "ht-later", state: "open", kind: "approval", assignee: null, timeout: null, on_timeout: null, run_id: null },
    ];
    const assigned: Array<{ id: string; assignee: string; key: string }> = [];
    renderApp(
      fakeClient({
        listHumanTasks: async () => ({ items: tasks, next_cursor: null }),
        getHumanTask: async (id) => tasks.find((task) => task.human_task_id === id) ?? tasks[0]!,
        assignHumanTask: async (id, assignee, key) => {
          assigned.push({ id, assignee, key });
          return { status: "assigned" };
        },
      }),
    );
    location.hash = "#humanTasks";

    expect(await screen.findByText("보안문자")).toBeInTheDocument();
    const controls = await screen.findByRole("region", { name: "사람 확인 큐 제어" });
    fireEvent.click(within(controls).getByRole("button", { name: "다음 건 처리" }));
    await waitFor(() => expect(location.hash).toContain("ht=ht-due"));
    fireEvent.click(within(await screen.findByRole("region", { name: "사람확인 상세" })).getByRole("button", { name: "닫기" }));

    fireEvent.click(within(controls).getByRole("button", { name: "마감 임박 1" }));
    await waitFor(() => expect(screen.getByText("보안문자")).toBeInTheDocument());
    expect(screen.queryByText("승인")).toBeNull();

    fireEvent.click(within(controls).getByRole("button", { name: "현재 페이지 2건 배정" }));
    fireEvent.change(await screen.findByLabelText("담당자 ID(uuid)"), { target: { value: "u-assign" } });
    fireEvent.click(screen.getByRole("button", { name: "확인" }));
    await waitFor(() => expect(assigned).toHaveLength(2));
    expect(assigned.map((c) => c.id).sort()).toEqual(["ht-due", "ht-later"]);
    expect(assigned.every((c) => c.assignee === "u-assign" && c.key.includes(c.id))).toBe(true);
  });

  test("approval inbox can focus pending rows without adding unsafe bulk decisions", async () => {
    renderApp(
      inboxClient([
        { doc_ref: "https://approval.example/1", title: "대기 결재", status: "pending", doc_type: "지출", drafter: "김기안" },
        { doc_ref: "https://approval.example/2", title: "완료 결재", status: "approved", doc_type: "구매", drafter: "박기안" },
      ]),
    );
    location.hash = "#approvalInbox";

    expect(await screen.findByText("대기 결재")).toBeInTheDocument();
    expect(screen.getByText("완료 결재")).toBeInTheDocument();
    const controls = await screen.findByRole("region", { name: "결재 큐 제어" });
    fireEvent.click(within(controls).getByRole("button", { name: "처리 대기만 1" }));
    await waitFor(() => expect(screen.queryByText("완료 결재")).toBeNull());
    expect(screen.queryByRole("button", { name: /일괄/ })).toBeNull();
  });

  test("validation issues show prescriptive fixes and a scenario-edit CTA", async () => {
    renderApp(
      fakeClient({
        validateScenario: async () => ({
          valid: false,
          report: { errors: [{ rule: "V3", message: "target node missing", node_id: "check" }], warnings: [] },
        }),
      }),
    );
    location.hash = "#irValidation";

    fireEvent.change(await screen.findByPlaceholderText(/00000000/), { target: { value: "sc-prescription" } });
    fireEvent.click(screen.getByRole("button", { name: "검증 실행" }));
    expect(await screen.findByText(/조건 분기 대상과 다음 단계 ID/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /자동화 편집으로 이동/ }));
    await waitFor(() => expect(location.hash).toBe("#scenarioStudio"));
  });

  test("gateway policy defaults to structured fields and keeps JSON in the advanced section", async () => {
    const calls: Array<GatewayPolicyUpdate> = [];
    renderApp(
      fakeClient({
        listGatewayPolicies: async () => ({ items: [], next_cursor: null }),
        createGatewayPolicy: async (body) => {
          calls.push(body);
          return { model: body.model, version: 1, capabilities: body.capabilities, budget: body.budget, fallback: body.fallback_config ?? null };
        },
      }),
    );
    location.hash = "#llmGateway";

    fireEvent.change(await screen.findByLabelText("모델명"), { target: { value: "gpt-4.1-mini" } });
    expect(screen.queryByLabelText("capabilities (JSON)")).toBeNull();
    fireEvent.change(screen.getByLabelText("컨텍스트 한도"), { target: { value: "16000" } });
    fireEvent.change(screen.getByLabelText("입력 토큰 한도"), { target: { value: "2000" } });
    fireEvent.change(screen.getByLabelText("출력 토큰 한도"), { target: { value: "800" } });
    fireEvent.change(screen.getByLabelText("비용 한도"), { target: { value: "3.5" } });
    fireEvent.click(screen.getByLabelText("비전 입력 지원"));
    fireEvent.change(screen.getByLabelText("fallback 모델"), { target: { value: "gpt-4o-mini" } });
    fireEvent.click(screen.getByRole("button", { name: "정책 생성" }));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({
      model: "gpt-4.1-mini",
      capabilities: { maxContextTokens: 16000, jsonMode: true, vision: true },
      budget: { maxInputTokens: 2000, maxOutputTokens: 800, maxCost: 3.5 },
      fallback_config: { model: "gpt-4o-mini" },
    });

    fireEvent.click(screen.getByRole("button", { name: "고급 JSON 열기" }));
    expect(await screen.findByLabelText("capabilities (JSON)")).toBeInTheDocument();
  });
});
