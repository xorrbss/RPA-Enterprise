import { describe, expect, test } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import type { ApiClient } from "../src/api/client";
import { ApiClientProvider } from "../src/api/context";
import { ApiError, type ScenarioGenerationResult } from "../src/api/types";
import { ReviseControl } from "../src/components/easy-create/ReviseControl";
import { StepCards } from "../src/components/easy-create/StepCards";
import { FocusedScenarioStudio } from "../src/views/scenarios/FocusedScenarioStudio";
import { fakeClient } from "./fake-client";

// F2: 말로 고치기 — 성공/409/422 사유 문구, StepCards 변경 표시 오버레이, 스튜디오 설계 탭 안내 상태.

const IR = {
  start: "open",
  nodes: {
    open: { what: [{ action: "navigate", url_ref: "entry_url" }], next: "grab" },
    grab: { what: [{ action: "extract", instruction: "리뷰를 읽는다" }], terminal: "success" },
  },
};

function revisedResult(over: Partial<ScenarioGenerationResult> = {}): ScenarioGenerationResult {
  return {
    generation_id: "gen-rev-1",
    mode: "save",
    status: "saved",
    prompt_hash: "hash-rev",
    planner: "deterministic_mvp",
    model: null,
    scenario_id: "sc-1",
    scenario_version_id: "ver-2",
    run_id: null,
    evidence_policy: { screenshot: "failure", video: "never" },
    blockers: [],
    created_at: "2026-07-10T00:00:00.000Z",
    created_by: "operator",
    draft_ir: {
      start: "open",
      nodes: {
        open: { what: [{ action: "navigate", url_ref: "login_url" }], next: "save" },
        save: { what: [{ action: "act", instruction: "화면을 저장한다" }], terminal: "success" },
      },
    },
    validation_report: { errors: [], warnings: [] },
    ...over,
  };
}

function withProviders(client: ApiClient, ui: JSX.Element) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ApiClientProvider client={client}>{ui}</ApiClientProvider>
    </QueryClientProvider>,
  );
}

function submitInstruction(text: string): void {
  fireEvent.change(screen.getByRole("textbox", { name: "수정 요청 입력" }), { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "말로 고치기" }));
}

