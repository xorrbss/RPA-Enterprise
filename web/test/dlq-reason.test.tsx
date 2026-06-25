import { beforeEach, describe, expect, test } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { App } from "../src/App";
import { ApiClientProvider } from "../src/api/context";
import type { ApiClient } from "../src/api/client";
import { fakeClient } from "./fake-client";

// 작업 항목 재처리 대기 표의 '사유'(reason_code → 운영자 라벨)·'발생'(created_at) 컬럼.
// reads.ts가 workitem 재처리 대기 목록만 두 필드를 투영(sink는 부재) — 표는 응답에 있는 값만 그린다(날조 금지).
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

describe("작업 항목 재처리 대기 — 사유·발생 컬럼", () => {
  beforeEach(() => {
    location.hash = "";
    localStorage.setItem("rpa.token", jwt(["viewer", "operator", "reviewer", "approver", "admin"]));
  });

  // 매핑된 reason_code → 한국어 라벨 + created_at 로컬 포맷.
  test("reason_code 매핑 라벨 + created_at 표시", async () => {
    const createdAt = "2026-06-16T03:04:05.000Z";
    renderApp(
      fakeClient({
        listDlq: async (kind) =>
          kind === "workitem"
            ? { items: [{ dead_letter_id: "dl-aaaa1111", kind: "workitem", status: "DEAD_LETTER", source_id: "wi-bbbb2222", reason_code: "WORKITEM_CHECKOUT_CONFLICT", created_at: createdAt }], next_cursor: null }
            : { items: [], next_cursor: null },
      }),
    );
    location.hash = "#workitems";
    const cell = await screen.findByTitle("추적 번호 dl-aaaa1111");
    const row = cell.closest("tr") as HTMLElement;
    expect(cell).toHaveTextContent("작업 항목 재처리 대기 #dl-aaaa1"); // 단축 추적번호 가시 노출
    expect(row).not.toHaveTextContent("dl-aaaa1111"); // 전체 추적번호는 여전히 title에만
    expect(within(row).getByTitle("추적 번호 wi-bbbb2222")).toHaveTextContent("원본 작업 연결됨");
    expect(within(row).getByText("재시도됩니다.")).toBeInTheDocument(); // errorCodeLabel(WORKITEM_CHECKOUT_CONFLICT)
    expect(within(row).getByText(new Date(createdAt).toLocaleString())).toBeInTheDocument();
  });

  // 미매핑 reason_code도 운영자 라벨 우선(원문 코드는 title 보존, 조용한 공백 금지).
  test("미매핑 reason_code는 운영자 라벨로 표시", async () => {
    renderApp(
      fakeClient({
        listDlq: async (kind) =>
          kind === "workitem"
            ? { items: [{ dead_letter_id: "dl-cccc3333", kind: "workitem", status: "DEAD_LETTER", source_id: null, reason_code: "VERIFY_FAILED", created_at: "2026-06-16T00:00:00.000Z" }], next_cursor: null }
            : { items: [], next_cursor: null },
      }),
    );
    location.hash = "#workitems";
    const cell = await screen.findByTitle("추적 번호 dl-cccc3333");
    const row = cell.closest("tr") as HTMLElement;
    expect(cell).toHaveTextContent("작업 항목 재처리 대기 #dl-cccc3"); // 단축 추적번호 가시 노출
    expect(row).not.toHaveTextContent("dl-cccc3333"); // 전체 추적번호는 여전히 title에만
    expect(within(row).getByText("검증 실패")).toBeInTheDocument();
  });

  test("외부 전달 재시도 대상은 추적값을 title에만 보존", async () => {
    renderApp(
      fakeClient({
        listDlq: async (kind) =>
          kind === "sink"
            ? { items: [{ dead_letter_id: "sink-dead-letter-0001", kind: "sink", status: "DEAD_LETTER", source_id: null, sink_idempotency_key: "sink-key-raw-123" }], next_cursor: null }
            : { items: [], next_cursor: null },
      }),
    );
    location.hash = "#workitems";

    const cell = await screen.findByTitle("추적 번호 sink-dead-letter-0001");
    const row = cell.closest("tr") as HTMLElement;

    expect(cell).toHaveTextContent("외부 전달 재시도 대상");
    expect(row).not.toHaveTextContent("sink-dead-letter");
    expect(within(row).getByTitle("중복 방지 추적 번호 sink-key-raw-123")).toHaveTextContent("중복 방지 적용됨");
    expect(row).not.toHaveTextContent("sink-key-raw");
  });

  test("일괄 재처리 실패 알림은 짧은 추적값 대신 실패 건수만 표시", async () => {
    const replayed: string[] = [];
    renderApp(
      fakeClient({
        listDlq: async (kind) =>
          kind === "workitem"
            ? {
                items: [
                  { dead_letter_id: "dl-fail-raw-0001", kind: "workitem", status: "DEAD_LETTER", source_id: null },
                  { dead_letter_id: "dl-ok-raw-0002", kind: "workitem", status: "DEAD_LETTER", source_id: null },
                ],
                next_cursor: null,
              }
            : { items: [], next_cursor: null },
        replayDeadLetter: async (id) => {
          replayed.push(id);
          if (id === "dl-fail-raw-0001") throw new Error("backend raw failure");
          return {};
        },
      }),
    );
    location.hash = "#workitems";

    fireEvent.click(await screen.findByRole("button", { name: "이 페이지 2건 재처리" }));
    fireEvent.click(screen.getByRole("button", { name: "확인" }));

    const alert = await screen.findByRole("alert");
    await waitFor(() => expect(replayed).toEqual(["dl-fail-raw-0001", "dl-ok-raw-0002"]));
    expect(alert).toHaveTextContent("1건 재처리 실패 — 1건은 처리됨");
    expect(alert).not.toHaveTextContent("dl-fail");
    expect(alert).not.toHaveTextContent("dl-ok");
  });
});
