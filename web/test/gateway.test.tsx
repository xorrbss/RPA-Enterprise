import { beforeEach, describe, expect, test } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { App } from "../src/App";
import { ApiClientProvider } from "../src/api/context";
import type { ApiClient } from "../src/api/client";
import { fakeClient } from "./fake-client";

// LLM 게이트웨이 정책 뷰 — 편집(If-Match)·RBAC 게이팅·다중정책 dead-end 해소·404. smoke.test.tsx(500라인 한도)에서
// 의미 단위로 분리(CLAUDE.md #7). 헬퍼는 다른 test 파일 패턴대로 파일 내 정의.
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

describe("LLM 게이트웨이 정책 — 편집·RBAC·다중정책", () => {
  beforeEach(() => {
    location.hash = "";
    localStorage.setItem("rpa.token", jwt(ALL_ROLES));
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
});
