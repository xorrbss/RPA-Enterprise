import { beforeEach, describe, expect, test } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { App } from "../src/App";
import { ApiClientProvider } from "../src/api/context";
import type { ApiClient } from "../src/api/client";
import { fakeClient } from "./fake-client";

// F3: 만들기 홈 원패스 셸 — phase 매트릭스(잔여 설계 §3.3) 가드.
// IDLE=홈 섹션 접힌 요약, GENERATING=폼 잠금+나머지 숨김, PREVIEW=접힌 요약+결과가 주인공,
// TESTING=화면 이동 없이 TestProgress 홈 내 렌더. 새로고침 시 IDLE 복귀는 수용(YAGNI 결정).

function jwt(roles: readonly string[]): string {
  const payload = btoa(JSON.stringify({ sub: "u", tenant_id: "t", roles })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `e30.${payload}.sig`;
}

function renderApp(client: ApiClient): QueryClient {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ApiClientProvider client={client}>
        <App />
      </ApiClientProvider>
    </QueryClientProvider>,
  );
  return qc;
}

const SCENARIO_ID = "00000000-0000-0000-0000-0000000000c1";
const SCENARIO_ITEM = { scenario_id: SCENARIO_ID, name: "주문 확인", version: 1, latest_version_id: "00000000-0000-0000-0000-0000000000c2" };

function detailsOf(summaryText: string): HTMLDetailsElement {
  const matches = Array.from(document.querySelectorAll("details")).filter((details) =>
    details.querySelector("summary")?.textContent?.includes(summaryText),
  );
  if (matches.length !== 1) throw new Error(`expected 1 details for "${summaryText}", found ${matches.length}`);
  return matches[0] as HTMLDetailsElement;
}

async function submitDraft(): Promise<void> {
  fireEvent.change(await screen.findByLabelText("자연어 요청"), { target: { value: "주문 목록을 확인해줘" } });
  const submit = screen.getByRole("button", { name: "자동화 초안 만들기" });
  await waitFor(() => expect(submit).not.toBeDisabled());
  fireEvent.click(submit);
}

