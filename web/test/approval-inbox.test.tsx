import { beforeEach, describe, expect, test } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { App } from "../src/App";
import { ApiClientProvider } from "../src/api/context";
import type { ApiClient } from "../src/api/client";
import { ApiError, type DecideApprovalBody } from "../src/api/types";
import { APPROVAL_ARTIFACT_TYPE, COLLECT_SCENARIO_NAME, isHttpUrl, parseApprovalRows, summarize } from "../src/api/approval-inbox";
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
  test("isHttpUrl: http(s)만 링크 허용 — javascript:/data: 등 차단(XSS 가드)", () => {
    expect(isHttpUrl("https://approval.office.hiworks.com/x")).toBe(true);
    expect(isHttpUrl("http://x/y")).toBe(true);
    expect(isHttpUrl("javascript:alert(1)")).toBe(false);
    expect(isHttpUrl("data:text/html,x")).toBe(false);
    expect(isHttpUrl("not a url")).toBe(false);
    expect(isHttpUrl("")).toBe(false);
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

  test("수집 시나리오가 다음 페이지에 있어도 cursor를 따라 찾는다", async () => {
    const scenarioCalls: Array<{ cursor?: string; limit?: number }> = [];
    renderApp(
      fakeClient({
        listScenarios: async (params) => {
          scenarioCalls.push(params ?? {});
          if (params?.cursor === "scenario-cursor-2") {
            return { items: [{ scenario_id: "sc-c", name: COLLECT_SCENARIO_NAME, version: 1, latest_version_id: "ver-c" }], next_cursor: null };
          }
          return { items: [{ scenario_id: "sc-other", name: "다른 자동화", version: 1, latest_version_id: "ver-other" }], next_cursor: "scenario-cursor-2" };
        },
        listRuns: async () => ({ items: [{ run_id: "run-c", status: "completed", current_node: null, as_of: "2026-06-17T09:00:00.000Z" }], next_cursor: null }),
        listRunArtifacts: async () => ({ items: [{ artifact_id: "art-1", type: APPROVAL_ARTIFACT_TYPE, redaction_status: "redacted", retention_until: null, legal_hold: false, created_at: "2026-06-17T09:00:01.000Z" }], next_cursor: null }),
        getArtifact: async (id) => ({ artifact_id: id, type: APPROVAL_ARTIFACT_TYPE, sha256: "x", redaction_status: "redacted", retention_until: null, content: JSON.stringify({ rows: [ROW()] }) }),
      }),
    );
    location.hash = "#approvalInbox";

    await waitFor(() => expect(screen.getByText("연차 신청")).toBeInTheDocument());
    expect(scenarioCalls.some((c) => c.cursor === "scenario-cursor-2")).toBe(true);
  });

  test("approval_inbox 아티팩트가 다음 페이지에 있어도 첫 아티팩트로 fallback하지 않는다", async () => {
    const artifactCalls: Array<{ cursor?: string; limit?: number }> = [];
    const bodyCalls: string[] = [];
    renderApp(
      fakeClient({
        listScenarios: async () => ({ items: [{ scenario_id: "sc-c", name: COLLECT_SCENARIO_NAME, version: 1, latest_version_id: "ver-c" }], next_cursor: null }),
        listRuns: async () => ({ items: [{ run_id: "run-c", status: "completed", current_node: null, as_of: "2026-06-17T09:00:00.000Z" }], next_cursor: null }),
        listRunArtifacts: async (_runId, params) => {
          artifactCalls.push(params ?? {});
          if (params?.cursor === "artifact-cursor-2") {
            return { items: [{ artifact_id: "art-approval", type: APPROVAL_ARTIFACT_TYPE, redaction_status: "redacted", retention_until: null, legal_hold: false, created_at: "2026-06-17T09:00:02.000Z" }], next_cursor: null };
          }
          return { items: [{ artifact_id: "art-screen", type: "screen_capture", redaction_status: "redacted", retention_until: null, legal_hold: false, created_at: "2026-06-17T09:00:01.000Z" }], next_cursor: "artifact-cursor-2" };
        },
        getArtifact: async (id) => {
          bodyCalls.push(id);
          return { artifact_id: id, type: APPROVAL_ARTIFACT_TYPE, sha256: "x", redaction_status: "redacted", retention_until: null, content: JSON.stringify({ rows: [ROW()] }) };
        },
      }),
    );
    location.hash = "#approvalInbox";

    await waitFor(() => expect(screen.getByText("연차 신청")).toBeInTheDocument());
    expect(artifactCalls.some((c) => c.cursor === "artifact-cursor-2")).toBe(true);
    expect(bodyCalls).toEqual(["art-approval"]);
  });

  test("행에 '원문 보기' 새 탭 링크(doc_ref) — http(s) + noopener", async () => {
    renderApp(inboxClient(JSON.stringify({ rows: [ROW()] })));
    location.hash = "#approvalInbox";
    await waitFor(() => expect(screen.getByText("연차 신청")).toBeInTheDocument());
    const link = screen.getByRole("link", { name: /원문 보기/ });
    expect(link.getAttribute("href")).toBe("https://dashboard.office.hiworks.com/approval/1");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  });

  test("doc_ref가 비-http scheme면 링크 대신 '원문 링크 불가'(XSS 차단)", async () => {
    renderApp(inboxClient(JSON.stringify({ rows: [ROW({ doc_ref: "javascript:alert(1)" })] })));
    location.hash = "#approvalInbox";
    await waitFor(() => expect(screen.getByText("연차 신청")).toBeInTheDocument());
    expect(screen.getByText("원문 링크 불가")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /원문 보기/ })).toBeNull();
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

describe("결재 인박스 — 건별 결재(2c)", () => {
  beforeEach(() => {
    location.hash = "";
  });

  test("비-approver(operator) → 결재/반려 버튼 숨김(백엔드가 최종 강제)", async () => {
    localStorage.setItem("rpa.token", jwt(["operator"]));
    renderApp(inboxClient(JSON.stringify({ rows: ROWS })));
    location.hash = "#approvalInbox";
    await waitFor(() => expect(screen.getByText("연차 신청")).toBeInTheDocument());
    expect(screen.queryAllByRole("button", { name: "결재" })).toHaveLength(0);
    expect(screen.queryAllByRole("button", { name: "반려" })).toHaveLength(0);
  });

  test("approver → 행별 [결재]/[반려] 버튼 노출", async () => {
    localStorage.setItem("rpa.token", jwt(["approver"]));
    renderApp(inboxClient(JSON.stringify({ rows: ROWS })));
    location.hash = "#approvalInbox";
    await waitFor(() => expect(screen.getByText("연차 신청")).toBeInTheDocument());
    expect(screen.getAllByRole("button", { name: "결재" })).toHaveLength(3);
    expect(screen.getAllByRole("button", { name: "반려" })).toHaveLength(3);
  });

  test("반려는 사유 필수 — 입력 전 '반려 제출' 비활성", async () => {
    localStorage.setItem("rpa.token", jwt(["approver"]));
    renderApp(inboxClient(JSON.stringify({ rows: [ROW()] })));
    location.hash = "#approvalInbox";
    await waitFor(() => expect(screen.getByText("연차 신청")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "반려" }));
    const submit = screen.getByRole("button", { name: "반려 제출" });
    expect(submit).toBeDisabled(); // 사유 비어있음 → 비활성(미입력 반려 차단)
    fireEvent.change(screen.getByLabelText("반려 사유"), { target: { value: "예산 초과" } });
    expect(submit).not.toBeDisabled();
  });

  test("승인 → 확인 → decideApproval 호출(source_run_id+doc_ref+approve) → 처리 상태 + 실행 기록 링크", async () => {
    localStorage.setItem("rpa.token", jwt(["approver"]));
    let captured: DecideApprovalBody | null = null;
    const client = fakeClient({
      listScenarios: async () => ({ items: [{ scenario_id: "sc-c", name: COLLECT_SCENARIO_NAME, version: 1, latest_version_id: "ver-c" }], next_cursor: null }),
      listRuns: async (p) =>
        p?.scenario_version_id === "ver-c"
          ? { items: [{ run_id: "run-c", status: "completed", current_node: null, as_of: "2026-06-17T09:00:00.000Z" }], next_cursor: null }
          : { items: [], next_cursor: null },
      listRunArtifacts: async () => ({ items: [{ artifact_id: "art-1", type: "approval_inbox", redaction_status: "redacted", retention_until: null, legal_hold: false, created_at: "2026-06-17T09:00:01.000Z" }], next_cursor: null }),
      getArtifact: async (id) => ({ artifact_id: id, type: "approval_inbox", sha256: "x", redaction_status: "redacted", retention_until: null, content: JSON.stringify({ rows: [ROW()] }) }),
      decideApproval: async (body) => {
        captured = body;
        return { decision_id: "dec-1", source_run_id: body.source_run_id, doc_ref: body.doc_ref, decision: body.decision, spawned_run_id: "spawn-9" };
      },
      getRun: async (id) => ({ run_id: id, status: "running", worker_id: null, attempts: 1, as_of: null }),
    });
    renderApp(client);
    location.hash = "#approvalInbox";
    await waitFor(() => expect(screen.getByText("연차 신청")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "결재" }));
    fireEvent.click(screen.getByRole("button", { name: "확인" })); // 되돌릴 수 없음 안내 1단계

    // 결정 후: 처리 자동화 실행 딥링크가 보이고, decideApproval 이 인박스 source run + 행 doc_ref + approve 로 호출됨.
    await waitFor(() => expect(screen.getByText("실행 기록 보기")).toBeInTheDocument());
    expect(captured).not.toBeNull();
    expect(captured!.source_run_id).toBe("run-c");
    expect(captured!.doc_ref).toBe("https://dashboard.office.hiworks.com/approval/1");
    expect(captured!.decision).toBe("approve");
    // 결정된 행은 버튼 대신 처리 상태 — '결재' 버튼이 사라진다(결정후 비활성).
    expect(screen.queryByRole("button", { name: "결재" })).toBeNull();
    const link = screen.getByText("실행 기록 보기");
    expect(link.getAttribute("href")).toBe("#runTrace?run=spawn-9");
  });

  test("approver → 2건 선택 → 일괄 승인 → 배치 확인 → decideApproval 2회(approve) → 두 행 처리 상태", async () => {
    localStorage.setItem("rpa.token", jwt(["approver"]));
    const calls: DecideApprovalBody[] = [];
    let n = 0;
    const client = fakeClient({
      listScenarios: async () => ({ items: [{ scenario_id: "sc-c", name: COLLECT_SCENARIO_NAME, version: 1, latest_version_id: "ver-c" }], next_cursor: null }),
      listRuns: async (p) =>
        p?.scenario_version_id === "ver-c"
          ? { items: [{ run_id: "run-c", status: "completed", current_node: null, as_of: "2026-06-17T09:00:00.000Z" }], next_cursor: null }
          : { items: [], next_cursor: null },
      listRunArtifacts: async () => ({ items: [{ artifact_id: "art-1", type: "approval_inbox", redaction_status: "redacted", retention_until: null, legal_hold: false, created_at: "2026-06-17T09:00:01.000Z" }], next_cursor: null }),
      getArtifact: async (id) => ({ artifact_id: id, type: "approval_inbox", sha256: "x", redaction_status: "redacted", retention_until: null, content: JSON.stringify({ rows: ROWS }) }),
      decideApproval: async (body) => {
        calls.push(body);
        n += 1;
        return { decision_id: `dec-${n}`, source_run_id: body.source_run_id, doc_ref: body.doc_ref, decision: body.decision, spawned_run_id: `spawn-${n}` };
      },
      getRun: async (id) => ({ run_id: id, status: "running", worker_id: null, attempts: 1, as_of: null }),
    });
    renderApp(client);
    location.hash = "#approvalInbox";
    await waitFor(() => expect(screen.getByText("연차 신청")).toBeInTheDocument());

    // 2건 선택 → '선택 2건 일괄 승인' → 배치 단일 확인(되돌릴 수 없음 안내) → 확인.
    fireEvent.click(screen.getByLabelText("연차 신청 일괄 승인 선택"));
    fireEvent.click(screen.getByLabelText("출장비 정산 일괄 승인 선택"));
    fireEvent.click(screen.getByRole("button", { name: "선택 2건 일괄 승인" }));
    expect(screen.getByText("선택 2건을 일괄 승인합니다. 승인 후에는 되돌릴 수 없으며 자동화 실행 2건이 생성됩니다.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "일괄 승인 확인" }));

    // 두 선택 행이 처리 상태(딥링크)로, decideApproval 이 선택 2건만 approve 로 호출됨.
    await waitFor(() => expect(screen.getAllByText("실행 기록 보기")).toHaveLength(2));
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c.decision === "approve" && c.source_run_id === "run-c")).toBe(true);
    expect(calls.map((c) => c.doc_ref).sort()).toEqual([
      "https://dashboard.office.hiworks.com/approval/1",
      "https://dashboard.office.hiworks.com/approval/2",
    ]);
    // 미선택 3번째 행(비품 구매)은 일괄 대상 아님 — 여전히 건별 [결재] 버튼 보유.
    expect(screen.getByText("비품 구매")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "결재" }).length).toBeGreaterThanOrEqual(1);
    // 일괄 결과 집계: 성공 2건을 한눈에(스크롤로 행을 찾지 않게).
    expect(await screen.findByText("승인 완료 2건")).toBeInTheDocument();
  });

  test("일괄 승인 부분 실패 → '성공 N건 · 실패 M건' 집계 + 실패 행 에러 배지", async () => {
    localStorage.setItem("rpa.token", jwt(["approver"]));
    let n = 0;
    const client = fakeClient({
      listScenarios: async () => ({ items: [{ scenario_id: "sc-c", name: COLLECT_SCENARIO_NAME, version: 1, latest_version_id: "ver-c" }], next_cursor: null }),
      listRuns: async (p) =>
        p?.scenario_version_id === "ver-c"
          ? { items: [{ run_id: "run-c", status: "completed", current_node: null, as_of: "2026-06-17T09:00:00.000Z" }], next_cursor: null }
          : { items: [], next_cursor: null },
      listRunArtifacts: async () => ({ items: [{ artifact_id: "art-1", type: "approval_inbox", redaction_status: "redacted", retention_until: null, legal_hold: false, created_at: "2026-06-17T09:00:01.000Z" }], next_cursor: null }),
      getArtifact: async (id) => ({ artifact_id: id, type: "approval_inbox", sha256: "x", redaction_status: "redacted", retention_until: null, content: JSON.stringify({ rows: ROWS }) }),
      decideApproval: async (body) => {
        n += 1;
        if (n === 1) throw new ApiError(409, "APPROVAL_ALREADY_DECIDED", { code: "APPROVAL_ALREADY_DECIDED" });
        return { decision_id: `dec-${n}`, source_run_id: body.source_run_id, doc_ref: body.doc_ref, decision: body.decision, spawned_run_id: `spawn-${n}` };
      },
      getRun: async (id) => ({ run_id: id, status: "running", worker_id: null, attempts: 1, as_of: null }),
    });
    renderApp(client);
    location.hash = "#approvalInbox";
    await waitFor(() => expect(screen.getByText("연차 신청")).toBeInTheDocument());

    fireEvent.click(screen.getByLabelText("연차 신청 일괄 승인 선택"));
    fireEvent.click(screen.getByLabelText("출장비 정산 일괄 승인 선택"));
    fireEvent.click(screen.getByRole("button", { name: "선택 2건 일괄 승인" }));
    fireEvent.click(screen.getByRole("button", { name: "일괄 승인 확인" }));

    // 부분 실패가 집계로 즉시 표면화(조용한 false 금지).
    expect(await screen.findByText("승인 완료 1건 · 실패 1건(아래 표에서 확인)")).toBeInTheDocument();
  });

  // IRR-03: 일괄 선택 후 그 중 한 건을 건별 승인하면 selected 에서 제거돼, 일괄 경로가 그 건을 재제출하지 않는다
  //   (재제출 시 APPROVAL_ALREADY_DECIDED(409)가 행 DecidedStatus 분기에서 조용히 묻혔음 — 조용한 false 금지).
  test("일괄 선택 + 건별 승인 → 결정된 건은 일괄에서 제외(재제출/묻힘 없음)", async () => {
    localStorage.setItem("rpa.token", jwt(["approver"]));
    const calls: DecideApprovalBody[] = [];
    let n = 0;
    const client = fakeClient({
      listScenarios: async () => ({ items: [{ scenario_id: "sc-c", name: COLLECT_SCENARIO_NAME, version: 1, latest_version_id: "ver-c" }], next_cursor: null }),
      listRuns: async (p) =>
        p?.scenario_version_id === "ver-c"
          ? { items: [{ run_id: "run-c", status: "completed", current_node: null, as_of: "2026-06-17T09:00:00.000Z" }], next_cursor: null }
          : { items: [], next_cursor: null },
      listRunArtifacts: async () => ({ items: [{ artifact_id: "art-1", type: "approval_inbox", redaction_status: "redacted", retention_until: null, legal_hold: false, created_at: "2026-06-17T09:00:01.000Z" }], next_cursor: null }),
      getArtifact: async (id) => ({ artifact_id: id, type: "approval_inbox", sha256: "x", redaction_status: "redacted", retention_until: null, content: JSON.stringify({ rows: ROWS }) }),
      decideApproval: async (body) => {
        calls.push(body);
        n += 1;
        return { decision_id: `dec-${n}`, source_run_id: body.source_run_id, doc_ref: body.doc_ref, decision: body.decision, spawned_run_id: `spawn-${n}` };
      },
      getRun: async (id) => ({ run_id: id, status: "running", worker_id: null, attempts: 1, as_of: null }),
    });
    renderApp(client);
    location.hash = "#approvalInbox";
    await waitFor(() => expect(screen.getByText("연차 신청")).toBeInTheDocument());

    // doc1(연차 신청) + doc2(출장비 정산) 선택.
    fireEvent.click(screen.getByLabelText("연차 신청 일괄 승인 선택"));
    fireEvent.click(screen.getByLabelText("출장비 정산 일괄 승인 선택"));
    expect(screen.getByRole("button", { name: "선택 2건 일괄 승인" })).toBeInTheDocument();

    // doc1 을 건별 승인 → markDecided 가 selected 에서 doc1 제거 → 일괄 버튼이 '선택 1건'으로 줄어듦.
    const row1 = screen.getByText("연차 신청").closest("tr") as HTMLElement;
    fireEvent.click(within(row1).getByRole("button", { name: "결재" }));
    fireEvent.click(within(row1).getByRole("button", { name: "확인" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "선택 1건 일괄 승인" })).toBeInTheDocument());

    // 일괄 승인 확인 → doc2 만 추가 제출(doc1 은 이미 결정 → 재제출 안 함).
    fireEvent.click(screen.getByRole("button", { name: "선택 1건 일괄 승인" }));
    fireEvent.click(screen.getByRole("button", { name: "일괄 승인 확인" }));
    await waitFor(() => expect(screen.getAllByText("실행 기록 보기")).toHaveLength(2));

    // decideApproval 총 2회(doc1 건별 1 + doc2 일괄 1), doc1 doc_ref 는 정확히 1회(재제출 없음).
    expect(calls).toHaveLength(2);
    const doc1Calls = calls.filter((c) => c.doc_ref === "https://dashboard.office.hiworks.com/approval/1");
    expect(doc1Calls).toHaveLength(1);
    expect(calls.filter((c) => c.doc_ref === "https://dashboard.office.hiworks.com/approval/2")).toHaveLength(1);
  });
});
