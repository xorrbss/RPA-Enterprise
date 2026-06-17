import { beforeEach, describe, expect, test } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { App } from "../src/App";
import { ApiClientProvider } from "../src/api/context";
import type { ApiClient } from "../src/api/client";
import { COLLECT_SCENARIO_NAME, parseApprovalRows, summarize } from "../src/api/approval-inbox";
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
function jwt(roles: readonly string[]): string {
  const payload = btoa(JSON.stringify({ sub: "u", tenant_id: "t", roles })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `e30.${payload}.sig`;
}

const ROW = (over: Record<string, unknown> = {}) => ({
  doc_ref: "https://dashboard.office.hiworks.com/approval/1", title: "연차 신청", status: "대기", doc_type: "휴가", drafter: "홍길동", drafted_at: "2026-06-17", ...over,
});
const ROWS = [ROW(), ROW({ doc_ref: "https://dashboard.office.hiworks.com/approval/2", title: "출장비 정산", doc_type: "지출", drafter: "김영희" }), ROW({ doc_ref: "https://dashboard.office.hiworks.com/approval/3", title: "비품 구매", doc_type: "지출", drafter: "이철수" })];

// 수집 시나리오 + 완료 run + 결재 목록 아티팩트를 갖춘 fake.
function inboxClient(content: string): ApiClient {
  return fakeClient({
    listScenarios: async () => ({ items: [{ scenario_id: "sc-c", name: COLLECT_SCENARIO_NAME, version: 1, latest_version_id: "ver-c" }], next_cursor: null }),
    listRuns: async (p) =>
      p?.scenario_version_id === "ver-c"
        ? { items: [{ run_id: "run-c", status: "completed", current_node: null, as_of: "2026-06-17T09:00:00.000Z" }], next_cursor: null }
        : { items: [], next_cursor: null },
    listRunArtifacts: async () => ({ items: [{ artifact_id: "art-1", type: "approval_inbox", redaction_status: "redacted", retention_until: null, legal_hold: false, created_at: "2026-06-17T09:00:01.000Z" }], next_cursor: null }),
    getArtifact: async (id) => ({ artifact_id: id, type: "approval_inbox", sha256: "x", redaction_status: "redacted", retention_until: null, content }),
  });
}

describe("결재 인박스 — 순수 로직", () => {
  test("parseApprovalRows: {rows} 정상 파싱 + 누락 필드 안전 폴백", () => {
    const rows = parseApprovalRows(JSON.stringify({ rows: [{ doc_ref: "https://x/y", status: "대기" }] }));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.doc_ref).toBe("https://x/y");
    expect(rows[0]!.title).toBe("(제목 없음)"); // 누락 → 명시 플레이스홀더(창작 아님)
    expect(rows[0]!.drafter).toBe("(기안자 미상)");
  });
  test("parseApprovalRows: 배열 루트도 허용", () => {
    expect(parseApprovalRows(JSON.stringify([{ doc_ref: "https://x/1" }]))).toHaveLength(1);
  });
  test("parseApprovalRows: doc_ref 누락 → throw(조용한 false 금지)", () => {
    expect(() => parseApprovalRows(JSON.stringify({ rows: [{ title: "x" }] }))).toThrow(/doc_ref/);
  });
  test("parseApprovalRows: 잘못된 JSON/형식 → throw", () => {
    expect(() => parseApprovalRows("not json")).toThrow();
    expect(() => parseApprovalRows(JSON.stringify({ foo: 1 }))).toThrow(/rows/);
  });
  test("summarize: 상태/유형별 카운트(내림차순)", () => {
    const s = summarize(ROWS);
    expect(s.total).toBe(3);
    expect(s.byStatus).toEqual([["대기", 3]]);
    expect(s.byType[0]).toEqual(["지출", 2]); // 최다 유형이 먼저
  });
});

describe("결재 인박스 — 뷰", () => {
  beforeEach(() => {
    location.hash = "";
    localStorage.setItem("rpa.token", jwt(["operator"]));
  });

  test("수집 결과 → 요약 + 목록 렌더", async () => {
    renderApp(inboxClient(JSON.stringify({ rows: ROWS })));
    location.hash = "#approvalInbox";
    await waitFor(() => expect(screen.getByText("결재 3건")).toBeInTheDocument());
    expect(screen.getByText("연차 신청")).toBeInTheDocument();
    expect(screen.getByText("출장비 정산")).toBeInTheDocument();
    expect(screen.getByText("지출 2")).toBeInTheDocument(); // 유형 집계 칩
    expect(screen.getByText("홍길동")).toBeInTheDocument();
  });

  test("수집 시나리오 없음 → 안내 빈 상태", async () => {
    renderApp(fakeClient()); // 기본 listScenarios = 빈
    location.hash = "#approvalInbox";
    await waitFor(() => expect(screen.getByText(new RegExp(`${COLLECT_SCENARIO_NAME}.*없습니다`))).toBeInTheDocument());
  });

  test("완료된 수집 run 없음 → '아직 수집된 결재가 없습니다'", async () => {
    renderApp(
      fakeClient({
        listScenarios: async () => ({ items: [{ scenario_id: "sc-c", name: COLLECT_SCENARIO_NAME, version: 1, latest_version_id: "ver-c" }], next_cursor: null }),
        listRuns: async () => ({ items: [], next_cursor: null }),
      }),
    );
    location.hash = "#approvalInbox";
    await waitFor(() => expect(screen.getByText(/아직 수집된 결재가 없습니다/)).toBeInTheDocument());
  });

  test("아티팩트 본문 형식 오류 → 오류 표면화(조용한 false 금지)", async () => {
    renderApp(inboxClient(JSON.stringify({ wrong: 1 })));
    location.hash = "#approvalInbox";
    await waitFor(() => expect(screen.getByText(/형식이 아닙니다/)).toBeInTheDocument());
  });
});