describe("create one-pass shell (F3)", () => {
  beforeEach(() => {
    localStorage.clear();
    location.hash = "";
    localStorage.setItem("rpa.token", jwt(["operator", "admin"]));
  });

  test("IDLE: 워크벤치·녹화·준비 단계가 접힌 요약(details 닫힘)으로 렌더된다", async () => {
    location.hash = "#create";
    renderApp(fakeClient());

    expect(await screen.findByRole("region", { name: "자동화 시작 방식" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "만들기 기본 경로" })).toBeInTheDocument();
    expect(detailsOf("기존 자동화 테스트").open).toBe(false);
    expect(detailsOf("브라우저 녹화로 만들기").open).toBe(false);
    // 준비 단계: blocker 없음(빈 사이트=needs) → 접힌 요약 유지 + 요약에 다음 액션 표기.
    const corridor = detailsOf("준비됨");
    expect(corridor.open).toBe(false);
    expect(corridor).toHaveTextContent("자동화 준비 단계");
  });

  test("IDLE: 준비 단계 blocker(미승인 사이트만 존재) 관측 시 자동 펼침", async () => {
    location.hash = "#create";
    renderApp(
      fakeClient({
        listSites: async () => ({
          items: [
            { site_profile_id: "10000000-0000-4000-8000-0000000000a1", name: "미승인 포털", url_pattern: "https://p.example", risk: "amber", approval_status: "pending", circuit_status: "closed" },
          ],
          next_cursor: null,
        }),
      }),
    );

    await screen.findByText("등록된 사이트가 있지만 아직 승인된 실행 대상은 없습니다.");
    await waitFor(() => expect(detailsOf("차단 있음").open).toBe(true));
  });

  test("GENERATING: 입력 폼 잠금+진행 표시, 나머지 섹션 숨김", async () => {
    location.hash = "#create";
    let release: () => void = () => {};
    renderApp(
      fakeClient({
        generateScenario: () =>
          new Promise((resolve) => {
            release = () =>
              resolve({
                generation_id: "00000000-0000-0000-0000-0000000000a1",
                mode: "save",
                status: "saved",
                prompt_hash: "hash",
                planner: "deterministic_mvp",
                model: null,
                scenario_id: SCENARIO_ID,
                scenario_version_id: "00000000-0000-0000-0000-0000000000c2",
                run_id: null,
                evidence_policy: { screenshot: "each_step", video: "never" },
                blockers: [],
                created_at: "2026-07-10T00:00:00.000Z",
                created_by: "operator",
                draft_ir: {},
                validation_report: {},
              });
          }),
      }),
    );

    await submitDraft();

    expect(await screen.findByText(/초안을 만드는 중입니다/)).toBeInTheDocument();
    expect(screen.getByLabelText("자연어 요청")).toBeDisabled(); // fieldset disabled 잠금
    // phase 통지(effect)가 홈 게이팅에 반영되는 한 렌더 뒤까지 대기 후 부재를 단언한다.
    await waitFor(() => expect(screen.queryByRole("region", { name: "만들기 기본 경로" })).toBeNull());
    expect(screen.queryByRole("region", { name: "자동화 시작 방식" })).toBeNull();
    expect(screen.queryByText("기존 자동화 테스트")).toBeNull();
    expect(screen.queryByText("최근 생성 이력·다음 액션 보기")).toBeNull();
    release();
    await screen.findByText("초안 미리보기");
  });

  test("PREVIEW: 폼은 접힌 요약(요청 고치기)으로, 홈 섹션은 숨고 결과가 주인공", async () => {
    location.hash = "#create";
    renderApp(fakeClient());

    await submitDraft();

    expect(await screen.findByText("초안 미리보기")).toBeInTheDocument();
    // 입력 폼 접힘 — 요약에 요청문 1줄.
    const form = detailsOf("요청 고치기");
    expect(form.open).toBe(false);
    expect(form).toHaveTextContent("주문 목록을 확인해줘");
    // 매트릭스: JourneyHeader/Chooser/갤러리/준비 단계/워크벤치/녹화 숨김.
    // phase 통지(effect)가 홈 게이팅에 반영되는 한 렌더 뒤까지 대기 후 부재를 단언한다.
    await waitFor(() => expect(screen.queryByRole("region", { name: "만들기 기본 경로" })).toBeNull());
    expect(screen.queryByRole("region", { name: "자동화 시작 방식" })).toBeNull();
    expect(screen.queryByRole("region", { name: "템플릿에서 시작" })).toBeNull();
    expect(screen.queryByRole("region", { name: "자동화 준비 단계" })).toBeNull();
    expect(screen.queryByText("기존 자동화 테스트")).toBeNull();
    expect(screen.queryByText("브라우저 녹화로 만들기")).toBeNull();
    // 목록 미동기화 상태의 테스트 CTA 는 사유를 문장으로(조용한 부재 금지 — 기본 fake 목록은 빈 목록).
    expect(screen.getByText(/테스트 실행 준비 중/)).toBeInTheDocument();
  });

  test("PREVIEW: F2 말로 고치기(ReviseControl)·변경 표시가 원패스 셸에서 유실되지 않는다", async () => {
    location.hash = "#create";
    const baseIr = {
      start: "a",
      nodes: {
        a: { what: [{ action: "observe", instruction: "원래 단계" }], next: "b" },
        b: { what: [{ action: "extract", instruction: "지워질 단계" }], terminal: "success" },
      },
    };
    const revisedIr = {
      start: "a",
      nodes: { a: { what: [{ action: "observe", instruction: "고쳐진 단계" }], terminal: "success" } },
    };
    const generation = {
      generation_id: "00000000-0000-0000-0000-0000000000a1",
      mode: "save" as const,
      status: "saved" as const,
      prompt_hash: "hash",
      planner: "deterministic_mvp" as const,
      model: null,
      scenario_id: SCENARIO_ID,
      scenario_version_id: "00000000-0000-0000-0000-0000000000c2",
      run_id: null,
      evidence_policy: { screenshot: "each_step" as const, video: "never" as const },
      blockers: [],
      created_at: "2026-07-10T00:00:00.000Z",
      created_by: "operator",
      validation_report: {},
    };
    const qc = renderApp(
      fakeClient({
        generateScenario: async () => ({ ...generation, draft_ir: baseIr }),
        reviseScenarioGeneration: async () => ({
          ...generation,
          generation_id: "00000000-0000-0000-0000-0000000000a2",
          scenario_version_id: "00000000-0000-0000-0000-0000000000c3",
          draft_ir: revisedIr,
        }),
      }),
    );

    await submitDraft();
    await screen.findByText("초안 미리보기");

    // PREVIEW 주인공 화면에 말로 고치기 입력이 살아 있다(F2 배선 보존).
    // base_version 조회(scenario-detail)가 로드된 뒤에 제출해야 한다(ReviseControl 은 버전 미확인 시 정직 거절).
    await waitFor(() => expect(qc.getQueryData(["scenario-detail", SCENARIO_ID])).toBeDefined());
    fireEvent.change(screen.getByLabelText("수정 요청 입력"), { target: { value: "b 단계는 빼줘" } });
    fireEvent.click(screen.getByRole("button", { name: "말로 고치기" }));

    // 새 초안으로 교체 + 변경 표시(달라진 단계 배지·빠진 단계 요약)가 겹친다.
    expect(await screen.findByText(/고쳐진 단계/)).toBeInTheDocument();
    expect(screen.getByText("달라진 단계")).toBeInTheDocument();
    expect(screen.getByText("이전 초안에서 빠진 단계 1개")).toBeInTheDocument();
    // revise 후에도 PREVIEW 유지 — 폼은 접힌 요약, 홈 섹션은 계속 숨김.
    expect(detailsOf("요청 고치기").open).toBe(false);
    expect(screen.queryByRole("region", { name: "만들기 기본 경로" })).toBeNull();
  });

  test("TESTING: 테스트 실행이 화면 이동 없이 홈 안 TestProgress 로 이어진다", async () => {
    location.hash = "#create";
    renderApp(
      fakeClient({
        listScenarios: async () => ({ items: [SCENARIO_ITEM], next_cursor: null }),
        createRun: async () => ({ run_id: "run-f3-1", status: "queued", run_mode: "test", as_of: null }),
        getRun: async (id) => ({ run_id: id, status: "running", run_mode: "test", worker_id: null, attempts: 1, as_of: null, failure_reason: null }),
        listRunSteps: async () => ({ items: [], next_cursor: null }),
      }),
    );

    await submitDraft();
    await screen.findByText("초안 미리보기");

    fireEvent.click(await screen.findByRole("button", { name: "실행" }));
    fireEvent.click(await screen.findByRole("button", { name: "실행 시작" }));

    expect(await screen.findByText("실행 중입니다 — 단계가 실시간으로 갱신됩니다.")).toBeInTheDocument();
    expect(location.hash).toContain("#create"); // 화면을 튕기지 않는다
    expect(screen.getByText("초안 미리보기")).toBeInTheDocument(); // PREVIEW 결과 상단 유지
  });

  test("focus=test 딥링크는 접힌 워크벤치를 자동으로 펼친다(무음 no-op 금지)", async () => {
    location.hash = `#create?scenario=${SCENARIO_ID}&focus=test`;
    renderApp(fakeClient({ listScenarios: async () => ({ items: [SCENARIO_ITEM], next_cursor: null }) }));

    await screen.findByText("기존 자동화 테스트");
    await waitFor(() => expect(detailsOf("기존 자동화 테스트").open).toBe(true));
  });
});
