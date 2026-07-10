import { useState } from "react";
import { describe, expect, test } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import type { ApiClient } from "../src/api/client";
import { ApiClientProvider } from "../src/api/context";
import type { ScenarioGenerationResult } from "../src/api/types";
import { GenerationResult } from "../src/components/prompt-generator/GenerationResult";
import { fakeClient } from "./fake-client";

// N1: 생성 직후 미리보기의 렌더 소스 — 저장 완료(scenario_id 있음)면 저장본 IR(getScenario),
// draft_only(scenario_id null)면 현행 응답 draft_ir. 응답 draft_ir 은 서버가 instruction 을
// redaction 하므로 "[REDACTED:…]" 토큰이 카드 문장에 노출되던 결함의 회귀 가드.

const REDACTED_TOKEN = "[REDACTED:scenario_generation_instruction]";

const REDACTED_DRAFT_IR = {
  start: "understand_request",
  nodes: {
    understand_request: { what: [{ action: "observe", instruction: REDACTED_TOKEN }], next: "done" },
    done: { terminal: "success" },
  },
};

const SAVED_IR = {
  start: "understand_request",
  nodes: {
    understand_request: { what: [{ action: "observe", instruction: "하이웍스 결재 대기 문서를 확인해줘" }], next: "done" },
    done: { terminal: "success" },
  },
};

function generationResult(over: Partial<ScenarioGenerationResult> = {}): ScenarioGenerationResult {
  return {
    generation_id: "gen-n1-1",
    mode: "save",
    status: "saved",
    prompt_hash: "hash",
    planner: "deterministic_mvp",
    model: null,
    scenario_id: "sc-1",
    scenario_version_id: "ver-1",
    run_id: null,
    evidence_policy: { screenshot: "failure", video: "never" },
    blockers: [],
    created_at: "2026-07-10T00:00:00.000Z",
    created_by: "operator",
    draft_ir: REDACTED_DRAFT_IR,
    validation_report: { errors: [], warnings: [] },
    ...over,
  };
}

// 소비처(PromptScenarioGenerator)와 동일하게 onRevised 가 result 를 교체한다 — revise 흐름 검증용 호스트.
function ResultHost({ initial }: { initial: ScenarioGenerationResult }): JSX.Element {
  const [result, setResult] = useState(initial);
  return (
    <GenerationResult
      result={result}
      correctionGuide={null}
      runPending={false}
      modelConfirmationRequired={false}
      onRunWithCorrections={() => undefined}
      onRevised={setResult}
      onFocusStartUrl={() => undefined}
      onFocusTarget={() => undefined}
      onOpenSiteCreate={() => undefined}
      onFocusParams={() => undefined}
      onDisableVideoEvidence={() => undefined}
      testAction={null}
    />
  );
}

function renderResult(client: ApiClient, result: ScenarioGenerationResult): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ApiClientProvider client={client}>
        <ResultHost initial={result} />
      </ApiClientProvider>
    </QueryClientProvider>,
  );
}

describe("GenerationResult 초안 미리보기 렌더 소스 (N1)", () => {
  test("저장 완료 결과는 저장본 IR 로 렌더 — REDACTED 토큰이 화면에 남지 않는다", async () => {
    renderResult(
      fakeClient({
        getScenario: async (id) => ({ scenario_id: id, name: "결재 확인", version: 1, promotion_status: "draft", ir: SAVED_IR }),
      }),
      generationResult(),
    );

    expect(await screen.findByText("화면을 확인합니다 — 하이웍스 결재 대기 문서를 확인해줘")).toBeInTheDocument();
    expect(screen.queryByText(/REDACTED/)).toBeNull();
  });

  test("draft_only(scenario_id null)는 현행 응답 draft_ir 렌더 유지 — 토큰은 표시 계층 번역으로 보호", () => {
    renderResult(fakeClient(), generationResult({ scenario_id: null, scenario_version_id: null }));

    // 저장본이 없으므로 응답 draft_ir 을 그대로 렌더하되, step-sentences 안전망이 토큰을 한국어로 치환한다.
    expect(screen.getByText("화면을 확인합니다 — 보호된 요청 내용")).toBeInTheDocument();
    expect(screen.queryByText(/REDACTED/)).toBeNull();
  });

  test("저장본 조회 실패는 조용한 폴백 없이 문장으로 표기한다", async () => {
    renderResult(
      fakeClient({
        getScenario: async () => {
          throw new Error("forbidden");
        },
      }),
      generationResult(),
    );

    expect(
      await screen.findByText("저장된 자동화 단계를 불러오지 못했습니다 — 새로고침 후 다시 확인해 주세요."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/REDACTED/)).toBeNull();
  });
});

