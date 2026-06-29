import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { App } from "../src/App";
import type { ApiClient } from "../src/api/client";
import { ApiClientProvider } from "../src/api/context";
import type {
  AiGovernanceEvidence,
  AiGovernanceEvidenceListParams,
  AiGovernanceEvidenceRequest,
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

const modelEvidence: AiGovernanceEvidence = {
  evidence_id: "ai-governance-evidence-model",
  evidence_type: "model_registry",
  subject_ref: "model:codex-prod-primary",
  status: "valid",
  evidence_at: "2026-06-29T00:00:00.000Z",
  expires_at: "2026-09-27T23:59:59.000Z",
  summary: "Model registry approval recorded with policy and audit linkage",
  evidence_ref: "artifact:ai-governance/model-registry-codex-prod-primary",
  policy_decision_ref: "policy-decision:ai-governance/model-approval",
  audit_correlation_id: "71000000-0000-4000-8000-000000000001",
  metadata: {
    provider_alias: "provider:primary-ai",
    model_alias: "model:codex-prod-primary",
    model_version: "2026-06-approved",
    risk_tier: "medium",
    data_retention_policy_ref: "policy:data-retention/ai",
    tenant_allowlist_ref: "tenant-allowlist:controlled-prod",
    approved_at: "2026-06-29T00:00:00.000Z",
  },
  recorded_by: "admin-a",
  recorded_at: "2026-06-29T00:01:00.000Z",
  legal_hold: false,
};

const deferredCostEvidence: AiGovernanceEvidence = {
  evidence_id: "ai-governance-evidence-cost",
  evidence_type: "cost_control",
  subject_ref: "budget:ai-gateway/controlled-prod",
  status: "deferred",
  evidence_at: "2026-06-29T00:05:00.000Z",
  expires_at: null,
  summary: "Cost control owner evidence pending",
  evidence_ref: null,
  policy_decision_ref: null,
  audit_correlation_id: null,
  metadata: {
    budget_ref: "budget:ai-gateway/controlled-prod",
    scope_ref: "scope:tenant-a/prod",
  },
  recorded_by: "operator-a",
  recorded_at: "2026-06-29T00:06:00.000Z",
  legal_hold: false,
};

function filterEvidence(params: AiGovernanceEvidenceListParams | undefined): readonly AiGovernanceEvidence[] {
  return [modelEvidence, deferredCostEvidence].filter((item) =>
    (params?.evidence_type === undefined || item.evidence_type === params.evidence_type) &&
    (params?.status === undefined || item.status === params.status) &&
    (params?.subject_ref === undefined || item.subject_ref === params.subject_ref),
  );
}

function recordedEvidence(body: AiGovernanceEvidenceRequest): AiGovernanceEvidence {
  return {
    evidence_id: "ai-governance-evidence-recorded",
    evidence_type: body.evidence_type,
    subject_ref: body.subject_ref,
    status: body.status,
    evidence_at: body.evidence_at,
    expires_at: body.expires_at ?? null,
    summary: body.summary,
    evidence_ref: body.evidence_ref ?? null,
    policy_decision_ref: body.policy_decision_ref ?? null,
    audit_correlation_id: body.audit_correlation_id ?? null,
    metadata: body.metadata ?? {},
    recorded_by: "admin-a",
    recorded_at: "2026-06-29T00:10:00.000Z",
    legal_hold: body.legal_hold ?? false,
  };
}

describe("AI governance evidence panel", () => {
  beforeEach(() => {
    localStorage.clear();
    location.hash = "#security";
  });

  test("viewer filters AI governance evidence by status and subject", async () => {
    localStorage.setItem("rpa.token", jwt(["viewer"]));
    const listAiGovernanceEvidence = vi.fn(async (params?: AiGovernanceEvidenceListParams) => ({
      items: filterEvidence(params),
      next_cursor: null,
    }));
    renderApp(fakeClient({ listAiGovernanceEvidence }));

    const panel = await screen.findByRole("region", { name: "AI governance evidence" });
    expect(await within(panel).findByText("Model registry approval recorded with policy and audit linkage")).toBeInTheDocument();
    expect(within(panel).getByText("Cost control owner evidence pending")).toBeInTheDocument();

    fireEvent.change(within(panel).getByLabelText("Status"), { target: { value: "deferred" } });
    await waitFor(() => expect(listAiGovernanceEvidence).toHaveBeenLastCalledWith({ limit: 25, status: "deferred" }));
    expect(await within(panel).findByText("Cost control owner evidence pending")).toBeInTheDocument();

    fireEvent.change(within(panel).getByLabelText("Subject"), { target: { value: "budget:ai-gateway/controlled-prod" } });
    fireEvent.click(within(panel).getByRole("button", { name: "Apply" }));
    await waitFor(() =>
      expect(listAiGovernanceEvidence).toHaveBeenLastCalledWith({
        limit: 25,
        status: "deferred",
        subject_ref: "budget:ai-gateway/controlled-prod",
      }),
    );
  });

  test("admin records a valid model registry evidence template with refs only", async () => {
    localStorage.setItem("rpa.token", jwt(["admin"]));
    const recordAiGovernanceEvidence = vi.fn(async (body: AiGovernanceEvidenceRequest, _idempotencyKey: string) => recordedEvidence(body));
    renderApp(fakeClient({
      listAiGovernanceEvidence: async () => ({ items: [], next_cursor: null }),
      recordAiGovernanceEvidence,
    }));

    const panel = await screen.findByRole("region", { name: "AI governance evidence" });
    const scoped = within(panel);
    const recordButton = scoped.getByRole("button", { name: "Record AI evidence" });
    expect(recordButton).toBeDisabled();

    fireEvent.change(scoped.getByLabelText("Audit correlation id"), {
      target: { value: "71000000-0000-4000-8000-000000000099" },
    });
    expect(recordButton).not.toBeDisabled();
    fireEvent.click(recordButton);

    await waitFor(() => expect(recordAiGovernanceEvidence).toHaveBeenCalledTimes(1));
    const body = recordAiGovernanceEvidence.mock.calls[0]?.[0];
    const key = recordAiGovernanceEvidence.mock.calls[0]?.[1];
    expect(body).toMatchObject({
      evidence_type: "model_registry",
      status: "valid",
      subject_ref: "model:codex-prod-primary",
      evidence_ref: "artifact:ai-governance/model-registry-codex-prod-primary",
      policy_decision_ref: "policy-decision:ai-governance/model-approval",
      audit_correlation_id: "71000000-0000-4000-8000-000000000099",
      metadata: {
        provider_alias: "provider:primary-ai",
        model_alias: "model:codex-prod-primary",
        risk_tier: "medium",
        data_retention_policy_ref: "policy:data-retention/ai",
        tenant_allowlist_ref: "tenant-allowlist:controlled-prod",
      },
    });
    expect(JSON.stringify(body)).not.toMatch(/https?:\/\//i);
    expect(JSON.stringify(body)).not.toMatch(/bearer\s+/i);
    expect(key).toMatch(/^ai-governance-model_registry-model:codex-prod-primary-/);
  });

  test("admin can record deferred evidence without policy and audit linkage", async () => {
    localStorage.setItem("rpa.token", jwt(["admin"]));
    const recordAiGovernanceEvidence = vi.fn(async (body: AiGovernanceEvidenceRequest, _idempotencyKey: string) => recordedEvidence(body));
    renderApp(fakeClient({
      listAiGovernanceEvidence: async () => ({ items: [], next_cursor: null }),
      recordAiGovernanceEvidence,
    }));

    const panel = await screen.findByRole("region", { name: "AI governance evidence" });
    const form = within(panel).getByRole("button", { name: "Record AI evidence" }).closest("form");
    expect(form).not.toBeNull();
    const scoped = within(form as HTMLElement);

    fireEvent.change(scoped.getByLabelText("Status"), { target: { value: "deferred" } });
    fireEvent.change(scoped.getByLabelText("Evidence ref"), { target: { value: "" } });
    fireEvent.change(scoped.getByLabelText("Policy decision ref"), { target: { value: "" } });
    fireEvent.change(scoped.getByLabelText("Summary"), { target: { value: "Owner evidence pending for model registry approval" } });
    fireEvent.click(scoped.getByRole("button", { name: "Record AI evidence" }));

    await waitFor(() => expect(recordAiGovernanceEvidence).toHaveBeenCalledTimes(1));
    const body = recordAiGovernanceEvidence.mock.calls[0]?.[0];
    expect(body).toMatchObject({
      evidence_type: "model_registry",
      status: "deferred",
      subject_ref: "model:codex-prod-primary",
      summary: "Owner evidence pending for model registry approval",
    });
    expect(body?.evidence_ref).toBeUndefined();
    expect(body?.policy_decision_ref).toBeUndefined();
    expect(body?.audit_correlation_id).toBeUndefined();
  });

  test("admin form blocks endpoint or credential-looking text before record", async () => {
    localStorage.setItem("rpa.token", jwt(["admin"]));
    const recordAiGovernanceEvidence = vi.fn(async (body: AiGovernanceEvidenceRequest, _idempotencyKey: string) => recordedEvidence(body));
    renderApp(fakeClient({
      listAiGovernanceEvidence: async () => ({ items: [], next_cursor: null }),
      recordAiGovernanceEvidence,
    }));

    const panel = await screen.findByRole("region", { name: "AI governance evidence" });
    const form = within(panel).getByRole("button", { name: "Record AI evidence" }).closest("form");
    expect(form).not.toBeNull();
    const scoped = within(form as HTMLElement);

    fireEvent.change(scoped.getByLabelText("Audit correlation id"), {
      target: { value: "71000000-0000-4000-8000-000000000099" },
    });
    fireEvent.change(scoped.getByLabelText("Summary"), { target: { value: "see https://internal.example/evidence" } });

    expect(scoped.getByRole("button", { name: "Record AI evidence" })).toBeDisabled();
    expect(scoped.getByText("Use opaque refs only; remove endpoints or credential-like material before recording.")).toBeInTheDocument();
    expect(recordAiGovernanceEvidence).not.toHaveBeenCalled();
  });
});
