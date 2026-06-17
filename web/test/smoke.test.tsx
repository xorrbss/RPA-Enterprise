import { beforeEach, describe, expect, test } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { App } from "../src/App";
import { ApiClientProvider } from "../src/api/context";
import type { ApiClient } from "../src/api/client";
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

// roles 클레임을 담은 가짜 JWT(서명 미검증 — 프론트는 표시 판단용으로만 payload를 읽는다).
function jwt(roles: readonly string[]): string {
  const payload = btoa(JSON.stringify({ sub: "u", tenant_id: "t", roles })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `e30.${payload}.sig`;
}
const ALL_ROLES = ["viewer", "operator", "reviewer", "approver", "admin"];

describe("D7 운영 콘솔 shell", () => {
  beforeEach(() => {
    location.hash = "";
    localStorage.setItem("rpa.token", jwt(ALL_ROLES)); // 전 역할 — 명령 버튼 표시 + TokenGate 통과
  });

  test("토큰 게이트: 토큰 없으면 접속 화면", () => {
    localStorage.removeItem("rpa.token");
    renderApp();
    expect(screen.getByRole("heading", { level: 1, name: "RPA 운영 콘솔 접속" })).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "주 메뉴" })).toBeNull();
  });

  test("사이드바 + 11 nav item 렌더", () => {
    renderApp();
    const nav = screen.getByRole("navigation", { name: "주 메뉴" });
    expect(within(nav).getAllByRole("button")).toHaveLength(11);
  });

  test("기본 라우트 = dashboard (지표 + 최근 실행)", async () => {
    renderApp();
    expect(screen.getByRole("heading", { level: 1, name: "RPA 운영 대시보드" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("최근 실행")).toBeInTheDocument());
    // fake 실행이 running 상태로 표시(StatusBadge 한국어 라벨)
    await waitFor(() => expect(screen.getByText("실행 중")).toBeInTheDocument());
  });

  test("해시 라우팅 → workitems", async () => {
    renderApp();
    location.hash = "#workitems";
    await waitFor(() =>
      expect(screen.getByRole("heading", { level: 1, name: "작업 목록" })).toBeInTheDocument(),
    );
    // 빈 상태는 쿼리 resolve 후 표시(로딩 → 빈)
    await waitFor(() => expect(screen.getByText("조건에 맞는 작업 항목이 없습니다.")).toBeInTheDocument());
  });

  test("잘못된 해시 → dashboard 폴백", async () => {
    renderApp();
    location.hash = "#nonsense";
    await waitFor(() =>
      expect(screen.getByRole("heading", { level: 1, name: "RPA 운영 대시보드" })).toBeInTheDocument(),
    );
  });

  test("openGate: 정적 contract-doc 뷰 렌더(Placeholder 아님)", async () => {
    renderApp();
    location.hash = "#openGate";
    await waitFor(() => expect(screen.getByText("Product-open gate map")).toBeInTheDocument());
    expect(screen.getByText("RBAC 화면/액션 gate")).toBeInTheDocument(); // 계약 파생 행
    expect(screen.queryByText("준비 중")).toBeNull(); // Placeholder 배지 미노출
  });

  test("idempotency: 정적 contract-doc 뷰 렌더(Placeholder 아님)", async () => {
    renderApp();
    location.hash = "#idempotency";
    await waitFor(() => expect(screen.getByText("중복 방지 메커니즘")).toBeInTheDocument());
    expect(screen.getByText("제어평면 멱등 키 처리 흐름")).toBeInTheDocument(); // 계약 파생 패널
    // replay(완료 재제출)는 부작용 재실행 없이 최초 응답 반환 — 핵심 계약 의미 노출
    expect(screen.getByText("부작용 재실행 없이 최초 응답 재생 (replay)")).toBeInTheDocument();
    expect(screen.queryByText("준비 중")).toBeNull(); // Placeholder 배지 미노출
  });

  test("오류 상태 표면화 (조용한 빈화면 금지)", async () => {
    renderApp(
      fakeClient({
        listRuns: async () => {
          throw new Error("boom");
        },
      }),
    );
    await waitFor(() => expect(screen.getByText("불러오지 못했습니다")).toBeInTheDocument());
  });

  test("운영자 명령: 실행 취소(abort) 디스패치 + Idempotency-Key", async () => {
    const calls: Array<{ runId: string; key: string }> = [];
    const client = fakeClient({
      abortRun: async (runId, key) => {
        calls.push({ runId, key });
        return { status: "cancelled" };
      },
    });
    renderApp(client);
    location.hash = "#runTrace";
    const abortBtn = await screen.findByRole("button", { name: "취소" });
    abortBtn.click();
    (await screen.findByRole("button", { name: "확인" })).click(); // 포커스 트랩 다이얼로그 확인
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.runId).toBe("11111111-aaaa-bbbb-cccc-000000000001");
    expect(calls[0]?.key.length).toBeGreaterThan(0); // crypto.randomUUID 멱등키
    await waitFor(() => expect(screen.getByText("완료")).toBeInTheDocument());
  });

  test("human-task 처리완료(resolve) 디스패치", async () => {
    const calls: string[] = [];
    renderApp(
      fakeClient({
        listHumanTasks: async () => ({
          items: [{ human_task_id: "ht-1", state: "in_progress", kind: "approval", assignee: null, timeout: null, run_id: null }],
          next_cursor: null,
        }),
        resolveHumanTask: async (id) => {
          calls.push(id);
          return {};
        },
      }),
    );
    location.hash = "#humanTasks";
    const btn = await screen.findByRole("button", { name: "처리완료" });
    btn.click();
    (await screen.findByRole("button", { name: "확인" })).click();
    await waitFor(() => expect(calls).toContain("ht-1"));
  });

  test("확인 다이얼로그: role=dialog + aria-modal + 포커스 이동 + Esc 취소(focus trap)", async () => {
    const calls: string[] = [];
    renderApp(fakeClient({ abortRun: async () => { calls.push("x"); return {}; } }));
    location.hash = "#runTrace";
    (await screen.findByRole("button", { name: "취소" })).click();
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog.contains(document.activeElement)).toBe(true); // 포커스가 다이얼로그 내부로 이동
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull()); // Esc로 닫힘
    expect(calls).toHaveLength(0); // 취소 → mutate 안 됨(조용한 실행 금지)
  });

  test("배정 다이얼로그: assignee 입력 폼 → assignHumanTask(uuid) (native prompt 대체)", async () => {
    const calls: Array<{ assignee: string }> = [];
    renderApp(
      fakeClient({
        listHumanTasks: async () => ({ items: [{ human_task_id: "ht-9", state: "open", kind: "approval", assignee: null, timeout: null, run_id: null }], next_cursor: null }),
        assignHumanTask: async (_id, assignee) => { calls.push({ assignee }); return {}; },
      }),
    );
    location.hash = "#humanTasks";
    (await screen.findByRole("button", { name: "배정" })).click();
    expect(await screen.findByRole("button", { name: "확인" })).toBeDisabled(); // 빈 입력 → 확인 비활성(가드)
    fireEvent.change(screen.getByLabelText("담당자 ID(uuid)"), { target: { value: "00000000-0000-0000-0000-0000000000aa" } });
    screen.getByRole("button", { name: "확인" }).click();
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.assignee).toBe("00000000-0000-0000-0000-0000000000aa");
  });

  test("scenario prod 승격 디스패치 (If-Match=version)", async () => {
    const calls: Array<{ id: string; version: number }> = [];
    renderApp(
      fakeClient({
        listScenarios: async () => ({
          items: [{ scenario_id: "22222222-aaaa-bbbb-cccc-000000000001", name: "리뷰 수집", version: 3, latest_version_id: "33333333-aaaa-bbbb-cccc-000000000001" }],
          next_cursor: null,
        }),
        promoteScenario: async (id, version) => {
          calls.push({ id, version });
          return { version, promotion_status: "prod" };
        },
      }),
    );
    location.hash = "#scenarioStudio";
    const btn = await screen.findByRole("button", { name: "prod 승격" });
    btn.click();
    (await screen.findByRole("button", { name: "확인" })).click();
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({ id: "22222222-aaaa-bbbb-cccc-000000000001", version: 3 });
  });

  test("페이지네이션: next_cursor 있으면 '다음' 클릭 시 cursor 전달", async () => {
    const calls: Array<Record<string, unknown>> = [];
    renderApp(
      fakeClient({
        listRuns: async (p) => {
          calls.push(p ?? {});
          // 커서 기준(호출 횟수 무관): 첫 페이지→cursor-1, 진행 후→끝.
          return { items: [{ run_id: "r1", status: "running", current_node: null, as_of: null }], next_cursor: p?.cursor ? null : "cursor-1" };
        },
      }),
    );
    location.hash = "#runTrace";
    const nextBtn = await screen.findByRole("button", { name: "다음" });
    expect(nextBtn).not.toBeDisabled();
    nextBtn.click();
    await waitFor(() => expect(calls.some((c) => c.cursor === "cursor-1")).toBe(true));
  });

  test("필터: 상태 선택 시 fetcher에 status 전달", async () => {
    const calls: Array<Record<string, unknown>> = [];
    renderApp(
      fakeClient({
        listRuns: async (p) => {
          calls.push(p ?? {});
          return { items: [], next_cursor: null };
        },
      }),
    );
    location.hash = "#runTrace";
    const select = await screen.findByLabelText("상태");
    fireEvent.change(select, { target: { value: "running" } });
    await waitFor(() => expect(calls.some((c) => c.status === "running")).toBe(true));
  });

  test("시나리오 검사: validate 디스패치 + ValidationReport 렌더", async () => {
    const calls: Array<{ id: string }> = [];
    renderApp(
      fakeClient({
        validateScenario: async (id) => {
          calls.push({ id });
          return { valid: false, report: { errors: [{ rule: "V3", message: "no branch matched" }], warnings: [] } };
        },
      }),
    );
    location.hash = "#irValidation";
    const idInput = await screen.findByPlaceholderText(/00000000/);
    fireEvent.change(idInput, { target: { value: "scn-1" } });
    screen.getByRole("button", { name: "검사 실행" }).click();
    await waitFor(() => expect(calls).toHaveLength(1));
    await waitFor(() => expect(screen.getByText("거부")).toBeInTheDocument());
    expect(screen.getByText(/no branch matched/)).toBeInTheDocument();
  });

  test("운영자 명령 실패 → 코드 표면화", async () => {
    const { ApiError } = await import("../src/api/types");
    renderApp(
      fakeClient({
        abortRun: async () => {
          throw new ApiError(409, "RUN_ABORTED", { code: "RUN_ABORTED" });
        },
      }),
    );
    location.hash = "#runTrace";
    const abortBtn = await screen.findByRole("button", { name: "취소" });
    abortBtn.click();
    (await screen.findByRole("button", { name: "확인" })).click();
    await waitFor(() => expect(screen.getByText("RUN_ABORTED (409)")).toBeInTheDocument());
  });

  test("자동화 실행(run-start) 디스패치 — 최신 버전 createRun + Idempotency-Key", async () => {
    const calls: Array<{ sver: string; key: string }> = [];
    window.confirm = () => true;
    renderApp(
      fakeClient({
        listScenarios: async () => ({
          items: [{ scenario_id: "22222222-aaaa-bbbb-cccc-000000000001", name: "리뷰 수집", version: 2, latest_version_id: "33333333-aaaa-bbbb-cccc-000000000099" }],
          next_cursor: null,
        }),
        createRun: async (body, key) => {
          calls.push({ sver: body.scenario_version_id, key });
          return { run_id: "run-1", status: "queued" };
        },
      }),
    );
    location.hash = "#scenarioStudio";
    (await screen.findByRole("button", { name: "실행" })).click(); // 실행 패널 열기
    // getScenario(ir 없음 → url_ref 키 없음) → 추가 입력 없이 '실행 시작'.
    (await screen.findByRole("button", { name: "실행 시작" })).click();
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.sver).toBe("33333333-aaaa-bbbb-cccc-000000000099"); // latest_version_id 전달
    expect(calls[0]?.key.length).toBeGreaterThan(0); // crypto.randomUUID 멱등키
  });

  test("파라미터 시나리오 실행 — url_ref 키 입력 폼 → createRun(params)", async () => {
    const calls: Array<{ params: Record<string, unknown> }> = [];
    renderApp(
      fakeClient({
        listScenarios: async () => ({
          items: [{ scenario_id: "22222222-aaaa-bbbb-cccc-000000000002", name: "주문 수집", version: 1, latest_version_id: "33333333-aaaa-bbbb-cccc-000000000002" }],
          next_cursor: null,
        }),
        getScenario: async (id) => ({
          scenario_id: id,
          name: "주문 수집",
          version: 1,
          promotion_status: "prod",
          ir: { start: "open", nodes: { open: { what: [{ action: "navigate", url_ref: "orders_url" }], next: "done" }, done: { terminal: "success" } } },
        }),
        createRun: async (body) => {
          calls.push({ params: body.params ?? {} });
          return { run_id: "run-2", status: "queued" };
        },
      }),
    );
    location.hash = "#scenarioStudio";
    (await screen.findByRole("button", { name: "실행" })).click(); // 패널 열기 → getScenario → 키 도출
    const field = await screen.findByLabelText("orders_url");
    // 값 미입력 시 '실행 시작' 비활성(필수값 가드).
    expect(screen.getByRole("button", { name: "실행 시작" })).toBeDisabled();
    fireEvent.change(field, { target: { value: "https://shop.example/orders/9" } });
    screen.getByRole("button", { name: "실행 시작" }).click();
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.params).toEqual({ orders_url: "https://shop.example/orders/9" });
  });

  test("run-start model_required → 모델 입력 폼 노출 + 에러 패널내 표면화 + 재실행 시 model 전달", async () => {
    const { ApiError } = await import("../src/api/types");
    const calls: Array<{ model?: string }> = [];
    let attempt = 0;
    renderApp(
      fakeClient({
        listScenarios: async () => ({
          items: [{ scenario_id: "22222222-aaaa-bbbb-cccc-000000000003", name: "세션 확인", version: 1, latest_version_id: "33333333-aaaa-bbbb-cccc-000000000003" }],
          next_cursor: null,
        }),
        getScenario: async (id) => ({
          scenario_id: id,
          name: "세션 확인",
          version: 1,
          promotion_status: "prod",
          // url_ref 키 없음 → 추가 입력 없이 바로 실행(모델 해소만 검증).
          ir: { start: "open", nodes: { open: { what: [{ action: "observe" }], next: "done" }, done: { terminal: "success" } } },
        }),
        createRun: async (body) => {
          attempt += 1;
          // 1차: 다정책+기본없음 → model_required(임의선택 금지). 2차(model 지정): 성공.
          if (attempt === 1) {
            throw new ApiError(422, "IR_SCHEMA_INVALID", { code: "IR_SCHEMA_INVALID", details: { reason: "model_required", available: 2 } });
          }
          calls.push({ model: body.model });
          return { run_id: "run-3", status: "queued" };
        },
      }),
    );
    location.hash = "#scenarioStudio";
    (await screen.findByRole("button", { name: "실행" })).click(); // 패널 열기
    (await screen.findByRole("button", { name: "실행 시작" })).click(); // 1차 createRun → model_required
    // 모델 입력 폼 + 에러 메시지가 패널 안에 노출(조용한 무반응 금지).
    const modelField = await screen.findByLabelText("AI 모델");
    expect(screen.getByText(/AI 모델을 지정해야 합니다/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "실행 시작" })).toBeDisabled(); // 모델 미입력 가드
    fireEvent.change(modelField, { target: { value: "gpt-4o-mini" } });
    screen.getByRole("button", { name: "실행 시작" }).click(); // 2차 createRun(model)
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.model).toBe("gpt-4o-mini"); // 선택한 모델 전달
  });

  test("실행 상세 drill-down — getRun 패널(워커/시도 표시)", async () => {
    const calls: string[] = [];
    renderApp(
      fakeClient({
        listRuns: async () => ({ items: [{ run_id: "run-abc12345", status: "running", current_node: null, as_of: null }], next_cursor: null }),
        getRun: async (id) => {
          calls.push(id);
          return { run_id: id, status: "running", worker_id: "w-7", attempts: 2, as_of: "2026-06-15T00:00:00.000Z" };
        },
      }),
    );
    location.hash = "#runTrace";
    (await screen.findByRole("button", { name: "상세" })).click();
    await waitFor(() => expect(calls).toContain("run-abc12345"));
    await waitFor(() => expect(screen.getByText("실행 상세 — run-abc1")).toBeInTheDocument());
    expect(screen.getByText("w-7")).toBeInTheDocument(); // 워커
  });

  test("사이트 승인(approve) 디스패치 — pending 사이트만", async () => {
    const calls: Array<{ id: string; key: string }> = [];
    renderApp(
      fakeClient({
        listSites: async () => ({
          items: [{ site_profile_id: "site-1", risk: "red", approval_status: "pending", circuit_status: "open", name: "red-site" }],
          next_cursor: null,
        }),
        approveSite: async (id, key) => {
          calls.push({ id, key });
          return { site_profile_id: id, approval_status: "approved" };
        },
      }),
    );
    location.hash = "#security";
    (await screen.findByRole("button", { name: "승인" })).click();
    (await screen.findByRole("button", { name: "확인" })).click();
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.id).toBe("site-1");
    expect(calls[0]?.key.length).toBeGreaterThan(0); // Idempotency-Key
  });

  test("admin gateway 정책 편집: PUT If-Match(version)+Idempotency-Key 디스패치", async () => {
    const calls: Array<{ version: number; model: string; key: string }> = [];
    renderApp(
      fakeClient({
        getGatewayPolicy: async () => ({ model: "gpt-4o", version: 5, capabilities: { jsonMode: true }, budget: { maxInputTokens: 800 } }),
        updateGatewayPolicy: async (version, body, key) => {
          calls.push({ version, model: body.model, key });
          return { model: "gpt-4o", version: version + 1 };
        },
      }),
    );
    location.hash = "#llmGateway";
    const saveBtn = await screen.findByRole("button", { name: "정책 저장" });
    saveBtn.click();
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.version).toBe(5); // If-Match=현재 version
    expect(calls[0]?.model).toBe("gpt-4o");
    expect(calls[0]?.key.length).toBeGreaterThan(0); // Idempotency-Key
    await waitFor(() => expect(screen.getByText("저장됨")).toBeInTheDocument());
  });

  test("RBAC UI 게이팅: gateway 편집은 admin만 — operator는 폼 숨김(읽기 전용)", async () => {
    localStorage.setItem("rpa.token", jwt(["operator"]));
    renderApp(
      fakeClient({
        getGatewayPolicy: async () => ({ model: "gpt-4o", version: 5, capabilities: { jsonMode: true } }),
      }),
    );
    location.hash = "#llmGateway";
    await waitFor(() => expect(screen.getByText("gpt-4o")).toBeInTheDocument()); // 읽기 표시
    expect(screen.queryByRole("button", { name: "정책 저장" })).toBeNull(); // 편집 폼 미노출
  });

  test("admin gateway 편집: 버전 충돌 → POLICY_VERSION_CONFLICT 표면화", async () => {
    const { ApiError } = await import("../src/api/types");
    renderApp(
      fakeClient({
        getGatewayPolicy: async () => ({ model: "gpt-4o", version: 5, capabilities: {}, budget: {} }),
        updateGatewayPolicy: async () => {
          throw new ApiError(412, "POLICY_VERSION_CONFLICT", { code: "POLICY_VERSION_CONFLICT" });
        },
      }),
    );
    location.hash = "#llmGateway";
    (await screen.findByRole("button", { name: "정책 저장" })).click();
    await waitFor(() => expect(screen.getByText(/다른 사용자가 먼저 수정/)).toBeInTheDocument());
  });

  test("gateway 다중정책: model_required → 모델 입력 → getGatewayPolicy(model) 조회(dead-end 해소)", async () => {
    const { ApiError } = await import("../src/api/types");
    const calls: Array<string | undefined> = [];
    renderApp(
      fakeClient({
        getGatewayPolicy: async (model) => {
          calls.push(model);
          // model 미지정 → 다건이라 422 model_required(임의선택 금지). model 지정 시 그 정책 반환.
          if (model === undefined) {
            throw new ApiError(422, "IR_SCHEMA_INVALID", { code: "IR_SCHEMA_INVALID", details: { reason: "model_required", available: 2 } });
          }
          return { model, version: 7, capabilities: { jsonMode: true }, budget: {} };
        },
      }),
    );
    location.hash = "#llmGateway";
    // dead-end 아님: 모델 입력 폼 노출 + 빈 입력 가드(조회 비활성).
    const input = await screen.findByLabelText("모델명");
    expect(screen.getByRole("button", { name: "조회" })).toBeDisabled();
    fireEvent.change(input, { target: { value: "gpt-4o" } });
    screen.getByRole("button", { name: "조회" }).click();
    // model이 전달되어 재조회 → 상세 표시.
    await waitFor(() => expect(calls).toContain("gpt-4o"));
    await waitFor(() => expect(screen.getByText("gpt-4o")).toBeInTheDocument());
    // admin 토큰(beforeEach ALL_ROLES) → 편집 폼 도달 가능(영구차단 해소).
    expect(screen.getByRole("button", { name: "정책 저장" })).toBeInTheDocument();
  });

  test("gateway 모델 미존재: model 404 → 명시 메시지(조용한 빈화면 금지)", async () => {
    const { ApiError } = await import("../src/api/types");
    renderApp(
      fakeClient({
        getGatewayPolicy: async (model) => {
          if (model === undefined) {
            throw new ApiError(422, "IR_SCHEMA_INVALID", { code: "IR_SCHEMA_INVALID", details: { reason: "model_required", available: 2 } });
          }
          throw new ApiError(404, "RESOURCE_NOT_FOUND", { code: "RESOURCE_NOT_FOUND" });
        },
      }),
    );
    location.hash = "#llmGateway";
    fireEvent.change(await screen.findByLabelText("모델명"), { target: { value: "nope" } });
    screen.getByRole("button", { name: "조회" }).click();
    await waitFor(() => expect(screen.getByText(/찾을 수 없습니다/)).toBeInTheDocument());
  });

  test("RBAC UI 게이팅: viewer는 읽기 전용 — 명령 버튼 미표시", async () => {
    localStorage.setItem("rpa.token", jwt(["viewer"]));
    renderApp(
      fakeClient({
        listRuns: async () => ({ items: [{ run_id: "r1", status: "running", current_node: null, as_of: null }], next_cursor: null }),
      }),
    );
    location.hash = "#runTrace";
    await waitFor(() => expect(screen.getByRole("button", { name: "상세" })).toBeInTheDocument()); // 읽기 drill-down은 허용
    expect(screen.queryByRole("button", { name: "취소" })).toBeNull(); // run.abort 미보유 → 숨김
  });

  test("RBAC UI 게이팅: scenario.promote는 admin만 — operator는 승격 숨김, 실행/편집은 표시", async () => {
    localStorage.setItem("rpa.token", jwt(["operator"]));
    renderApp(
      fakeClient({
        listScenarios: async () => ({
          items: [{ scenario_id: "s1", name: "a", version: 1, latest_version_id: "v1" }],
          next_cursor: null,
        }),
      }),
    );
    location.hash = "#scenarioStudio";
    await waitFor(() => expect(screen.getByRole("button", { name: "실행" })).toBeInTheDocument()); // run.create: operator 보유
    expect(screen.getByRole("button", { name: "편집" })).toBeInTheDocument(); // scenario.update: operator 보유
    expect(screen.queryByRole("button", { name: "prod 승격" })).toBeNull(); // scenario.promote: admin만
  });
});