describe("ReviseControl (F2)", () => {
  test("성공: 화면이 본 version을 base_version으로 보내고 onRevised에 새 결과를 전달한다", async () => {
    const reviseCalls: Array<{ generationId: string; instruction: string; base_version: number }> = [];
    const revised: ScenarioGenerationResult[] = [];
    const client = fakeClient({
      getScenario: async (id) => ({ scenario_id: id, name: "리뷰 수집", version: 3, promotion_status: "draft", ir: IR }),
      reviseScenarioGeneration: async (generationId, body) => {
        reviseCalls.push({ generationId, instruction: body.instruction, base_version: body.base_version });
        return revisedResult();
      },
    });
    withProviders(client, <ReviseControl generationId="gen-1" scenarioId="sc-1" onRevised={(next) => revised.push(next)} />);

    await waitFor(() => expect(screen.getByRole("button", { name: "말로 고치기" })).toBeInTheDocument());
    submitInstruction("로그인한 다음 화면을 저장하는 단계도 넣어줘");

    await waitFor(() => expect(revised).toHaveLength(1));
    expect(reviseCalls).toEqual([
      { generationId: "gen-1", instruction: "로그인한 다음 화면을 저장하는 단계도 넣어줘", base_version: 3 },
    ]);
    expect(revised[0]?.generation_id).toBe("gen-rev-1");
    // 성공 후 입력은 비워진다.
    expect(screen.getByRole("textbox", { name: "수정 요청 입력" })).toHaveValue("");
  });

  test("빈 입력은 API 호출 없이 문장으로 안내한다", async () => {
    let called = 0;
    const client = fakeClient({
      getScenario: async (id) => ({ scenario_id: id, name: "s", version: 1, promotion_status: "draft" }),
      reviseScenarioGeneration: async () => {
        called += 1;
        return revisedResult();
      },
    });
    withProviders(client, <ReviseControl generationId="gen-1" scenarioId="sc-1" onRevised={() => undefined} />);
    fireEvent.click(await screen.findByRole("button", { name: "말로 고치기" }));
    expect(await screen.findByText("수정할 내용을 입력해 주세요.")).toBeInTheDocument();
    expect(called).toBe(0);
  });

  test("412 동시 수정: 충돌 문구와 재조회 버튼을 보여준다 (분기=에러 코드 기준)", async () => {
    const client = fakeClient({
      getScenario: async (id) => ({ scenario_id: id, name: "s", version: 1, promotion_status: "draft" }),
      reviseScenarioGeneration: async () => {
        // F1 확정 계약: HTTP 412 + SCENARIO_VERSION_CONFLICT(details.reason=base_version_mismatch).
        throw new ApiError(412, "SCENARIO_VERSION_CONFLICT", {
          code: "SCENARIO_VERSION_CONFLICT",
          details: { reason: "base_version_mismatch", currentVersion: 2 },
        });
      },
    });
    withProviders(client, <ReviseControl generationId="gen-1" scenarioId="sc-1" onRevised={() => undefined} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "말로 고치기" })).toBeInTheDocument());
    submitInstruction("단계를 하나 더");

    expect(
      await screen.findByText(/다른 곳에서 이 자동화가 먼저 수정되었습니다\. 최신 내용을 불러온 뒤 다시 시도해 주세요\./),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "최신 내용 다시 불러오기" })).toBeInTheDocument();
  });

  test("422 prompt_not_retained: 입력 대신 안내 행 + 만들기 홈 링크", async () => {
    const client = fakeClient({
      getScenario: async (id) => ({ scenario_id: id, name: "s", version: 1, promotion_status: "draft" }),
      reviseScenarioGeneration: async () => {
        throw new ApiError(422, "IR_SCHEMA_INVALID", {
          code: "IR_SCHEMA_INVALID",
          details: { reason: "prompt_not_retained" },
        });
      },
    });
    withProviders(client, <ReviseControl generationId="gen-1" scenarioId="sc-1" onRevised={() => undefined} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "말로 고치기" })).toBeInTheDocument());
    submitInstruction("단계를 하나 더");

    expect(
      await screen.findByText(
        /이 자동화는 원본 요청이 저장되기 전에 만들어져 말로 고치기를 쓸 수 없습니다\. 요청을 새로 입력해 다시 만들어 주세요\./,
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "만들기 홈으로" })).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "수정 요청 입력" })).toBeNull();
  });

  test("422 scenario_not_persisted: 저장 전 초안 안내 문구", async () => {
    const client = fakeClient({
      getScenario: async (id) => ({ scenario_id: id, name: "s", version: 1, promotion_status: "draft" }),
      reviseScenarioGeneration: async () => {
        throw new ApiError(422, "IR_SCHEMA_INVALID", {
          code: "IR_SCHEMA_INVALID",
          details: { reason: "scenario_not_persisted" },
        });
      },
    });
    withProviders(client, <ReviseControl generationId="gen-1" scenarioId="sc-1" onRevised={() => undefined} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "말로 고치기" })).toBeInTheDocument());
    submitInstruction("단계를 하나 더");

    expect(
      await screen.findByText(/이 초안은 아직 자동화로 저장되지 않아 말로 고치기를 쓸 수 없습니다\./),
    ).toBeInTheDocument();
  });

  test("422 instruction_required: 서버 판정도 같은 문장으로 표기한다", async () => {
    const client = fakeClient({
      getScenario: async (id) => ({ scenario_id: id, name: "s", version: 1, promotion_status: "draft" }),
      reviseScenarioGeneration: async () => {
        throw new ApiError(422, "IR_SCHEMA_INVALID", {
          code: "IR_SCHEMA_INVALID",
          details: { reason: "instruction_required" },
        });
      },
    });
    withProviders(client, <ReviseControl generationId="gen-1" scenarioId="sc-1" onRevised={() => undefined} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "말로 고치기" })).toBeInTheDocument());
    submitInstruction("...");

    expect(await screen.findByText("수정할 내용을 입력해 주세요.")).toBeInTheDocument();
  });

  test("422 instruction_too_long: 길이 초과 사유를 문장으로 표기한다", async () => {
    const client = fakeClient({
      getScenario: async (id) => ({ scenario_id: id, name: "s", version: 1, promotion_status: "draft" }),
      reviseScenarioGeneration: async () => {
        throw new ApiError(422, "IR_SCHEMA_INVALID", {
          code: "IR_SCHEMA_INVALID",
          details: { reason: "instruction_too_long" },
        });
      },
    });
    withProviders(client, <ReviseControl generationId="gen-1" scenarioId="sc-1" onRevised={() => undefined} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "말로 고치기" })).toBeInTheDocument());
    submitInstruction("단계를 하나 더");

    expect(await screen.findByText("수정 요청이 너무 깁니다. 2,000자 이내로 줄여 주세요.")).toBeInTheDocument();
  });

  test("422 prompt_too_long: 누적 길이 초과 사유를 문장으로 표기한다", async () => {
    const client = fakeClient({
      getScenario: async (id) => ({ scenario_id: id, name: "s", version: 1, promotion_status: "draft" }),
      reviseScenarioGeneration: async () => {
        throw new ApiError(422, "IR_SCHEMA_INVALID", {
          code: "IR_SCHEMA_INVALID",
          details: { reason: "prompt_too_long" },
        });
      },
    });
    withProviders(client, <ReviseControl generationId="gen-1" scenarioId="sc-1" onRevised={() => undefined} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "말로 고치기" })).toBeInTheDocument());
    submitInstruction("단계를 하나 더");

    expect(
      await screen.findByText(/누적된 수정 요청이 너무 길어 말로 고치기를 계속할 수 없습니다\./),
    ).toBeInTheDocument();
  });

  test("scenario_id 없는 초안(draft_only)은 입력 대신 사유 문장", () => {
    withProviders(fakeClient(), <ReviseControl generationId="gen-1" scenarioId={null} onRevised={() => undefined} />);
    expect(
      screen.getByText(/이 초안은 아직 자동화로 저장되지 않아 말로 고치기를 쓸 수 없습니다\./),
    ).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "수정 요청 입력" })).toBeNull();
  });
});

