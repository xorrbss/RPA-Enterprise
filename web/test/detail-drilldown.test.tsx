import { beforeEach, describe, expect, test } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { App } from "../src/App";
import { ApiClientProvider } from "../src/api/context";
import type { ApiClient } from "../src/api/client";
import { fakeClient } from "./fake-client";

// 작업항목·사람확인 상세 드릴다운(getWorkitem/getHumanTask) + 원본 실행 교차 동선. smoke.test.tsx(500라인 한도)에서
// 의미 단위로 분리(CLAUDE.md #7). 표시값은 reads.ts 실 투영 필드만, run_id null이면 링크 미생성(fabrication 가드).
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
function jwt(roles: readonly string[]): string {
  const payload = btoa(JSON.stringify({ sub: "u", tenant_id: "t", roles })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `e30.${payload}.sig`;
}
const ALL_ROLES = ["viewer", "operator", "reviewer", "approver", "admin"];

describe("작업항목·사람확인 상세 드릴다운", () => {
  beforeEach(() => {
    location.hash = "";
    localStorage.setItem("rpa.token", jwt(ALL_ROLES));
  });

  // T1 — 작업항목 drill-down: '상세' → getWorkitem 호출 + attempts·checked_out_by 실 필드 표출(실측 노출).
  test("작업항목 drill-down — getWorkitem 패널(시도/처리 담당 표시)", async () => {
    const calls: string[] = [];
    renderApp(
      fakeClient({
        listWorkitems: async () => ({
          items: [{ workitem_id: "wi-abc12345", status: "processing", unique_reference: "ref-1", attempts: 3, checked_out_by: "w-9", checked_out_at: "2026-06-15T00:00:00.000Z", run_id: "11111111-aaaa-bbbb-cccc-000000000001" }],
          next_cursor: null,
        }),
        getWorkitem: async (id) => {
          calls.push(id);
          return { workitem_id: id, status: "processing", unique_reference: "ref-1", attempts: 3, checked_out_by: "w-9", checked_out_at: "2026-06-15T00:00:00.000Z", run_id: "11111111-aaaa-bbbb-cccc-000000000001" };
        },
      }),
    );
    location.hash = "#workitems";
    (await screen.findByRole("button", { name: "상세" })).click();
    await waitFor(() => expect(calls).toContain("wi-abc12345"));
    const panel = await screen.findByRole("region", { name: "작업항목 상세" });
    expect(within(panel).getByRole("heading", { name: "작업항목 상세" })).toBeInTheDocument();
    expect(panel).not.toHaveTextContent("wi-abc12345");
    await within(panel).findByText("w-9"); // checked_out_by(실 필드) — 상세 쿼리 resolve 후 표시
    expect(within(panel).getByText("3")).toBeInTheDocument(); // attempts(실 필드)
  });

  // T2 — run_id 채워진 작업항목 → '원본 실행 보기' → #runTrace?run=<id> 교차 동선.
  test("작업항목 상세: run_id 있으면 '원본 실행 보기' → runTrace 해시", async () => {
    renderApp(
      fakeClient({
        listWorkitems: async () => ({
          items: [{ workitem_id: "wi-1", status: "successful", unique_reference: "ref", attempts: 1, checked_out_by: null, checked_out_at: null, run_id: "run-xyz" }],
          next_cursor: null,
        }),
        getWorkitem: async (id) => ({ workitem_id: id, status: "successful", unique_reference: "ref", attempts: 1, checked_out_by: null, checked_out_at: null, run_id: "run-xyz" }),
      }),
    );
    location.hash = "#workitems";
    (await screen.findByRole("button", { name: "상세" })).click();
    (await screen.findByRole("button", { name: /원본 실행 보기/ })).click();
    await waitFor(() => expect(location.hash).toBe("#runTrace?run=run-xyz"));
  });

  // T3(fabrication 가드) — run_id:null이면 '원본 실행 보기' 버튼을 만들지 않는다(가짜 링크 미생성).
  test("작업항목 상세: run_id null이면 '원본 실행 보기' 미렌더(fabrication 가드)", async () => {
    renderApp(
      fakeClient({
        listWorkitems: async () => ({
          items: [{ workitem_id: "wi-2", status: "new", unique_reference: "ref", attempts: 0, checked_out_by: null, checked_out_at: null, run_id: null }],
          next_cursor: null,
        }),
        getWorkitem: async (id) => ({ workitem_id: id, status: "new", unique_reference: "ref", attempts: 0, checked_out_by: null, checked_out_at: null, run_id: null }),
      }),
    );
    location.hash = "#workitems";
    (await screen.findByRole("button", { name: "상세" })).click();
    const panel = await screen.findByRole("region", { name: "작업항목 상세" });
    await within(panel).findByText("— (미점유)"); // 상세 쿼리 resolve(checked_out_by null) 후 단언 — 로딩 중 false-pass 방지
    expect(within(panel).queryByRole("button", { name: /원본 실행 보기/ })).toBeNull();
  });

  // T4 — 사람확인 drill-down: '상세' → getHumanTask on_timeout 라벨 + 상태별 액션(HumanTaskActions) 재사용.
  test("사람확인 drill-down — getHumanTask 패널(만료 시 처리 + 액션)", async () => {
    renderApp(
      fakeClient({
        listHumanTasks: async () => ({
          items: [{ human_task_id: "ht-d1", state: "in_progress", kind: "approval", assignee: "u-1", timeout: null, on_timeout: "escalate", run_id: null }],
          next_cursor: null,
        }),
        getHumanTask: async (id) => ({ human_task_id: id, state: "in_progress", kind: "approval", assignee: "u-1", timeout: null, on_timeout: "escalate", run_id: null }),
      }),
    );
    location.hash = "#humanTasks";
    (await screen.findByRole("button", { name: "상세" })).click();
    const panel = await screen.findByRole("region", { name: "검토 업무 상세" });
    await within(panel).findByText("상위 담당자에게 이관"); // on_timeout(실 컬럼) — 상세 쿼리 resolve 후 표시
    expect(within(panel).getByRole("button", { name: "완료 처리" })).toBeInTheDocument(); // in_progress 액션(HumanTaskActions 재사용)
  });

  // 이관 사유(escalation_reason) 노출 — 재배정될 담당자에게 맥락 전달.
  test("escalated 태스크 상세는 이관 사유를 표시한다", async () => {
    renderApp(
      fakeClient({
        listHumanTasks: async () => ({
          items: [{ human_task_id: "ht-esc", state: "escalated", kind: "approval", assignee: null, timeout: null, on_timeout: "escalate", run_id: null }],
          next_cursor: null,
        }),
        getHumanTask: async (id) => ({ human_task_id: id, state: "escalated", kind: "approval", assignee: null, timeout: null, on_timeout: "escalate", run_id: null, escalation_reason: "고객 본인 확인이 필요해 상위 담당자에게 넘김", escalated_by: "rv", escalated_at: "2026-06-25T00:00:00.000Z" }),
      }),
    );
    location.hash = "#humanTasks";
    (await screen.findByRole("button", { name: "상세" })).click();
    const panel = await screen.findByRole("region", { name: "검토 업무 상세" });
    expect(await within(panel).findByText("이관 사유")).toBeInTheDocument();
    expect(within(panel).getByText("고객 본인 확인이 필요해 상위 담당자에게 넘김")).toBeInTheDocument();
  });

  // 이관 사유는 선택 입력 — 비워도 이관 가능, 입력 시 escalateHumanTask(reason) 호출.
  test("이관 버튼은 선택 사유를 받아 escalateHumanTask(reason)로 전달한다", async () => {
    const calls: Array<{ id: string; reason?: string }> = [];
    renderApp(
      fakeClient({
        listHumanTasks: async () => ({
          items: [{ human_task_id: "ht-e2", state: "in_progress", kind: "approval", assignee: "u-1", timeout: null, on_timeout: "escalate", run_id: null }],
          next_cursor: null,
        }),
        getHumanTask: async (id) => ({ human_task_id: id, state: "in_progress", kind: "approval", assignee: "u-1", timeout: null, on_timeout: "escalate", run_id: null }),
        escalateHumanTask: async (id, _key, reason) => { calls.push({ id, reason }); return { human_task_id: id, state: "escalated" }; },
      }),
    );
    location.hash = "#humanTasks";
    (await screen.findByRole("button", { name: "상세" })).click();
    const panel = await screen.findByRole("region", { name: "검토 업무 상세" });
    fireEvent.click(await within(panel).findByRole("button", { name: "이관" }));
    fireEvent.change(await screen.findByLabelText("이관 사유 (선택)"), { target: { value: "처리 권한 부족" } });
    fireEvent.click(screen.getByRole("button", { name: "확인" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.reason).toBe("처리 권한 부족");
  });

  test("Human Task result_schema가 있으면 목록에서 바로 resolve하지 않고 검토 입력으로 보낸다", async () => {
    const resolved: string[] = [];
    renderApp(
      fakeClient({
        listHumanTasks: async () => ({
          items: [
            {
              human_task_id: "ht-schema-row",
              state: "in_progress",
              kind: "validation",
              assignee: "u-1",
              timeout: null,
              on_timeout: "retry",
              run_id: null,
              result_schema: { version: "business_form_v1", fields: [{ key: "total", label: "Total", type: "number", required: true }] },
            },
          ],
          next_cursor: null,
        }),
        getHumanTask: async (id) => ({
          human_task_id: id,
          state: "in_progress",
          kind: "validation",
          assignee: "u-1",
          timeout: null,
          on_timeout: "retry",
          run_id: null,
          result_schema: { version: "business_form_v1", fields: [{ key: "total", label: "Total", type: "number", required: true }] },
          result: null,
        }),
        resolveHumanTask: async (id) => {
          resolved.push(id);
          return {};
        },
      }),
    );
    location.hash = "#humanTasks";

    expect(await screen.findByRole("button", { name: "검토 입력" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "완료 처리" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "검토 입력" }));

    await waitFor(() => expect(location.hash).toBe("#humanTasks?ht=ht-schema-row"));
    expect(resolved).toEqual([]);
    const panel = await screen.findByRole("region", { name: "검토 업무 상세" });
    expect(await within(panel).findByText("구조화 양식")).toBeInTheDocument();
  });

  test("Human Task result_schema 빈 객체는 바로 완료 처리 액션을 유지한다", async () => {
    const resolved: string[] = [];
    renderApp(
      fakeClient({
        listHumanTasks: async () => ({
          items: [
            {
              human_task_id: "ht-empty-schema",
              state: "in_progress",
              kind: "validation",
              assignee: "u-1",
              timeout: null,
              on_timeout: "retry",
              run_id: null,
              result_schema: {},
            },
          ],
          next_cursor: null,
        }),
        resolveHumanTask: async (id) => {
          resolved.push(id);
          return {};
        },
      }),
    );
    location.hash = "#humanTasks";

    const complete = await screen.findByRole("button", { name: "완료 처리" });
    expect(screen.queryByRole("button", { name: "검토 입력" })).toBeNull();
    fireEvent.click(complete);
    fireEvent.click(await screen.findByRole("button", { name: "확인" }));

    await waitFor(() => expect(resolved).toEqual(["ht-empty-schema"]));
  });

  test("사람확인 인박스는 문서 검증 큐만 좁혀 볼 수 있다", async () => {
    renderApp(
      fakeClient({
        listHumanTasks: async () => ({
          items: [
            {
              human_task_id: "ht-doc",
              state: "in_progress",
              kind: "validation",
              assignee: "u-1",
              timeout: "2026-06-24T00:00:00.000Z",
              on_timeout: "retry",
              run_id: null,
              result_schema: { version: "business_form_v1", fields: [{ key: "invoice_id", label: "Invoice ID", type: "text", required: true }] },
              artifact_refs: ["91000000-0000-0000-0000-000000000001"],
            },
            {
              human_task_id: "ht-approval",
              state: "open",
              kind: "approval",
              assignee: null,
              timeout: null,
              on_timeout: "escalate",
              run_id: null,
            },
          ],
          next_cursor: null,
        }),
      }),
    );
    location.hash = "#humanTasks";

    expect(await screen.findByText("검증 대기 문서")).toBeInTheDocument();
    expect(await screen.findByText("접수번호 #ht-doc")).toBeInTheDocument();
    expect(screen.getByText("접수번호 #ht-appro")).toBeInTheDocument();
    expect(screen.getAllByText("문서 검증").length).toBeGreaterThanOrEqual(1);
    fireEvent.click(screen.getByRole("button", { name: /문서 검증 업무 1/ }));

    expect(screen.getByText("접수번호 #ht-doc")).toBeInTheDocument();
    expect(screen.queryByText("접수번호 #ht-appro")).toBeNull();
    expect(screen.queryByText("ht-approval")).toBeNull();
    expect(screen.getByText("증빙 1건")).toBeInTheDocument();
  });

  // T5 — run_id 채워진 사람확인 → '원본 실행 보기' → runTrace 해시.
  test("사람확인 상세: run_id 있으면 '원본 실행 보기' → runTrace 해시", async () => {
    renderApp(
      fakeClient({
        listHumanTasks: async () => ({
          items: [{ human_task_id: "ht-r", state: "open", kind: "validation", assignee: null, timeout: null, on_timeout: null, run_id: "run-ht" }],
          next_cursor: null,
        }),
        getHumanTask: async (id) => ({ human_task_id: id, state: "open", kind: "validation", assignee: null, timeout: null, on_timeout: null, run_id: "run-ht" }),
      }),
    );
    location.hash = "#humanTasks";
    (await screen.findByRole("button", { name: "상세" })).click();
    (await screen.findByRole("button", { name: /연결된 실행 보기/ })).click();
    await waitFor(() => expect(location.hash).toBe("#runTrace?run=run-ht"));
  });

  // T6(fabrication 가드) — run_id:null → '원본 실행 보기' 미렌더.
  test("사람확인 상세: run_id null이면 '원본 실행 보기' 미렌더(fabrication 가드)", async () => {
    renderApp(
      fakeClient({
        listHumanTasks: async () => ({
          items: [{ human_task_id: "ht-n", state: "open", kind: "approval", assignee: null, timeout: null, on_timeout: "escalate", run_id: null }],
          next_cursor: null,
        }),
      }),
    );
    location.hash = "#humanTasks";
    (await screen.findByRole("button", { name: "상세" })).click();
    const panel = await screen.findByRole("region", { name: "검토 업무 상세" });
    await within(panel).findByText("상위 담당자에게 이관"); // on_timeout — 상세 쿼리 resolve 후 단언(로딩 중 false-pass 방지)
    expect(within(panel).queryByRole("button", { name: /연결된 실행 보기/ })).toBeNull();
  });

  test("Human Task V2 워크벤치: 수정 판정 결과를 resolveHumanTask(result)로 보낸다", async () => {
    const results: unknown[] = [];
    renderApp(
      fakeClient({
        listHumanTasks: async () => ({
          items: [{ human_task_id: "ht-v2", state: "in_progress", kind: "validation", assignee: "u-1", timeout: null, on_timeout: "retry", run_id: "run-v2" }],
          next_cursor: null,
        }),
        getHumanTask: async (id) => ({
          human_task_id: id,
          state: "in_progress",
          kind: "validation",
          assignee: "u-1",
          timeout: "2026-06-24T00:00:00.000Z",
          on_timeout: "retry",
          run_id: "run-v2",
          payload: { invoice_id: "INV-7", total: 9900, source_artifact_id: "artifact-hidden", run_id: "run-hidden" },
          result_schema: { required: ["invoice_id", "total"] },
          artifact_refs: ["artifact-1", "artifact-2"],
          result: null,
        }),
        resolveHumanTask: async (_id, _key, result) => {
          results.push(result);
          return {};
        },
      }),
    );
    location.hash = "#humanTasks";
    (await screen.findByRole("button", { name: "상세" })).click();
    const panel = await screen.findByRole("region", { name: "검토 업무 상세" });
    const workbench = await within(panel).findByRole("region", { name: "검증/교정 워크벤치" });
    expect(within(workbench).getByText("송장 번호")).toBeInTheDocument();
    expect(within(workbench).getByText("INV-7", { selector: "dd" })).toBeInTheDocument();
    expect(within(workbench).getAllByRole("button", { name: /증빙 자료 .* 조회/ })).toHaveLength(2);
    expect(within(workbench).queryByText("원본 요청 보기")).toBeNull();
    expect(within(workbench).queryByText("입력 규칙 보기")).toBeNull();
    expect(within(workbench).queryByText(/"invoice_id"/)).toBeNull();
    expect(within(workbench).queryByText(/"required"/)).toBeNull();
    expect(within(workbench).queryByText("source_artifact_id")).toBeNull();
    expect(within(workbench).queryByText("artifact-hidden")).toBeNull();
    expect(within(workbench).queryByText("run-hidden")).toBeNull();

    fireEvent.change(within(workbench).getByLabelText("판정"), { target: { value: "correct" } });
    fireEvent.change(within(workbench).getByLabelText("수정 항목명"), { target: { value: "total" } });
    fireEvent.change(within(workbench).getByLabelText("수정값"), { target: { value: "10000" } });
    fireEvent.change(within(workbench).getByLabelText("처리 사유"), { target: { value: "OCR 금액 보정" } });
    fireEvent.change(within(workbench).getByLabelText("확신도"), { target: { value: "0.92" } });
    fireEvent.change(within(workbench).getByLabelText("검토 메모"), { target: { value: "원본 증빙과 대조 완료" } });
    within(workbench).getByRole("button", { name: "판정 기록 후 재개 신호 보내기" }).click();

    await waitFor(() => expect(results).toEqual([
      {
        decision: "correct",
        corrections: { total: 10000 },
        reason: "OCR 금액 보정",
        confidence: 0.92,
        notes: "원본 증빙과 대조 완료",
      },
    ]));
  });

  test("Human Task 워크벤치: 증빙 자료 클릭은 증빙 딥링크를 갱신한다", async () => {
    const artifactId = "91000000-0000-0000-0000-000000000001";
    const fetched: string[] = [];
    renderApp(
      fakeClient({
        listHumanTasks: async () => ({
          items: [{ human_task_id: "ht-artifact", state: "in_progress", kind: "validation", assignee: "u-1", timeout: null, on_timeout: "retry", run_id: null }],
          next_cursor: null,
        }),
        getHumanTask: async (id) => ({
          human_task_id: id,
          state: "in_progress",
          kind: "validation",
          assignee: "u-1",
          timeout: null,
          on_timeout: "retry",
          run_id: null,
          payload: { invoice_id: "INV-9" },
          result_schema: { version: "business_form_v1", fields: [{ key: "invoice_id", label: "Invoice ID", type: "text", required: true }] },
          artifact_refs: [artifactId],
          result: null,
        }),
        getArtifact: async (id) => {
          fetched.push(id);
          return { artifact_id: id, type: "extract_result_json", sha256: "sha-artifact", redaction_status: "redacted", retention_until: null, content: "invoice evidence body" };
        },
      }),
    );
    location.hash = "#humanTasks";
    (await screen.findByRole("button", { name: "상세" })).click();
    const panel = await screen.findByRole("region", { name: "검토 업무 상세" });
    const workbench = await within(panel).findByRole("region", { name: "검증/교정 워크벤치" });

    fireEvent.click(within(workbench).getByRole("button", { name: `증빙 자료 ${artifactId} 조회` }));

    await waitFor(() => expect(location.hash).toBe(`#humanTasks?ht=ht-artifact&artifact=${artifactId}`));
    await waitFor(() => expect(fetched).toContain(artifactId));
    expect(await within(workbench).findByLabelText("결과 요약")).toHaveTextContent("텍스트 결과");
    expect(within(workbench).queryByText("invoice evidence body")).toBeNull();
  });

  test("Human Task business_form_v1: schema 기반 폼 값을 corrections로 보낸다", async () => {
    const results: unknown[] = [];
    renderApp(
      fakeClient({
        listHumanTasks: async () => ({
          items: [{ human_task_id: "ht-form", state: "in_progress", kind: "validation", assignee: "u-1", timeout: null, on_timeout: "retry", run_id: null }],
          next_cursor: null,
        }),
        getHumanTask: async (id) => ({
          human_task_id: id,
          state: "in_progress",
          kind: "validation",
          assignee: "u-1",
          timeout: null,
          on_timeout: "retry",
          run_id: null,
          payload: { invoice_id: "INV-7" },
          result_schema: {
            version: "business_form_v1",
            fields: [
              { key: "invoice_id", label: "Invoice ID", type: "text", required: true },
              { key: "total", label: "Total", type: "number", required: true },
              { key: "approved", label: "Approved", type: "boolean" },
            ],
          },
          artifact_refs: [],
          result: null,
        }),
        resolveHumanTask: async (_id, _key, result) => {
          results.push(result);
          return {};
        },
      }),
    );
    location.hash = "#humanTasks";
    (await screen.findByRole("button", { name: "상세" })).click();
    const panel = await screen.findByRole("region", { name: "검토 업무 상세" });
    const workbench = await within(panel).findByRole("region", { name: "검증/교정 워크벤치" });
    expect(within(workbench).getByText("구조화 양식")).toBeInTheDocument();
    expect(within(workbench).getByLabelText(/Invoice ID/)).toHaveValue("INV-7");
    expect(within(workbench).getByText(/감사·후속 검토 기록으로 저장/)).toBeInTheDocument();

    fireEvent.change(within(workbench).getByLabelText("판정"), { target: { value: "correct" } });
    fireEvent.change(within(workbench).getByLabelText(/Total/), { target: { value: "125000" } });
    fireEvent.change(within(workbench).getByLabelText(/Approved/), { target: { value: "true" } });
    within(workbench).getByRole("button", { name: "판정 기록 후 재개 신호 보내기" }).click();

    await waitFor(() => expect(results).toEqual([
      {
        decision: "correct",
        corrections: { invoice_id: "INV-7", total: 125000, approved: true },
      },
    ]));
  });

  test("Human Task business_form_v1: reject는 필수 정정값 없이 판정을 보낸다", async () => {
    const results: unknown[] = [];
    renderApp(
      fakeClient({
        listHumanTasks: async () => ({
          items: [{ human_task_id: "ht-form-reject", state: "in_progress", kind: "validation", assignee: "u-1", timeout: null, on_timeout: "retry", run_id: null }],
          next_cursor: null,
        }),
        getHumanTask: async (id) => ({
          human_task_id: id,
          state: "in_progress",
          kind: "validation",
          assignee: "u-1",
          timeout: null,
          on_timeout: "retry",
          run_id: null,
          payload: {},
          result_schema: {
            version: "business_form_v1",
            fields: [
              { key: "invoice_id", label: "Invoice ID", type: "text", required: true },
              { key: "total", label: "Total", type: "number", required: true },
            ],
          },
          artifact_refs: [],
          result: null,
        }),
        resolveHumanTask: async (_id, _key, result) => {
          results.push(result);
          return {};
        },
      }),
    );
    location.hash = "#humanTasks";
    (await screen.findByRole("button", { name: "상세" })).click();
    const panel = await screen.findByRole("region", { name: "검토 업무 상세" });
    const workbench = await within(panel).findByRole("region", { name: "검증/교정 워크벤치" });

    fireEvent.change(within(workbench).getByLabelText("판정"), { target: { value: "reject" } });
    fireEvent.change(within(workbench).getByLabelText("처리 사유"), { target: { value: "증빙 불일치" } });
    within(workbench).getByRole("button", { name: "판정 기록 후 재개 신호 보내기" }).click();

    await waitFor(() => expect(results).toEqual([
      {
        decision: "reject",
        reason: "증빙 불일치",
      },
    ]));
  });

  test("Human Task business_form_v1: 필수 boolean은 명시 선택하고 선택 boolean은 비워둘 수 있다", async () => {
    const results: unknown[] = [];
    renderApp(
      fakeClient({
        listHumanTasks: async () => ({
          items: [{ human_task_id: "ht-form-bool", state: "in_progress", kind: "validation", assignee: "u-1", timeout: null, on_timeout: "retry", run_id: null }],
          next_cursor: null,
        }),
        getHumanTask: async (id) => ({
          human_task_id: id,
          state: "in_progress",
          kind: "validation",
          assignee: "u-1",
          timeout: null,
          on_timeout: "retry",
          run_id: null,
          payload: { invoice_id: "INV-8" },
          result_schema: {
            version: "business_form_v1",
            fields: [
              { key: "invoice_id", label: "Invoice ID", type: "text", required: true },
              { key: "approved", label: "Approved", type: "boolean", required: true },
              { key: "flagged", label: "Flagged", type: "boolean" },
            ],
          },
          artifact_refs: [],
          result: null,
        }),
        resolveHumanTask: async (_id, _key, result) => {
          results.push(result);
          return {};
        },
      }),
    );
    location.hash = "#humanTasks";
    (await screen.findByRole("button", { name: "상세" })).click();
    const panel = await screen.findByRole("region", { name: "검토 업무 상세" });
    const workbench = await within(panel).findByRole("region", { name: "검증/교정 워크벤치" });

    fireEvent.change(within(workbench).getByLabelText("판정"), { target: { value: "correct" } });
    within(workbench).getByRole("button", { name: "판정 기록 후 재개 신호 보내기" }).click();
    expect(await within(workbench).findByRole("alert")).toHaveTextContent("Approved");
    expect(results).toEqual([]);

    fireEvent.change(within(workbench).getByLabelText(/Approved/), { target: { value: "false" } });
    within(workbench).getByRole("button", { name: "판정 기록 후 재개 신호 보내기" }).click();

    await waitFor(() => expect(results).toEqual([
      {
        decision: "correct",
        corrections: { invoice_id: "INV-8", approved: false },
      },
    ]));
  });

  test("Human Task business_form_v1: 잘못된 스키마는 직접 입력으로 우회하지 않는다", async () => {
    const results: unknown[] = [];
    renderApp(
      fakeClient({
        listHumanTasks: async () => ({
          items: [{ human_task_id: "ht-form-invalid", state: "in_progress", kind: "validation", assignee: "u-1", timeout: null, on_timeout: "retry", run_id: null }],
          next_cursor: null,
        }),
        getHumanTask: async (id) => ({
          human_task_id: id,
          state: "in_progress",
          kind: "validation",
          assignee: "u-1",
          timeout: null,
          on_timeout: "retry",
          run_id: null,
          payload: {},
          result_schema: {
            version: "business_form_v1",
            fields: [
              { key: "invoice_id", label: "Invoice ID", type: "text" },
              { key: "invoice_id", label: "Invoice ID again", type: "text" },
            ],
          },
          artifact_refs: [],
          result: null,
        }),
        resolveHumanTask: async (_id, _key, result) => {
          results.push(result);
          return {};
        },
      }),
    );
    location.hash = "#humanTasks";
    (await screen.findByRole("button", { name: "상세" })).click();
    const panel = await screen.findByRole("region", { name: "검토 업무 상세" });
    const workbench = await within(panel).findByRole("region", { name: "검증/교정 워크벤치" });

    expect(await within(workbench).findByRole("alert")).toHaveTextContent("중복된 입력 양식 필드입니다");
    const submit = within(workbench).getByRole("button", { name: "판정 기록 후 재개 신호 보내기" });
    expect(submit).toBeDisabled();
    fireEvent.click(submit);
    expect(results).toEqual([]);
  });

  test("Human Task 직접 입력: 중복 correction key는 판정을 차단한다", async () => {
    const results: unknown[] = [];
    renderApp(
      fakeClient({
        listHumanTasks: async () => ({
          items: [{ human_task_id: "ht-manual-duplicate", state: "in_progress", kind: "validation", assignee: "u-1", timeout: null, on_timeout: "retry", run_id: null }],
          next_cursor: null,
        }),
        getHumanTask: async (id) => ({
          human_task_id: id,
          state: "in_progress",
          kind: "validation",
          assignee: "u-1",
          timeout: null,
          on_timeout: "retry",
          run_id: null,
          payload: {},
          result_schema: { required: ["invoice_id"] },
          artifact_refs: [],
          result: null,
        }),
        resolveHumanTask: async (_id, _key, result) => {
          results.push(result);
          return {};
        },
      }),
    );
    location.hash = "#humanTasks";
    (await screen.findByRole("button", { name: "상세" })).click();
    const panel = await screen.findByRole("region", { name: "검토 업무 상세" });
    const workbench = await within(panel).findByRole("region", { name: "검증/교정 워크벤치" });

    fireEvent.change(within(workbench).getByLabelText("판정"), { target: { value: "correct" } });
    fireEvent.change(within(workbench).getByLabelText("수정 항목명"), { target: { value: "invoice_id" } });
    fireEvent.change(within(workbench).getByLabelText("수정값"), { target: { value: "INV-1" } });
    within(workbench).getByRole("button", { name: "추가" }).click();
    const keys = await waitFor(() => {
      const inputs = within(workbench).getAllByLabelText("수정 항목명");
      expect(inputs).toHaveLength(2);
      return inputs;
    });
    const values = within(workbench).getAllByLabelText("수정값");
    fireEvent.change(keys[1]!, { target: { value: "invoice_id" } });
    fireEvent.change(values[1]!, { target: { value: "INV-2" } });
    within(workbench).getByRole("button", { name: "판정 기록 후 재개 신호 보내기" }).click();

    expect(await within(workbench).findByRole("alert")).toHaveTextContent("중복된 수정 항목입니다");
    expect(results).toEqual([]);
  });
});
