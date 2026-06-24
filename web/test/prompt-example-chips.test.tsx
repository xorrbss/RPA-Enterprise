import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { axe } from "vitest-axe";
import { beforeEach, describe, expect, test } from "vitest";

import { App } from "../src/App";
import { ApiClientProvider } from "../src/api/context";
import { fakeClient } from "./fake-client";

function jwt(roles: readonly string[]): string {
  const payload = btoa(JSON.stringify({ sub: "u", tenant_id: "t", roles }))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `e30.${payload}.sig`;
}

function renderApp(): HTMLElement {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { container } = render(
    <QueryClientProvider client={qc}>
      <ApiClientProvider client={fakeClient()}>
        <App />
      </ApiClientProvider>
    </QueryClientProvider>,
  );
  return container;
}

describe("AI 생성기 예시 프롬프트 칩", () => {
  beforeEach(() => {
    localStorage.setItem("rpa.token", jwt(["operator"]));
    location.hash = "#scenarioStudio";
  });

  test("칩 클릭 시 자연어 요청 textarea가 예시 문장으로 채워진다", () => {
    renderApp();

    const textarea = screen.getByRole("textbox", { name: "자연어 요청" }) as HTMLTextAreaElement;
    expect(textarea.value).toBe("");

    const chip = screen.getByRole("button", { name: "예시 프롬프트 채우기: 결재 처리" });
    fireEvent.click(chip);

    expect(textarea.value).toContain("하이웍스 결재함");
    // placeholder 문장과 중복되지 않아야 한다.
    expect(textarea.value).not.toBe(textarea.placeholder);
  });

  test("예시 칩 그룹에 접근성 위반이 없다", async () => {
    const container = renderApp();
    const group = screen.getByRole("group", { name: "예시 프롬프트" });
    expect(group).toBeInTheDocument();
    const results = await axe(container);
    expect(results.violations).toEqual([]);
  });
});