describe("StepCards 변경 표시 오버레이 (F2)", () => {
  test("changeMarks·빠진 단계 요약·전면 교체 안내를 렌더한다", () => {
    render(
      <StepCards
        ir={IR}
        changeMarks={new Map([["open", "added" as const], ["grab", "changed" as const]])}
        removedCount={2}
        fullReplacement
      />,
    );
    expect(screen.getByText("새 단계")).toBeInTheDocument();
    expect(screen.getByText("달라진 단계")).toBeInTheDocument();
    expect(screen.getByText("이전 초안에서 빠진 단계 2개")).toBeInTheDocument();
    expect(screen.getByText("이전 초안과 이어지지 않아 전체가 새 단계로 표시됩니다.")).toBeInTheDocument();
  });

  test("changeMarks 없이 렌더하면 변경 배지·요약이 없다(추정 표기 금지)", () => {
    render(<StepCards ir={IR} />);
    expect(screen.queryByText("새 단계")).toBeNull();
    expect(screen.queryByText("달라진 단계")).toBeNull();
    expect(screen.queryByText(/이전 초안에서 빠진 단계/)).toBeNull();
  });
});

describe("StepCards 종결 카드 배지 중복 억제 (N4)", () => {
  test("terminal 전용 카드는 문장과 배지가 같은 말('완료합니다')을 반복하지 않는다", () => {
    render(
      <StepCards
        ir={{
          start: "open",
          nodes: {
            open: { what: [{ action: "act", instruction: "화면을 연다" }], next: "done" },
            done: { terminal: "success" },
          },
        }}
      />,
    );
    // 흐름 전용 노드는 흐름 라벨이 곧 문장 — 배지까지 겹치면 같은 말 2회. 문장 1회만 남아야 한다.
    expect(screen.getAllByText("완료합니다")).toHaveLength(1);
  });

  test("동작 있는 노드의 흐름 배지는 유지된다(문장≠배지, 과억제 금지)", () => {
    render(<StepCards ir={IR} />);
    expect(screen.getByText("리뷰를 읽는다")).toBeInTheDocument();
    expect(screen.getByText("완료합니다")).toBeInTheDocument(); // grab 카드의 종결 흐름 배지
  });
});

const STUDIO_SCENARIO = { scenario_id: "sc-1", name: "리뷰 수집", version: 2, latest_version_id: "ver-1" };

