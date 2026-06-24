import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, test } from "vitest";

import { App } from "../src/App";
import type { ApiClient } from "../src/api/client";
import { ApiClientProvider } from "../src/api/context";
import type { AuthReadiness } from "../src/api/types";
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
  const payload = btoa(JSON.stringify({ sub: "viewer-a", tenant_id: "tenant-a", roles }))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `e30.${payload}.sig`;
}

const HS256_WARNING: AuthReadiness = {
  status: "warning",
  enterprise_sso_ready: false,
  provider: {
    mode: "hs256",
    configuration_source: "deployment_config",
    algorithm: "HS256",
    jwks_url_configured: false,
    jwks_host: null,
    issuer_configured: false,
    issuer: null,
    audience_configured: false,
    audience: null,
  },
  claim_mapping: {
    subject_claim: "sub",
    tenant_claim: "tenant_id",
    roles_claim: "roles",
    expiry_claim: "exp",
    display_name_claim: "name",
    email_claim: "email",
  },
  role_mapping: {
    configured: false,
    mapped_values: 0,
  },
  required_claims: [
    { claim: "sub", label: "처리자 식별", required: true, present: true, mapped_to: "current_principal.subject_id" },
    { claim: "tenant_id", label: "테넌트 경계", required: true, present: true, mapped_to: "current_principal.tenant_id" },
    { claim: "roles", label: "역할 매핑", required: true, present: true, mapped_to: "current_principal.roles" },
    { claim: "exp", label: "만료 시간", required: true, present: true, mapped_to: "인증 만료 검증" },
  ],
  current_principal: {
    subject_id: "viewer-a",
    tenant_id: "tenant-a",
    roles: ["viewer"],
    source: "jwt",
    display_name: null,
    email: null,
  },
  operational_gaps: [
    "운영 SSO 검증을 위해 RS256/JWKS 모드가 필요합니다.",
    "토큰 발급자(issuer) 검증이 설정되지 않았습니다.",
    "토큰 대상(audience) 검증이 설정되지 않았습니다.",
  ],
};

describe("security auth readiness", () => {
  beforeEach(() => {
    location.hash = "#security";
    localStorage.setItem("rpa.token", jwt(["viewer"]));
  });

  test("JWKS 기반 SSO 준비 상태를 현업 문구로 표시한다", async () => {
    renderApp(fakeClient());

    expect(await screen.findByRole("heading", { name: "SSO/IdP 준비도" })).toBeInTheDocument();
    expect(await screen.findByText("운영 SSO 준비됨")).toBeInTheDocument();
    expect(await screen.findByText("RS256 / JWKS")).toBeInTheDocument();
    expect(screen.getAllByText("확인됨").length).toBeGreaterThanOrEqual(4);
    expect(screen.queryByText("JWKS_URL")).not.toBeInTheDocument();
  });

  test("HS256 배포 설정은 SSO 보강 항목을 노출한다", async () => {
    renderApp(fakeClient({ getAuthReadiness: async () => HS256_WARNING }));

    expect(await screen.findByText("보강 필요")).toBeInTheDocument();
    expect(screen.getByText("HS256 공유키")).toBeInTheDocument();
    expect(screen.getByText("운영 SSO 검증을 위해 RS256/JWKS 모드가 필요합니다.")).toBeInTheDocument();
    expect(screen.getByText("토큰 발급자(issuer) 검증이 설정되지 않았습니다.")).toBeInTheDocument();
    expect(screen.getByText("토큰 대상(audience) 검증이 설정되지 않았습니다.")).toBeInTheDocument();
  });
});
