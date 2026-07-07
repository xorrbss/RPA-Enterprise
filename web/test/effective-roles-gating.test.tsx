import { beforeEach, describe, expect, test } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { ApiClientProvider } from "../src/api/context";
import type { SiteItem } from "../src/api/types";
import { SiteApprovalControls } from "../src/views/security/SiteApprovalControls";
import { fakeClient } from "./fake-client";

// A3-1: UI 권한 게이팅이 토큰 클레임이 아니라 서버 효과 역할(토큰∪수동부여,
// /v1/auth/readiness current_principal.roles)을 따르는지 — 수동 부여가 화면에 반영되는 회귀 가드.
function jwt(roles: readonly string[]): string {
  const payload = btoa(JSON.stringify({ sub: "granted-user", tenant_id: "t", roles })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `e30.${payload}.sig`;
}

const pendingSite: SiteItem = {
  site_profile_id: "site-1",
  name: "고위험 사이트",
  risk: "red",
  approval_status: "pending",
  circuit_status: "closed",
};

function renderGated(overrides: Parameters<typeof fakeClient>[0] = {}): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ApiClientProvider client={fakeClient(overrides)}>
        <SiteApprovalControls site={pendingSite} />
      </ApiClientProvider>
    </QueryClientProvider>,
  );
}

describe("effective-roles-gating", () => {
  beforeEach(() => {
    // 토큰 클레임은 viewer뿐 — site.approve 없음.
    localStorage.setItem("rpa.token", jwt(["viewer"]));
  });

  test("수동 부여된 approver 역할(서버 효과 역할)이 승인 버튼을 노출한다", async () => {
    renderGated({
      getAuthReadiness: async () => ({
        ...(await fakeClient().getAuthReadiness()),
        current_principal: {
          subject_id: "granted-user",
          tenant_id: "t",
          roles: ["viewer", "approver"], // 토큰 viewer + 수동 부여 approver 합산
          source: "jwt",
          display_name: null,
          email: null,
        },
      }),
    });

    expect(await screen.findByRole("button", { name: "승인" })).toBeInTheDocument();
  });

  test("서버 효과 역할이 토큰과 같으면(부여 없음) 기존처럼 숨긴다", async () => {
    renderGated(); // 기본 fake = 토큰 미러(viewer)

    // 조회 완료 후에도 버튼 없음 — 폴링 여지를 주고 부재 확인.
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole("button", { name: "승인" })).toBeNull();
  });

  test("서버 조회 실패 시 토큰 클레임 폴백으로 동작한다(과차단 금지)", async () => {
    localStorage.setItem("rpa.token", jwt(["approver"]));
    renderGated({
      getAuthReadiness: async () => {
        throw new Error("readiness unavailable");
      },
    });

    // 폴백: 토큰의 approver로 게이팅 유지.
    expect(await screen.findByRole("button", { name: "승인" })).toBeInTheDocument();
  });
});