function renderStudio(client: ApiClient): void {
  withProviders(
    client,
    <FocusedScenarioStudio
      scenario={STUDIO_SCENARIO}
      requestedScenarioId="sc-1"
      latestRun={null}
      recentRuns={[]}
      loading={false}
      canCreateRun
      canReadEvidence
      canUpdateScenario
      onTest={() => undefined}
      onEvidence={() => undefined}
      onEdit={() => undefined}
      onVersions={() => undefined}
      onReleases={() => undefined}
      onExit={() => undefined}
    />,
  );
}

describe("FocusedScenarioStudio 설계 탭 말로 고치기 (F2)", () => {
  test("생성 기록이 없으면 입력 대신 사유 문장 + 만들기 홈 딥링크", async () => {
    // 기본 fake의 generation은 scenario_id가 달라 scenario_id 필터에 걸리지 않는다 → 기록 없음 경로.
    renderStudio(
      fakeClient({
        getScenario: async (id) => ({ scenario_id: id, name: "리뷰 수집", version: 2, promotion_status: "draft", ir: IR }),
      }),
    );
    expect(
      await screen.findByText(/이 자동화에는 말로 만든 요청 기록이 없어 말로 고치기를 쓸 수 없습니다\./),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "만들기 홈에서 새 요청으로 만들기" })).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "수정 요청 입력" })).toBeNull();
  });

  test("revise 변경 표시는 저장본끼리(v1 vs v2) 비교한다 — 마스킹 차이로 인한 가짜 changed 없음(N1)", async () => {
    // 저장본 v2: open·grab 은 v1 과 내용 동일(instruction 원문 유지), save 만 추가.
    // 응답 draft_ir 은 instruction 이 redaction 토큰으로 마스킹돼 있어, 예전처럼 저장본 v1 과 응답을
    // 비교하면 grab 이 마스킹 차이만으로 "달라진 단계"가 된다(가짜 변경). 저장본끼리 비교가 정답.
    const SAVED_V2 = {
      start: "open",
      nodes: {
        ...IR.nodes,
        save: { what: [{ action: "act", instruction: "화면을 저장한다" }], terminal: "success" },
      },
    };
    const REDACTED_RESPONSE_IR = {
      start: "open",
      nodes: {
        open: IR.nodes.open,
        grab: { what: [{ action: "extract", instruction: "[REDACTED:scenario_generation_instruction]" }], terminal: "success" },
        save: { what: [{ action: "act", instruction: "[REDACTED:scenario_generation_instruction]" }], terminal: "success" },
      },
    };
    let savedIr: unknown = IR;
    let savedVersion = 2;
    const client = fakeClient({
      getScenario: async (id) => ({ scenario_id: id, name: "리뷰 수집", version: savedVersion, promotion_status: "draft", ir: savedIr }),
      listScenarioGenerations: async (p) => ({
        items:
          p?.scenario_id === undefined || p.scenario_id === "sc-1"
            ? [revisedResult({ generation_id: "gen-base", scenario_id: "sc-1", draft_ir: REDACTED_RESPONSE_IR })]
            : [],
        next_cursor: null,
      }),
      reviseScenarioGeneration: async () => {
        savedIr = SAVED_V2;
        savedVersion = 3;
        return revisedResult({ scenario_id: "sc-1", draft_ir: REDACTED_RESPONSE_IR });
      },
    });
    renderStudio(client);

    await waitFor(() => expect(screen.getByRole("button", { name: "말로 고치기" })).toBeInTheDocument());
    submitInstruction("화면을 저장하는 단계도 넣어줘");

    // 저장본 v2 refetch 후: save 만 "새 단계", 카드 문장은 저장본(비마스킹) 원문.
    expect(await screen.findByText("새 단계")).toBeInTheDocument();
    expect(screen.getByText("화면을 저장한다")).toBeInTheDocument();
    // 동일 노드(open·grab)는 무표시 — 응답 마스킹과 비교했다면 생겼을 가짜 changed 가 없다.
    expect(screen.queryByText("달라진 단계")).toBeNull();
    expect(screen.queryByText(/이전 초안에서 빠진 단계/)).toBeNull();
  });
});
