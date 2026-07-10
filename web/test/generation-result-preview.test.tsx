import { describe, expect, test } from "vitest";
import { render, screen } from "@testing-library/react";
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

function renderResult(client: ApiClient, result: ScenarioGenerationResult): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ApiClientProvider client={client}>
        <GenerationResult
          result={result}
          correctionGuide={null}
          runPending={false}
          modelConfirmationRequired={false}
          onRunWithCorrections={() => undefined}
          onRevised={() => undefined}
          onFocusStartUrl={() => undefined}
          onFocusTarget={() => undefined}
          onOpenSiteCreate={() => undefined}
          onFocusParams={() => undefined}
          onDisableVideoEvidence={() => undefined}
          testAction={null}
        />
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
