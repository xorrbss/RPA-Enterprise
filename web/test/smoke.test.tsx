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

  test("사이드바 + 12 nav item 렌더", () => {
    renderApp();
    const nav = screen.getByRole("navigation", { name: "주 메뉴" });
    expect(within(nav).getAllByRole("button")).toHaveLength(12);
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

  // F1(정직): artifact 조회 거부 코드는 계약(api-surface.md:141) v1 거동과 일치해야 한다.
  // v1은 redaction 게이트를 artifacts_visible_isolation RLS로 강제 → pending/failed/cross-tenant는 RESOURCE_NOT_FOUND(404)로
  // 떨어지고 ARTIFACT_NOT_REDACTED(409)는 v1에서 노출하지 않는다. OpenGate는 스스로 '정적 contract-doc·추정 금지'를
  // 표방하므로 계약과 모순되는 코드 표기는 검증된 거짓이다(error-label.test 드리프트 가드와 동형).
  test("openGate: artifact 거부 코드 = 계약 v1 거동(RESOURCE_NOT_FOUND), ARTIFACT_NOT_REDACTED 재유입 시 실패", async () => {
    renderApp();
    location.hash = "#openGate";
    await waitFor(() => expect(screen.getByText("Product-open gate map")).toBeInTheDocument());
    // (정) 계약 v1 거동(404, 존재 비노출)이 노출됨.
    expect(screen.getAllByText(/RESOURCE_NOT_FOUND/).length).toBeGreaterThan(0);
    // (드리프트 가드) v1 미노출 코드가 OpenGate에 재유입되면 실패 — 계약 표방 vs 위반의 거짓 봉쇄.
    expect(screen.queryByText(/ARTIFACT_NOT_REDACTED/)).toBeNull();
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

  test("자동화 운영 해제 성공은 인라인 완료 배지를 남기지 않는다", async () => {
    const calls: Array<{ scenarioId: string; version: number; target: "prod" | "draft"; key: string }> = [];
    renderApp(
      fakeClient({
        listScenarios: async () => ({
          items: [
            {
              scenario_id: "70000000-0000-0000-0000-00000000d600",
              name: "삼성디스플레이 공지 수집",
              version: 3,
              latest_version_id: "70000000-0000-0000-0000-00000000d603",
              promotion_status: "prod",
            },
          ],
          next_cursor: null,
        }),
        setScenarioPromotion: async (scenarioId, version, target, key) => {
          calls.push({ scenarioId, version, target, key });
          return { version, promotion_status: target };
        },
      }),
    );
    location.hash = "#scenarioStudio";
    const unpublish = await screen.findByRole("button", { name: "운영 해제" });
    fireEvent.click(unpublish);
    fireEvent.click(await screen.findByRole("button", { name: "확인" }));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({
      scenarioId: "70000000-0000-0000-0000-00000000d600",
      version: 3,
      target: "draft",
    });
    expect(screen.queryByText("완료")).toBeNull();
  });

  test("human-task 처리완료(resolve) 디스패치", async () => {
    const calls: string[] = [];
    renderApp(
      fakeClient({
        listHumanTasks: async () => ({
          items: [{ human_task_id: "ht-1", state: "in_progress", kind: "approval", assignee: null, timeout: null, on_timeout: null, run_id: null }],
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
        listHumanTasks: async () => ({ items: [{ human_task_id: "ht-9", state: "open", kind: "approval", assignee: null, timeout: null, on_timeout: null, run_id: null }], next_cursor: null }),
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

  test("scenario 운영 지정 디스패치 (If-Match=version)", async () => {
    const calls: Array<{ id: string; version: number; target: string }> = [];
    renderApp(
      fakeClient({
        listScenarios: async () => ({
          items: [{ scenario_id: "22222222-aaaa-bbbb-cccc-000000000001", name: "리뷰 수집", version: 3, latest_version_id: "33333333-aaaa-bbbb-cccc-000000000001", promotion_status: "draft" }],
          next_cursor: null,
        }),
        setScenarioPromotion: async (id, version, target) => {
          calls.push({ id, version, target });
          return { version, promotion_status: target };
        },
      }),
    );
    location.hash = "#scenarioStudio";
    const btn = await screen.findByRole("button", { name: "운영 지정" });
    expect(btn).toHaveAttribute("title", expect.stringContaining("실행 전제가 아니라"));
    btn.click();
    expect(await screen.findByText(/실행 전제는 아니며/)).toBeInTheDocument();
    (await screen.findByRole("button", { name: "확인" })).click();
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({ id: "22222222-aaaa-bbbb-cccc-000000000001", version: 3, target: "prod" });
  });

  test("scenario 새 자동화 단계 편집은 추출 규칙 입력 영역을 바로 노출", async () => {
    renderApp(fakeClient({ listScenarios: async () => ({ items: [], next_cursor: null }) }));
    location.hash = "#scenarioStudio";
    fireEvent.click(await screen.findByRole("button", { name: "+ 새 자동화 만들기" }));
    fireEvent.click(await screen.findByRole("button", { name: "단계 편집(고급)" }));

    const rule = screen.getByRole("textbox", { name: "추출 규칙" });
    expect(rule.tagName).toBe("TEXTAREA");
    expect(rule).toHaveValue("현재 페이지에서 extracted_rows 데이터를 추출하라.");
    expect(screen.getByDisplayValue("extracted_rows")).toBeInTheDocument();
  });

  test("자연어 자동화 생성 → 저장 후 실행 대기 + 실행 기록 딥링크", async () => {
    const calls: Array<Parameters<ApiClient["generateScenario"]>[0]> = [];
    renderApp(
      fakeClient({
        listScenarios: async () => ({ items: [], next_cursor: null }),
        listSites: async () => ({
          items: [
            {
              site_profile_id: "10000000-0000-4000-8000-0000000000a1",
              risk: "green",
              approval_status: "approved",
              circuit_status: "closed",
              name: "shop",
              url_pattern: "https://shop.example",
              default_browser_identity_id: "10000000-0000-4000-8000-0000000000a2",
              default_network_policy_id: "10000000-0000-4000-8000-0000000000a3",
            },
          ],
          next_cursor: null,
        }),
        generateScenario: async (body) => {
          calls.push(body);
          return {
            generation_id: "00000000-0000-0000-0000-0000000000a1",
            mode: body.mode ?? "save_and_run",
            status: "run_queued",
            prompt_hash: "hash",
            planner: body.planner ?? "deterministic_mvp",
            model: body.model ?? null,
            scenario_id: "00000000-0000-0000-0000-0000000000c1",
            scenario_version_id: "00000000-0000-0000-0000-0000000000c2",
            run_id: "00000000-0000-0000-0000-000000000099",
            evidence_policy: body.evidence ?? { screenshot: "failure", video: "never" },
            blockers: [],
            created_at: "2026-06-15T00:00:00.000Z",
            created_by: "operator",
            draft_ir: {},
            validation_report: {},
          };
        },
      }),
    );
    location.hash = "#scenarioStudio";
    fireEvent.change(await screen.findByLabelText("자연어 요청"), { target: { value: "주문 목록을 요약해줘" } });
    fireEvent.change(screen.getByLabelText("시작 URL"), { target: { value: "https://shop.example/orders" } });
    fireEvent.change(screen.getByLabelText("Planner"), { target: { value: "llm_v1" } });
    fireEvent.change(screen.getByLabelText("AI 모델"), { target: { value: "gpt-4o-mini" } });
    fireEvent.change(await screen.findByLabelText("사이트"), { target: { value: "10000000-0000-4000-8000-0000000000a1" } });
    expect(screen.getByLabelText("브라우저 ID")).toHaveValue("10000000-0000-4000-8000-0000000000a2");
    expect(screen.getByLabelText("네트워크 정책 ID")).toHaveValue("10000000-0000-4000-8000-0000000000a3");
    screen.getByRole("button", { name: "저장 후 실행" }).click();

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({
      prompt: "주문 목록을 요약해줘",
      mode: "save_and_run",
      planner: "llm_v1",
      model: "gpt-4o-mini",
      start_url: "https://shop.example/orders",
      target: {
        site_profile_id: "10000000-0000-4000-8000-0000000000a1",
        browser_identity_id: "10000000-0000-4000-8000-0000000000a2",
        network_policy_id: "10000000-0000-4000-8000-0000000000a3",
      },
      evidence: { screenshot: "each_step", video: "never" },
    });
    await waitFor(() =>
      expect(location.hash).toBe(
        "#runTrace?run=00000000-0000-0000-0000-000000000099&generation=00000000-0000-0000-0000-0000000000a1&focus=artifacts",
      ),
    );
  });

  test("자연어 자동화 생성 차단 → blocker를 한국어로 표면화", async () => {
    const calls: Array<Parameters<ApiClient["generateScenario"]>[0]> = [];
    renderApp(
      fakeClient({
        listScenarios: async () => ({ items: [], next_cursor: null }),
        generateScenario: async (body) => {
          calls.push(body);
          return {
            generation_id: "00000000-0000-0000-0000-0000000000a2",
            mode: body.mode ?? "save_and_run",
            status: "blocked",
            prompt_hash: "hash",
            planner: "deterministic_mvp",
            model: body.model ?? null,
            scenario_id: "00000000-0000-0000-0000-0000000000c1",
            scenario_version_id: "00000000-0000-0000-0000-0000000000c2",
            run_id: null,
            evidence_policy: body.evidence ?? { screenshot: "failure", video: "never" },
            blockers: ["start_url_required_for_auto_run", "target_required_for_auto_run", "video_recording_port_not_configured"],
            created_at: "2026-06-15T00:00:00.000Z",
            created_by: "operator",
            draft_ir: {},
            validation_report: {},
          };
        },
      }),
    );
    location.hash = "#scenarioStudio";
    fireEvent.change(await screen.findByLabelText("자연어 요청"), { target: { value: "오늘 주문을 확인해줘" } });
    fireEvent.change(screen.getByLabelText("동영상"), { target: { value: "always" } });
    screen.getByRole("button", { name: "저장 후 실행" }).click();

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({ evidence: { video: "always" } });
    await waitFor(() => expect(screen.getByText("차단됨")).toBeInTheDocument());
    expect(screen.getByText("시작 URL이 필요합니다.")).toBeInTheDocument();
    expect(screen.getByText("실행 대상이 필요합니다.")).toBeInTheDocument();
    expect(screen.getByText("서버에서 동영상 녹화가 비활성화되어 있습니다.")).toBeInTheDocument();
  });

  test("최근 생성: run 연결 항목은 결과·산출물 보기로 RunTrace artifact focus 딥링크", async () => {
    renderApp(
      fakeClient({
        listScenarios: async () => ({ items: [], next_cursor: null }),
        listScenarioGenerations: async () => ({
          items: [
            {
              generation_id: "00000000-0000-0000-0000-0000000000a1",
              mode: "save_and_run",
              status: "run_queued",
              prompt_hash: "hash",
              planner: "deterministic_mvp",
              model: "gpt-4o-mini",
              scenario_id: "00000000-0000-0000-0000-0000000000c1",
              scenario_version_id: "00000000-0000-0000-0000-0000000000c2",
              run_id: "00000000-0000-0000-0000-000000000099",
              evidence_policy: { screenshot: "each_step", video: "never" },
              blockers: [],
              draft_ir: {},
              validation_report: {},
              created_at: "2026-06-15T00:00:00.000Z",
              created_by: "operator",
            },
          ],
          next_cursor: null,
        }),
      }),
    );
    location.hash = "#scenarioStudio";

    fireEvent.click(await screen.findByRole("button", { name: "결과·산출물 보기" }));

    await waitFor(() =>
      expect(location.hash).toBe(
        "#runTrace?run=00000000-0000-0000-0000-000000000099&generation=00000000-0000-0000-0000-0000000000a1&focus=artifacts",
      ),
    );
  });

  test("최근 생성: blocked 항목은 진단 요약과 planner 산출물을 선택 표시", async () => {
    renderApp(
      fakeClient({
        listScenarios: async () => ({ items: [], next_cursor: null }),
        listScenarioGenerations: async () => ({
          items: [
            {
              generation_id: "00000000-0000-0000-0000-0000000000b1",
              mode: "save_and_run",
              status: "blocked",
              prompt_hash: "hash",
              planner: "llm_v1",
              model: "gpt-4o-mini",
              scenario_id: null,
              scenario_version_id: null,
              run_id: null,
              evidence_policy: { screenshot: "each_step", video: "always" },
              blockers: ["start_url_required_for_auto_run", "target_required_for_auto_run", "video_recording_port_not_configured"],
              draft_ir: {},
              validation_report: {},
              created_at: "2026-06-15T00:00:00.000Z",
              created_by: "operator",
            },
          ],
          next_cursor: null,
        }),
        listScenarioGenerationArtifacts: async () => ({
          items: [
            {
              artifact_id: "91000000-0000-0000-0000-000000000001",
              type: "scenario_generation_planner_output",
              media_type: "application/json",
              filename: "planner.json",
              byte_size: 64,
              duration_ms: null,
              redaction_status: "redacted",
              retention_until: null,
              legal_hold: false,
              created_at: "2026-06-15T00:00:01.000Z",
            },
          ],
          next_cursor: null,
        }),
        getScenarioGenerationArtifact: async (generationId, artifactId) => ({
          artifact_id: artifactId,
          generation_id: generationId,
          type: "scenario_generation_planner_output",
          sha256: "abc123",
          redaction_status: "redacted",
          retention_until: null,
          content: '{"diagnostic":"target missing"}',
        }),
      }),
    );
    location.hash = "#scenarioStudio";

    expect(await screen.findByText(/진단: 시작 URL이 필요합니다/)).toHaveTextContent("외 1건");
    fireEvent.click(screen.getByRole("button", { name: "진단·산출물 보기" }));

    expect(location.hash).toBe("#scenarioStudio");
    expect(await screen.findByLabelText("generation artifacts")).toBeInTheDocument();
    expect(await screen.findByText("scenario_generation_planner_output")).toBeInTheDocument();
    expect(await screen.findByText(/target missing/)).toBeInTheDocument();
  });

  test("최근 생성: saved/no-run 항목은 실행 딥링크로 연결한 척하지 않는다", async () => {
    renderApp(
      fakeClient({
        listScenarios: async () => ({ items: [], next_cursor: null }),
        listScenarioGenerations: async () => ({
          items: [
            {
              generation_id: "00000000-0000-0000-0000-0000000000b2",
              mode: "save",
              status: "saved",
              prompt_hash: "hash",
              planner: "deterministic_mvp",
              model: null,
              scenario_id: "00000000-0000-0000-0000-0000000000c1",
              scenario_version_id: "00000000-0000-0000-0000-0000000000c2",
              run_id: null,
              evidence_policy: { screenshot: "failure", video: "never" },
              blockers: [],
              draft_ir: {},
              validation_report: {},
              created_at: "2026-06-15T00:00:00.000Z",
              created_by: "operator",
            },
          ],
          next_cursor: null,
        }),
      }),
    );
    location.hash = "#scenarioStudio";

    expect(await screen.findByText("실행 연결 없음")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "결과·산출물 보기" })).toBeNull();
    expect(screen.queryByLabelText("generation artifacts")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "저장본 확인" }));

    expect(location.hash).toBe("#scenarioStudio");
    expect(await screen.findByLabelText("generation artifacts")).toBeInTheDocument();
  });

  test("scenario 편집은 저장된 studio_mode=easy로 쉬운 만들기 폼을 복원", async () => {
    renderApp(
      fakeClient({
        listScenarios: async () => ({
          items: [{ scenario_id: "22222222-aaaa-bbbb-cccc-000000000010", name: "리뷰 수집", version: 1, latest_version_id: "33333333-aaaa-bbbb-cccc-000000000010", promotion_status: "draft" }],
          next_cursor: null,
        }),
        getScenario: async (id) => ({
          scenario_id: id,
          name: "리뷰 수집",
          version: 1,
          promotion_status: "draft",
          ir: {
            meta: { name: "리뷰 수집", version: 1, studio_mode: "easy" },
            params_schema: { type: "object", properties: { entry_url: { type: "string", default: "https://shop.example/reviews" } }, required: ["entry_url"] },
            start: "open",
            nodes: {
              open: { what: [{ action: "navigate", url_ref: "entry_url" }], next: "collect" },
              collect: { what: [{ action: "extract", instruction: "리뷰 제목과 별점을 추출하라.", schema_ref: "리뷰" }], next: "done" },
              done: { terminal: "success" },
            },
          },
        }),
      }),
    );
    location.hash = "#scenarioStudio";
    (await screen.findByRole("button", { name: "편집" })).click();
    await screen.findByDisplayValue("리뷰 제목과 별점을 추출하라.");
    expect(screen.getByRole("button", { name: "쉬운 만들기" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByDisplayValue("https://shop.example/reviews")).toBeInTheDocument();
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
    screen.getByRole("button", { name: "검증 실행" }).click();
    await waitFor(() => expect(calls).toHaveLength(1));
    await waitFor(() => expect(screen.getByText("검증 실패")).toBeInTheDocument());
    expect(screen.getByText(/no branch matched/)).toBeInTheDocument();
  });

  // F3 — validate 성공 표기는 정적 구조 검증(dry-run이 실제 보고한 것)만 말하고 '승격 가능'을 단정하지 않는다(조용한 false 금지).
  // 승격은 별개 명령(admin·If-Match version)이라 이 화면이 관찰하지 못한 값 → scenarioStudio로 안내만 한다(막다른 길 해소).
  test("시나리오 검사: valid → 정적 구조 검증 통과(승격 가능 단정 없음) + 자동화 만들기 안내 동선", async () => {
    renderApp(
      fakeClient({
        validateScenario: async () => ({ valid: true, report: { errors: [], warnings: [] } }),
      }),
    );
    location.hash = "#irValidation";
    fireEvent.change(await screen.findByPlaceholderText(/00000000/), { target: { value: "scn-1" } });
    screen.getByRole("button", { name: "검증 실행" }).click();
    await waitFor(() => expect(screen.getByText("정적 구조 검증 통과")).toBeInTheDocument());
    expect(screen.queryByText(/승격 가능/)).toBeNull(); // 거짓금지 회귀 가드(재유입 시 실패)
    const goto = await screen.findByRole("button", { name: /자동화 만들기에서 진행/ });
    goto.click();
    await waitFor(() => expect(location.hash).toBe("#scenarioStudio")); // navigate 실배선(죽은 버튼 아님)
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
    // errorLabel(계약 ERROR_CATALOG[RUN_ABORTED].userMessage 미러)로 통일 — 이전 'RUN_ABORTED (409)' raw 덤프 갱신(의도된 변경).
    await waitFor(() => expect(screen.getByText("실행이 중단되었습니다.")).toBeInTheDocument());
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
    expect(location.hash).toBe("#runTrace?run=run-1&focus=artifacts");
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
    // P0-3: raw url_ref 키("orders_url") 대신 운영자용 한국어 라벨로 노출.
    const field = await screen.findByLabelText("주문 페이지 주소");
    // 값 미입력 시 '실행 시작' 비활성(필수값 가드).
    expect(screen.getByRole("button", { name: "실행 시작" })).toBeDisabled();
    fireEvent.change(field, { target: { value: "https://shop.example/orders/9" } });
    screen.getByRole("button", { name: "실행 시작" }).click();
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.params).toEqual({ orders_url: "https://shop.example/orders/9" });
    expect(location.hash).toBe("#runTrace?run=run-2&focus=artifacts");
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
    const panel = screen.getByRole("region", { name: "세션 확인 실행" });
    const modelField = await within(panel).findByLabelText("AI 모델");
    expect(within(panel).getByText(/AI 모델을 지정해야 합니다/)).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "실행 시작" })).toBeDisabled(); // 모델 미입력 가드
    fireEvent.change(modelField, { target: { value: "gpt-4o-mini" } });
    // P0-3: 직타 모델은 getGatewayPolicy로 '확인'해야 실행 허용(맹목 입력 차단). 확인 전엔 여전히 비활성.
    expect(within(panel).getByRole("button", { name: "실행 시작" })).toBeDisabled();
    within(panel).getByRole("button", { name: "확인" }).click();
    await waitFor(() => expect(within(panel).getByRole("button", { name: "실행 시작" })).toBeEnabled());
    within(panel).getByRole("button", { name: "실행 시작" }).click(); // 2차 createRun(model)
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.model).toBe("gpt-4o-mini"); // 검증된 모델 전달
    expect(location.hash).toBe("#runTrace?run=run-3&focus=artifacts");
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

  test("사이트 등록 폼 → page_state_selectors 입력 전송", async () => {
    const calls: Array<{ body: Parameters<ApiClient["createSite"]>[0]; key: string }> = [];
    renderApp(
      fakeClient({
        listSites: async () => ({ items: [], next_cursor: null }),
        createSite: async (body, key) => {
          calls.push({ body, key });
          return { site_profile_id: "site-new" };
        },
      }),
    );
    location.hash = "#security";
    (await screen.findByRole("button", { name: "새 사이트" })).click();
    fireEvent.change(await screen.findByLabelText("이름"), { target: { value: "하이웍스" } });
    fireEvent.change(screen.getByLabelText("URL 패턴 (http/https origin)"), { target: { value: "https://login.office.hiworks.com" } });
    fireEvent.change(screen.getByLabelText("로그인 URL (선택)"), { target: { value: "https://login.office.hiworks.com" } });
    fireEvent.change(screen.getByLabelText("로그인 확인 selector (선택)"), { target: { value: ".user-menu" } });
    fireEvent.change(screen.getByLabelText("reviews_visible selector (선택)"), { target: { value: ".review-item" } });
    fireEvent.click(screen.getByRole("button", { name: "+ flag" }));
    fireEvent.change(screen.getByPlaceholderText("예: .pagination .disabled-next"), { target: { value: ".next.disabled" } });
    screen.getByRole("button", { name: "등록" }).click();
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.body.page_state_selectors).toEqual({
      loginUrl: "https://login.office.hiworks.com",
      authenticatedWhen: { selector: ".user-menu" },
      flags: {
        reviews_visible: { kind: "min_count", selector: ".review-item", n: 1 },
        no_next_page: { kind: "present", selector: ".next.disabled" },
      },
    });
    expect(calls[0]?.key.length).toBeGreaterThan(0);
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
    expect(screen.queryByRole("button", { name: "운영 지정" })).toBeNull(); // scenario.promote: admin만
  });
});