describe("GenerationResult revise 변경 표시 — 저장본끼리 비교 승격 (#453 한계 해소)", () => {
  test("저장 완료: instruction 만 바뀐 revise 도 '달라진 단계'로 표시된다(응답끼리 비교였으면 무표시)", async () => {
    // 저장본 v2 는 v1 과 노드 집합이 같고 understand_request 의 instruction 만 다르다.
    // 응답 draft_ir 은 revise 전후 모두 동일한 REDACTED 토큰(서버가 instruction 을 마스킹) —
    // 예전처럼 응답끼리 비교하면 양쪽이 같아 무표시가 되던 정확한 시나리오다.
    const SAVED_IR_V2 = {
      start: "understand_request",
      nodes: {
        understand_request: { what: [{ action: "observe", instruction: "하이웍스 결재 반려 문서를 확인해줘" }], next: "done" },
        done: { terminal: "success" },
      },
    };
    let savedIr: unknown = SAVED_IR;
    let savedVersion = 1;
    renderResult(
      fakeClient({
        getScenario: async (id) => ({ scenario_id: id, name: "결재 확인", version: savedVersion, promotion_status: "draft", ir: savedIr }),
        reviseScenarioGeneration: async () => {
          savedIr = SAVED_IR_V2;
          savedVersion = 2;
          return generationResult({ generation_id: "gen-n1-2" });
        },
      }),
      generationResult(),
    );

    // 저장본 v1 로드 완료(말로 고치기의 base_version 확보) 후 수정 요청 제출.
    expect(await screen.findByText("화면을 확인합니다 — 하이웍스 결재 대기 문서를 확인해줘")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "수정 요청 입력" }), { target: { value: "반려 문서로 바꿔줘" } });
    fireEvent.click(screen.getByRole("button", { name: "말로 고치기" }));

    // 저장본 v2 refetch 도착 후 저장본끼리 diff: instruction 변경이 "달라진 단계"로 표시된다.
    expect(await screen.findByText("달라진 단계")).toBeInTheDocument();
    expect(screen.getByText("화면을 확인합니다 — 하이웍스 결재 반려 문서를 확인해줘")).toBeInTheDocument();
    // 노드 집합이 같으므로 "새 단계"·빠진 단계 요약은 없어야 한다(v1 스냅샷 누락 시 전부 added 로 새는 회귀 가드).
    expect(screen.queryByText("새 단계")).toBeNull();
    expect(screen.queryByText(/이전 초안에서 빠진 단계/)).toBeNull();
    expect(screen.queryByText(/REDACTED/)).toBeNull();
  });

  test("draft_only(scenario_id null) 회귀: 말로 고치기는 저장 안내 문장으로 막히고 변경 배지는 없다", () => {
    renderResult(fakeClient(), generationResult({ scenario_id: null, scenario_version_id: null }));

    // 저장본이 없으므로 revise 폼 대신 사유 문장 — 응답끼리 비교 경로는 그대로(가짜 변경 없음).
    expect(
      screen.getByText(/이 초안은 아직 자동화로 저장되지 않아 말로 고치기를 쓸 수 없습니다\./),
    ).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "수정 요청 입력" })).toBeNull();
    expect(screen.getByText("화면을 확인합니다 — 보호된 요청 내용")).toBeInTheDocument();
    expect(screen.queryByText("달라진 단계")).toBeNull();
    expect(screen.queryByText("새 단계")).toBeNull();
  });
});
