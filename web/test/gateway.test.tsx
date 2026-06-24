import { beforeEach, describe, expect, test } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { App } from "../src/App";
import { ApiClientProvider } from "../src/api/context";
import type { ApiClient } from "../src/api/client";
import type { GatewayPolicyUpdate } from "../src/api/types";
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

function jwt(roles: readonly string[]): string {
  const payload = btoa(JSON.stringify({ sub: "u", tenant_id: "t", roles })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `e30.${payload}.sig`;
}

const ALL_ROLES = ["viewer", "operator", "reviewer", "approver", "admin"];
const POLICIES = [
  {
    model: "gpt-4o",
    version: 5,
    capabilities: { maxContextTokens: 8000, jsonMode: true },
    budget: { maxInputTokens: 800, maxOutputTokens: 400, maxCost: 1 },
    is_default: true,
  },
  {
    model: "gpt-4o-mini",
    version: 2,
    capabilities: { maxContextTokens: 4000, jsonMode: true },
    budget: { maxInputTokens: 400, maxOutputTokens: 200, maxCost: 0.5 },
    is_default: false,
  },
];

describe("LLM 게이트웨이 정책 — 목록·기본·CRUD", () => {
  beforeEach(() => {
    location.hash = "";
    localStorage.setItem("rpa.token", jwt(ALL_ROLES));
  });

  test("admin gateway 정책 편집: 목록 선택 정책을 PUT If-Match(version)+Idempotency-Key로 저장", async () => {
    const calls: Array<{ version: number; body: GatewayPolicyUpdate; key: string }> = [];
    renderApp(
      fakeClient({
        listGatewayPolicies: async () => ({ items: POLICIES, next_cursor: null }),
        updateGatewayPolicy: async (version, body, key) => {
          calls.push({ version, body, key });
          return { model: body.model, version: version + 1 };
        },
      }),
    );
    location.hash = "#llmGateway";
    const saveBtn = await screen.findByRole("button", { name: "정책 저장" });
    saveBtn.click();
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.version).toBe(5);
    expect(calls[0]?.body.model).toBe("gpt-4o");
    expect(calls[0]?.body.is_default).toBe(true);
    expect(calls[0]?.key.length).toBeGreaterThan(0);
    await waitFor(() => expect(screen.getByText("저장됨")).toBeInTheDocument());
  });

  test("RBAC UI 게이팅: gateway 편집은 admin만 — operator는 목록만 표시", async () => {
    localStorage.setItem("rpa.token", jwt(["operator"]));
    renderApp(fakeClient({ listGatewayPolicies: async () => ({ items: POLICIES, next_cursor: null }) }));
    location.hash = "#llmGateway";
    await waitFor(() => expect(screen.getAllByText("gpt-4o").length).toBeGreaterThan(0));
    expect(screen.getAllByText("기본 정책").length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "정책 저장" })).toBeNull();
    expect(screen.queryByRole("button", { name: "정책 생성" })).toBeNull();
  });

  test("admin gateway 편집: 버전 충돌 → POLICY_VERSION_CONFLICT 표면화", async () => {
    const { ApiError } = await import("../src/api/types");
    renderApp(
      fakeClient({
        listGatewayPolicies: async () => ({ items: POLICIES, next_cursor: null }),
        updateGatewayPolicy: async () => {
          throw new ApiError(412, "POLICY_VERSION_CONFLICT", { code: "POLICY_VERSION_CONFLICT" });
        },
      }),
    );
    location.hash = "#llmGateway";
    (await screen.findByRole("button", { name: "정책 저장" })).click();
    await waitFor(() => expect(screen.getByText(/정책 버전 충돌\. 최신 정책을 다시 불러오세요\./)).toBeInTheDocument());
  });

  test("목록에서 모델 선택 → 해당 version으로 삭제", async () => {
    const calls: Array<{ model: string; version: number; key: string }> = [];
    renderApp(
      fakeClient({
        listGatewayPolicies: async () => ({ items: POLICIES, next_cursor: null }),
        deleteGatewayPolicy: async (model, version, key) => {
          calls.push({ model, version, key });
          return { model, deleted: true };
        },
      }),
    );
    location.hash = "#llmGateway";
    const selectButtons = await screen.findAllByRole("button", { name: "선택" });
    const selectMini = selectButtons[0];
    if (selectMini === undefined) throw new Error("expected selectable secondary policy");
    selectMini.click();
    await waitFor(() => expect(screen.getByText(/AI 모델 gpt-4o-mini · 변경 2/)).toBeInTheDocument());
    screen.getByRole("button", { name: "정책 삭제" }).click();
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.model).toBe("gpt-4o-mini");
    expect(calls[0]?.version).toBe(2);
    expect(calls[0]?.key.length).toBeGreaterThan(0);
  });

  test("새 정책 생성: 구조화 설정 + 기본 정책 플래그 전송", async () => {
    const calls: Array<{ body: GatewayPolicyUpdate; key: string }> = [];
    renderApp(
      fakeClient({
        listGatewayPolicies: async () => ({ items: POLICIES.slice(0, 1), next_cursor: null }),
        createGatewayPolicy: async (body, key) => {
          calls.push({ body, key });
          return { model: body.model, version: 1 };
        },
      }),
    );
    location.hash = "#llmGateway";
    fireEvent.change(await screen.findByLabelText("AI 모델"), { target: { value: "gpt-4.1-mini" } });
    fireEvent.click(screen.getByLabelText("기본 정책으로 생성"));
    screen.getByRole("button", { name: "정책 생성" }).click();
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.body.model).toBe("gpt-4.1-mini");
    expect(calls[0]?.body.capabilities.maxContextTokens).toBe(8000);
    expect(calls[0]?.body.budget.maxInputTokens).toBe(1000);
    expect(calls[0]?.body.fallback_config).toBeNull();
    expect(calls[0]?.body.is_default).toBe(true);
    expect(calls[0]?.key.length).toBeGreaterThan(0);
  });

  test("정책 요약: 토큰/비용 한도에 단위를 표기한다(맨 숫자 노출 금지)", async () => {
    renderApp(fakeClient({ listGatewayPolicies: async () => ({ items: POLICIES, next_cursor: null }) }));
    location.hash = "#llmGateway";

    // 기본 정책(gpt-4o) 요약: maxContextTokens 8000 → "8,000 토큰", maxCost 1 → "$1 USD".
    await waitFor(() => expect(screen.getByText("8,000 토큰")).toBeInTheDocument());
    expect(screen.getByText("$1 USD")).toBeInTheDocument();
    expect(screen.getByText("비용 한도 (실행당)")).toBeInTheDocument();

    // 입력/출력 토큰 한도에도 단위가 붙는다.
    const span = (label: string) =>
      screen.getByText((_, el) => el?.tagName === "SPAN" && el.textContent === label);
    expect(span("입력 800 토큰")).toBeInTheDocument();
    expect(span("출력 400 토큰")).toBeInTheDocument();
  });

  test("정책 요약: 미설정 한도엔 단위를 붙이지 않는다(조용한 false 금지)", async () => {
    renderApp(
      fakeClient({
        listGatewayPolicies: async () => ({
          items: [{ model: "gpt-4o", version: 1, capabilities: {}, budget: {}, is_default: true }],
          next_cursor: null,
        }),
      }),
    );
    location.hash = "#llmGateway";
    await waitFor(() => expect(screen.getAllByText("미지정").length).toBeGreaterThan(0));
    expect(screen.queryByText(/미지정\s*토큰/)).toBeNull();
    expect(screen.queryByText(/미지정\s*USD/)).toBeNull();
  });
});
