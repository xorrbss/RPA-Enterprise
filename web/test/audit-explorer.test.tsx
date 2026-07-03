import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { App } from "../src/App";
import { ApiClientProvider } from "../src/api/context";
import type { ApiClient } from "../src/api/client";
import { ACTION_LABEL } from "../src/views/audit/audit-labels";
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
    fireEvent.change(screen.getByPlaceholderText("목록의 '이 처리자로 조회'로 채워집니다"), { target: { value: "operator-a" } });
    fireEvent.change(screen.getByPlaceholderText("추적 번호 전체 값"), { target: { value: "corr-999" } });

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

  test("기간 필터와 현재 필터로 감사 CSV 전체 기간을 cursor로 이어받는다", async () => {
    const calls: unknown[] = [];
    const createObjectURL = vi.fn(() => "blob:audit-csv");
    const revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectURL });

    location.hash = "#auditExplorer?action=artifact.read&outcome=allow&actor=viewer-a";
    renderApp(fakeClient({
      listAuditLog: async (params) => {
        calls.push(params);
        const suffix = params?.cursor === "cursor-2" ? "a2" : "a1";
        return {
          items: [
            {
              audit_id: `81000000-0000-4000-8000-0000000000${suffix}`,
              sequence_no: params?.cursor === "cursor-2" ? 1 : 2,
              actor: { subject_id: "viewer-a", roles: ["viewer"] },
              action: "artifact.read",
              outcome: "allow",
              reason: "artifact disclosed",
              correlation_id: "82000000-0000-4000-8000-0000000000a1",
              idempotency_key: "audit-fixture-1",
              occurred_at: "2026-06-23T09:00:00.000Z",
              payload_schema_ref: "audit/security-boundary-decision@1",
              retention_until: "2026-09-23T09:00:00.000Z",
              legal_hold: false,
              previous_hash: "sha256:old",
              hash: "sha256:new",
              created_at: "2026-06-23T09:00:01.000Z",
            },
          ],
          next_cursor: params?.cursor === "cursor-2" ? null : "cursor-2",
        };
      },
    }));

    fireEvent.change(await screen.findByLabelText("시작 시각"), { target: { value: "2026-06-01T00:00" } });
    fireEvent.change(screen.getByLabelText("종료 시각"), { target: { value: "2026-06-30T23:59" } });
    fireEvent.click(await screen.findByRole("button", { name: "기간 전체 CSV 내보내기" }));

    await waitFor(() => expect(calls).toEqual(expect.arrayContaining([
      expect.objectContaining({
      action: "artifact.read",
      outcome: "allow",
      actor: "viewer-a",
      // datetime-local 입력은 브라우저 로컬 TZ 의도 — API 에는 UTC ISO 로 고정 전송(서버 로컬 TZ 해석 차단)
      occurred_at_from: new Date("2026-06-01T00:00").toISOString(),
      occurred_at_to: new Date("2026-06-30T23:59").toISOString(),
      limit: 200,
    }),
      expect.objectContaining({ cursor: "cursor-2", limit: 200 }),
    ])));
    expect(createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
    expect(click).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:audit-csv");
    expect(await screen.findByText("감사 기록 기간 CSV를 준비했습니다. 현재 필터와 기간 기준 전체 페이지를 이어받았습니다.")).toBeInTheDocument();
  });

  test("행의 '이 번호로 조회'가 추적 번호 필터를 전체 값으로 채운다", async () => {
    renderApp(fakeClient());

    fireEvent.click(await screen.findByRole("button", { name: "이 번호로 조회" }));

    await waitFor(() => expect(location.hash).toContain("correlation_id=82000000-0000-4000-8000-0000000000a1"));
    expect(screen.getByPlaceholderText("추적 번호 전체 값")).toHaveValue("82000000-0000-4000-8000-0000000000a1");
  });

  test("행의 '이 처리자로 조회'가 처리자 필터를 정확한 식별값으로 채운다", async () => {
    renderApp(fakeClient());

    fireEvent.click(await screen.findByRole("button", { name: "이 처리자로 조회" }));

    await waitFor(() => expect(location.hash).toContain("actor=viewer-a"));
    expect(screen.getByPlaceholderText("목록의 '이 처리자로 조회'로 채워집니다")).toHaveValue("viewer-a");
  });

  test("기간 필터는 목록 조회에도 UTC ISO로 변환되어 전송되고 딥링크에는 원문이 남는다", async () => {
    const calls: unknown[] = [];
    renderApp(fakeClient({
      listAuditLog: async (params) => {
        calls.push(params);
        return { items: [], next_cursor: null };
      },
    }));

    fireEvent.change(await screen.findByLabelText("시작 시각"), { target: { value: "2026-06-01T09:00" } });

    await waitFor(() => expect(calls).toContainEqual(expect.objectContaining({
      occurred_at_from: new Date("2026-06-01T09:00").toISOString(),
    })));
    expect(decodeURIComponent(location.hash)).toContain("occurred_at_from=2026-06-01T09:00");
  });

  test("감사 action 라벨은 계약 레지스트리 전수를 커버하고 그 밖은 두지 않는다", () => {
    // ts/security-middleware-contract.ts SECURITY_AUDIT_REQUIRED_ACTIONS 미러(fake-client 와 같은 서버 계약 미러 패턴).
    // audit_log 는 레지스트리 밖 action 을 fail-closed 로 거부하므로 라벨 맵과 레지스트리는 정확히 일치해야 한다.
    const SECURITY_AUDIT_REQUIRED_ACTIONS = [
      "artifact.read",
      "secret.resolve",
      "connector.enable",
      "connector.install",
      "scenario.certify",
      "scenario.decertify",
      "scenario_release.create",
      "scenario_release.submit",
      "scenario_release.approve",
      "scenario_release.reject",
      "scenario_release.deploy",
      "scenario_release.rollback",
      "run.create",
      "run.rerun",
      "run.resume",
      "run.pause",
      "run.prioritize",
      "credential.manage",
      "worker_pool.manage",
      "rbac.grant",
      "rbac.revoke",
      "scim.sync",
      "tenant_data.export",
      "tenant_data.purge.request",
      "tenant_data.purge.approve",
      "network.request",
      "prompt.inspect",
      "ai_governance.manage",
      "ai_governance.enforce",
      "bypassrls.use",
    ];

    expect(Object.keys(ACTION_LABEL).sort()).toEqual([...SECURITY_AUDIT_REQUIRED_ACTIONS].sort());
    for (const action of SECURITY_AUDIT_REQUIRED_ACTIONS) {
      expect(ACTION_LABEL[action], action).toMatch(/[가-힣]/);
    }
  });
});
