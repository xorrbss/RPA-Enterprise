import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { App } from "../src/App";
import { ApiClientProvider } from "../src/api/context";
import type { ApiClient } from "../src/api/client";
import { fakeClient } from "./fake-client";

function renderApp(client: ApiClient): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ApiClientProvider client={client}>
        <App />
      </ApiClientProvider>
    </QueryClientProvider>,
  );
}

function unsignedToken(roles: readonly string[]): string {
  const encode = (value: unknown) => btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  return `${encode({ alg: "none" })}.${encode({ sub: "admin-a", roles })}.`;
}

describe("audit explorer view", () => {
  beforeEach(() => {
    location.hash = "#auditExplorer";
    localStorage.setItem("rpa.token", "test-token");
  });

  test("감사 기록 요약은 업무 용어를 우선하고 원문 값은 세부 정보에 둔다", async () => {
    renderApp(fakeClient());

    expect(await screen.findByRole("heading", { name: "감사 기록 조회" })).toBeInTheDocument();
    expect(screen.getByText("민감정보 숨김")).toBeInTheDocument();
    expect(await screen.findByText("증빙 조회")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "업무" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "처리자" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "무결성" })).toBeInTheDocument();
    expect(screen.getByText("허용", { selector: "span" })).toBeInTheDocument();
    expect(screen.getByText("권한 범위 뷰어")).toBeInTheDocument();
    expect(screen.getByText("처리자 확인됨")).toBeInTheDocument();
    expect(screen.getByText("요청 추적 가능")).toBeInTheDocument();
    expect(screen.queryByText("viewer-a")).not.toBeInTheDocument();
    expect(screen.queryByText("추적 번호 82000000")).not.toBeInTheDocument();
    expect(screen.getByText("이전 기록과 연결됨")).toBeInTheDocument();
    expect(screen.queryByText("must-not-leak")).not.toBeInTheDocument();

    const rawAction = screen.getByText("artifact.read");
    const currentHash = screen.getByText("sha256:new");
    expect(rawAction).not.toBeVisible();
    expect(currentHash).not.toBeVisible();

    fireEvent.click(screen.getByText("감사 세부 정보 보기"));
    expect(rawAction).toBeVisible();

    fireEvent.click(screen.getByText("무결성 세부값 보기"));
    expect(currentHash).toBeVisible();
  });

  test("감사 체인 검증 최근 결과를 표시한다", async () => {
    renderApp(fakeClient());

    expect(await screen.findByRole("heading", { name: "감사 체인 검증" })).toBeInTheDocument();
    expect(await screen.findByText("정상")).toBeInTheDocument();
    expect(screen.getByText("검증 행")).toBeInTheDocument();
    expect(screen.getByText("위반")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "체인 검증 실행" })).toBeDisabled();
  });

  test("관리자는 감사 체인 검증을 수동 실행할 수 있다", async () => {
    const runAuditVerification = vi.fn(async () => ({
      verification_run_id: "83000000-0000-4000-8000-000000000099",
      status: "invalid" as const,
      rows_checked: 3,
      violation_count: 1,
      violations: [{ sequenceNo: 3, id: "audit-row-3", kind: "hash_mismatch" as const, detail: "mismatch" }],
      checked_from_sequence: 1,
      checked_to_sequence: 3,
      started_at: "2026-06-29T00:00:00.000Z",
      completed_at: "2026-06-29T00:00:01.000Z",
      correlation_id: "84000000-0000-4000-8000-000000000099",
      triggered_by: { subject_id: "admin-a", roles: ["admin"] },
      trigger_kind: "manual_api" as const,
      retention_until: "2026-09-29T00:00:01.000Z",
      legal_hold: false,
    }));
    localStorage.setItem("rpa.token", unsignedToken(["admin"]));
    renderApp(fakeClient({ runAuditVerification }));

    fireEvent.click(await screen.findByRole("button", { name: "체인 검증 실행" }));

    await waitFor(() => expect(runAuditVerification).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("감사 체인 검증 이력을 저장했습니다.")).toBeInTheDocument();
  });

  test("감사 기록 실패를 오류 상태로 표시한다", async () => {
    renderApp(fakeClient({ listAuditLog: async () => { throw new Error("network down"); } }));

    expect(await screen.findByRole("alert")).toHaveTextContent("감사 기록을 불러오지 못했습니다.");
    expect(screen.getByRole("button", { name: "다시 시도" })).toBeInTheDocument();
  });

  test("URL 필터 딥링크가 감사로그 API 파라미터를 초기화한다", async () => {
    const calls: unknown[] = [];
    location.hash = "#auditExplorer?action=artifact.read&outcome=deny&actor=reviewer-a&correlation_id=corr-123";
    renderApp(fakeClient({
      listAuditLog: async (params) => {
        calls.push(params);
        return { items: [], next_cursor: null };
      },
    }));

    await waitFor(() => expect(calls).toContainEqual(expect.objectContaining({
      action: "artifact.read",
      outcome: "deny",
      actor: "reviewer-a",
      correlation_id: "corr-123",
    })));
  });

  test("필터 입력은 공유 가능한 URL 파라미터를 갱신한다", async () => {
    renderApp(fakeClient({ listAuditLog: async () => ({ items: [], next_cursor: null }) }));

    fireEvent.change(await screen.findByLabelText("업무"), { target: { value: "run.started" } });
    fireEvent.change(screen.getByPlaceholderText("계정 또는 담당자"), { target: { value: "operator-a" } });
    fireEvent.change(screen.getByPlaceholderText("예: 요청-123"), { target: { value: "corr-999" } });

    await waitFor(() => {
      expect(location.hash).toContain("action=run.started");
      expect(location.hash).toContain("actor=operator-a");
      expect(location.hash).toContain("correlation_id=corr-999");
    });
  });

  test("업무 라벨로 입력해도 감사로그 API에는 계약 action 값을 보낸다", async () => {
    const calls: unknown[] = [];
    renderApp(fakeClient({
      listAuditLog: async (params) => {
        calls.push(params);
        return { items: [], next_cursor: null };
      },
    }));

    fireEvent.change(await screen.findByLabelText("업무"), { target: { value: "증빙 조회" } });

    await waitFor(() => expect(calls).toContainEqual(expect.objectContaining({
      action: "artifact.read",
    })));
  });

  test("현재 필터로 감사 CSV 내보내기를 요청한다", async () => {
    const calls: unknown[] = [];
    const createObjectURL = vi.fn(() => "blob:audit-csv");
    const revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectURL });

    location.hash = "#auditExplorer?action=artifact.read&outcome=allow&actor=viewer-a";
    renderApp(fakeClient({
      exportAuditLogCsv: async (params) => {
        calls.push(params);
        return "audit_id,action\n81000000-0000-4000-8000-0000000000a1,artifact.read\n";
      },
    }));

    fireEvent.click(await screen.findByRole("button", { name: "CSV 내보내기(최대 200건)" }));

    await waitFor(() => expect(calls).toEqual([expect.objectContaining({
      action: "artifact.read",
      outcome: "allow",
      actor: "viewer-a",
      limit: 200,
      format: "csv",
    })]));
    expect(createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
    expect(click).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:audit-csv");
    expect(await screen.findByText("감사 기록 CSV를 준비했습니다. 현재 필터 기준 최대 200건입니다.")).toBeInTheDocument();
  });
});
