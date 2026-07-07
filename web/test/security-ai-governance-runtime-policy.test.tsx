import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { App } from "../src/App";
import type { ApiClient } from "../src/api/client";
import { ApiClientProvider } from "../src/api/context";
import type {
  AiGovernanceRuntimePolicy,
  AiGovernanceRuntimePolicyEnvelope,
  AiGovernanceRuntimePolicyRequest,
} from "../src/api/types";
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
  const payload = btoa(JSON.stringify({ sub: "admin-a", tenant_id: "tenant-a", roles }))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `e30.${payload}.sig`;
}

const runtimePolicy: AiGovernanceRuntimePolicy = {
  policy_id: "ai-runtime-policy-prod",
  mode: "warn",
  subject_mapping_ref: "subject-map:ai-runtime/prod",
  grace_until: "2026-09-27T00:00:00.000Z",
  emergency_override_owner_ref: "team:ai-governance-oncall",
  audit_action: "ai_governance.enforce",
  policy_decision_ref: "policy-decision:ai-governance/runtime-enforcement",
  evidence_ref: "artifact:ai-governance/runtime-policy-prod",
  updated_by: "admin-a",
  created_at: "2026-06-29T00:00:00.000Z",
  updated_at: "2026-06-29T00:01:00.000Z",
};

function savedPolicy(body: AiGovernanceRuntimePolicyRequest): AiGovernanceRuntimePolicy {
  return {
    policy_id: "ai-runtime-policy-saved",
    mode: body.mode,
    subject_mapping_ref: body.subject_mapping_ref,
    grace_until: body.grace_until ?? null,
    emergency_override_owner_ref: body.emergency_override_owner_ref,
    audit_action: "ai_governance.enforce",
    policy_decision_ref: body.policy_decision_ref,
    evidence_ref: body.evidence_ref ?? null,
    updated_by: "admin-a",
    created_at: "2026-06-29T00:00:00.000Z",
    updated_at: "2026-06-29T00:10:00.000Z",
  };
}

describe("AI governance runtime policy panel", () => {
  beforeEach(() => {
    localStorage.clear();
    location.hash = "#security?section=ai";
  });

  test("viewer AI runtime policy deep link shows the read-only security summary only", async () => {
    localStorage.setItem("rpa.token", jwt(["viewer"]));
    const getAiGovernanceRuntimePolicy = vi.fn(async (): Promise<AiGovernanceRuntimePolicyEnvelope> => ({
      configured: true,
      policy: runtimePolicy,
    }));
    renderApp(fakeClient({ getAiGovernanceRuntimePolicy }));

    expect(await screen.findByRole("heading", { name: "보안 읽기 전용 요약" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "AI 거버넌스 읽기 전용 섹션 요약" })).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "보안 deep link 권한 안내" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "AI 운영 정책" })).toBeNull();
    expect(screen.queryByText("대상 subject-map:ai-runtime/prod")).toBeNull();
    expect(getAiGovernanceRuntimePolicy).not.toHaveBeenCalled();
  });

  test("admin upserts block policy with opaque refs and idempotency key", async () => {
    localStorage.setItem("rpa.token", jwt(["admin"]));
    const upsertAiGovernanceRuntimePolicy = vi.fn(async (body: AiGovernanceRuntimePolicyRequest, _idempotencyKey: string) => savedPolicy(body));
    renderApp(fakeClient({
      getAiGovernanceRuntimePolicy: async () => ({ configured: false }),
      upsertAiGovernanceRuntimePolicy,
    }));

    const panel = await screen.findByRole("region", { name: "AI 운영 정책" });
    const scoped = within(panel);
    await scoped.findByRole("button", { name: "운영 정책 저장" });
    fireEvent.change(scoped.getByLabelText("적용 방식"), { target: { value: "block" } });
    fireEvent.change(scoped.getByLabelText("대상 매핑 참조"), { target: { value: "subject-map:ai-runtime/prod" } });
    fireEvent.change(scoped.getByLabelText("긴급 해제 담당 참조"), { target: { value: "team:ai-governance-oncall" } });
    fireEvent.change(scoped.getByLabelText("정책 결정 참조"), {
      target: { value: "policy-decision:ai-governance/runtime-enforcement" },
    });
    fireEvent.change(scoped.getByLabelText("증빙 참조"), { target: { value: "artifact:ai-governance/runtime-policy-prod" } });
    fireEvent.click(scoped.getByRole("button", { name: "운영 정책 저장" }));

    await waitFor(() => expect(upsertAiGovernanceRuntimePolicy).toHaveBeenCalledTimes(1));
    const body = upsertAiGovernanceRuntimePolicy.mock.calls[0]?.[0];
    const key = upsertAiGovernanceRuntimePolicy.mock.calls[0]?.[1];
    expect(body).toEqual({
      mode: "block",
      subject_mapping_ref: "subject-map:ai-runtime/prod",
      grace_until: null,
      emergency_override_owner_ref: "team:ai-governance-oncall",
      policy_decision_ref: "policy-decision:ai-governance/runtime-enforcement",
      evidence_ref: "artifact:ai-governance/runtime-policy-prod",
    });
    expect(JSON.stringify(body)).not.toMatch(/https?:\/\//i);
    expect(JSON.stringify(body)).not.toMatch(/bearer\s+/i);
    expect(JSON.stringify(body)).not.toMatch(/\b(token|password|secret)=/i);
    expect(key).toMatch(/^ai-runtime-policy-block-subject-map:ai-runtime_prod-/);
  });

  test("admin form blocks endpoint or credential-looking values before save", async () => {
    localStorage.setItem("rpa.token", jwt(["admin"]));
    const upsertAiGovernanceRuntimePolicy = vi.fn(async (body: AiGovernanceRuntimePolicyRequest) => savedPolicy(body));
    renderApp(fakeClient({
      getAiGovernanceRuntimePolicy: async () => ({ configured: false }),
      upsertAiGovernanceRuntimePolicy,
    }));

    const panel = await screen.findByRole("region", { name: "AI 운영 정책" });
    const scoped = within(panel);
    await scoped.findByRole("button", { name: "운영 정책 저장" });
    fireEvent.change(scoped.getByLabelText("대상 매핑 참조"), { target: { value: "https://internal.example/runtime-policy" } });

    expect(scoped.getByRole("button", { name: "운영 정책 저장" })).toBeDisabled();
    expect(scoped.getByText("참조 값만 입력하세요. 주소(URL)나 비밀번호·토큰 같은 값은 지운 뒤 저장하세요.")).toBeInTheDocument();
    expect(upsertAiGovernanceRuntimePolicy).not.toHaveBeenCalled();
  });
});
