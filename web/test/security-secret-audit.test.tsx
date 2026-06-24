import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { App } from "../src/App";
import type { ApiClient } from "../src/api/client";
import { ApiClientProvider } from "../src/api/context";
import type { AuditLogItem } from "../src/api/types";
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
  const payload = btoa(JSON.stringify({ sub: "operator-a", tenant_id: "tenant-a", roles }))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `e30.${payload}.sig`;
}

function auditItem(overrides: Partial<AuditLogItem>): AuditLogItem {
  return {
    audit_id: "81000000-0000-4000-8000-0000000000a1",
    sequence_no: 10,
    actor: { subject_id: "runtime-a", roles: ["operator"] },
    action: "secret.resolve",
    outcome: "allow",
    reason: "secret resolved",
    correlation_id: "corr-secret-a",
    idempotency_key: "secret-audit-1",
    occurred_at: "2026-06-23T09:00:00.000Z",
    payload_schema_ref: "audit/secret-resolve@1",
    retention_until: "2026-09-23T09:00:00.000Z",
    legal_hold: false,
    previous_hash: "sha256:previous",
    hash: "sha256:current",
    created_at: "2026-06-23T09:00:01.000Z",
    ...overrides,
  };
}

describe("security SecretRef audit panel", () => {
  beforeEach(() => {
    location.hash = "#security";
    localStorage.setItem("rpa.token", jwt(["operator"]));
  });

  test("secret.resolve 감사 로그를 비밀값 없이 요약한다", async () => {
    const listAuditLog = vi.fn(async () => ({
      items: [
        auditItem({ audit_id: "audit-allow", outcome: "allow", actor: { subject_id: "runtime-a", roles: ["operator"] } }),
        auditItem({ audit_id: "audit-deny", sequence_no: 11, outcome: "deny", actor: { subject_id: "runtime-b", roles: ["runner"] } }),
        auditItem({ audit_id: "audit-error", sequence_no: 12, outcome: "error", previous_hash: null, actor: { subject_id: null, roles: [] } }),
      ],
      next_cursor: null,
    }));

    renderApp(fakeClient({ listAuditLog }));

    expect(await screen.findByRole("heading", { name: "SecretRef 감사 요약" })).toBeInTheDocument();
    expect(listAuditLog).toHaveBeenCalledWith({ action: "secret.resolve", limit: 100 });
    expect(await screen.findByText("최근 3건")).toBeInTheDocument();
    expect(screen.getByText("거부·차단")).toBeInTheDocument();
    expect(screen.getAllByText("오류").length).toBeGreaterThan(0);
    expect(screen.getByText("처리자 범위")).toBeInTheDocument();
    expect(screen.getByText("평문 비밀값과 audit payload 본문은 표시하지 않습니다.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "감사 이력" })).toHaveAttribute("href", "#auditExplorer?action=secret.resolve");
    expect(screen.getAllByText("처리자 확인됨").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("운영자").length).toBeGreaterThan(0);
    expect(screen.getByText("등록 외 역할")).toBeInTheDocument();
    expect(screen.queryByText("runtime-a")).toBeNull();
    expect(screen.queryByText("runtime-b")).toBeNull();
    expect(screen.getByText("처리자 미확인")).toBeInTheDocument();
  });
});
