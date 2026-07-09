import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { App } from "../src/App";
import { ApiClientProvider } from "../src/api/context";
import type { ApiClient } from "../src/api/client";
import { ApiError, type DocumentJobCreateBody, type ExternalDocumentExtractionBody } from "../src/api/types";
import { fakeClient } from "./fake-client";

function jwt(roles: readonly string[]): string {
  const payload = btoa(JSON.stringify({ sub: "u", tenant_id: "t", roles })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `e30.${payload}.sig`;
}

function renderApp(client: ApiClient = fakeClient()): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ApiClientProvider client={client}>
        <App />
      </ApiClientProvider>
    </QueryClientProvider>,
  );
}

const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;

function mockScrollIntoView() {
  const scrollIntoView = vi.fn();
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: scrollIntoView,
  });
  return scrollIntoView;
}

describe("document IDP view", () => {
  beforeEach(() => {
    location.hash = "#documentIdp";
    localStorage.setItem("rpa.token", jwt(["viewer", "operator", "reviewer", "approver", "admin"]));
  });

  afterEach(() => {
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: originalScrollIntoView,
    });
  });

  test("scenario-start source deep link focuses and scrolls the document automation start", async () => {
    location.hash = "#documentIdp?source=scenario-start";
    const scrollIntoView = mockScrollIntoView();
    renderApp();

    const start = await screen.findByRole("region", { name: "문서 자동화 시작" });

    await waitFor(() => expect(start).toHaveFocus());
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "start" });
  });

  test("shows document jobs and extraction detail without raw technical IDs", async () => {
    renderApp();

    expect((await screen.findAllByText("문서 자동화")).length).toBeGreaterThan(0);
    const invoiceButton = await screen.findByRole("button", { name: "송장" });
    const invoiceRow = invoiceButton.closest("tr") as HTMLTableRowElement;
    expect(within(invoiceRow).getByText("검증 필요")).toBeInTheDocument();
    expect((await screen.findAllByText("invoice-data.json")).length).toBeGreaterThan(0);
    expect(screen.queryByText(/93000000-0000-4000-8000/)).not.toBeInTheDocument();
    expect(screen.queryByText(/source_artifact_id|field_schema|params JSON/)).not.toBeInTheDocument();

    fireEvent.click(within(invoiceRow).getByRole("button", { name: "결과 보기" }));

    expect(await screen.findByText("송장 상세")).toBeInTheDocument();
    expect(screen.getByText("필드 기준")).toBeInTheDocument();
    expect(screen.getByText("추출 결과")).toBeInTheDocument();
    expect(await screen.findByText("INV-7")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "검증 작업 열기" })).toBeInTheDocument();
  });

  test("creates a job from guided selections instead of raw JSON", async () => {
    const calls: DocumentJobCreateBody[] = [];
    renderApp(fakeClient({
      createDocumentJob: async (body) => {
        calls.push(body);
        return {
          document_job_id: "93000000-0000-4000-8000-000000000099",
          source_artifact_id: body.source_artifact_id,
          source_run_id: "11111111-aaaa-bbbb-cccc-000000000001",
          document_type: body.document_type,
          field_schema: body.field_schema,
          status: "created",
          created_by: "operator",
          created_at: "2026-06-23T09:10:00.000Z",
          updated_at: "2026-06-23T09:10:00.000Z",
        };
      },
    }));

    expect((await screen.findAllByText("invoice-data.json")).length).toBeGreaterThan(0);
    expect(screen.getByLabelText("추출 필드 요약")).toHaveTextContent("송장 필드 템플릿");
    expect(screen.queryByLabelText("추출 필드 편집")).toBeNull();
    expect(screen.queryByText("screen.png")).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "추출 작업 만들기" }));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({
      source_artifact_id: "72000000-0000-0000-0000-000000000001",
      document_type: "invoice",
    });
    expect(calls[0]?.field_schema.map((field) => field.key)).toEqual(["invoice_id", "total", "approved"]);
    expect(await screen.findByText("문서 추출 작업을 만들었습니다.")).toBeInTheDocument();
  });

  test("document-idp-desktop-workflow keeps field editor hidden until explicit field edit intent", async () => {
    renderApp(fakeClient({
      listRuns: async () => ({ items: [], next_cursor: null }),
    }));

    expect((await screen.findAllByRole("heading", { name: "문서 자동화" })).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("실행 기록 필요")).toBeInTheDocument();
    expect(screen.getByText("소스 선택 필요")).toBeInTheDocument();
    expect(screen.getByLabelText("추출 필드 요약")).toHaveTextContent("송장 필드 템플릿");
    expect(screen.getByLabelText("추출 필드 요약")).toHaveTextContent("송장 번호");
    expect(screen.getByRole("button", { name: "실행 산출물 찾기" })).toBeInTheDocument();
    expect(screen.queryByLabelText("추출 필드 편집")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "필드 편집" }));

    expect(await screen.findByLabelText("추출 필드 편집")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "필드 추가" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "필드 편집 닫기" })).toBeInTheDocument();
  });

  test("shows source artifact load failures separately from missing source state", async () => {
    renderApp(fakeClient({
      listRunArtifacts: async () => {
        throw new ApiError(500, "CONTROL_PLANE_INTERNAL_ERROR", { code: "CONTROL_PLANE_INTERNAL_ERROR" });
      },
    }));

    expect(await screen.findByText("산출물 로드 실패")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("실행 산출물을 확인하지 못했습니다.");
    expect(screen.queryByText("소스 선택 필요")).not.toBeInTheDocument();
    expect(screen.getByLabelText("추출 필드 요약")).toHaveTextContent("송장 필드 템플릿");
    expect(screen.queryByLabelText("추출 필드 편집")).toBeNull();
  });

  test("edits extraction fields as business form rows before creating a job", async () => {
    const calls: DocumentJobCreateBody[] = [];
    renderApp(fakeClient({
      createDocumentJob: async (body) => {
        calls.push(body);
        return {
          document_job_id: "93000000-0000-4000-8000-000000000099",
          source_artifact_id: body.source_artifact_id,
          source_run_id: "11111111-aaaa-bbbb-cccc-000000000001",
          document_type: body.document_type,
          field_schema: body.field_schema,
          status: "created",
          created_by: "operator",
          created_at: "2026-06-23T09:10:00.000Z",
          updated_at: "2026-06-23T09:10:00.000Z",
        };
      },
    }));

    expect((await screen.findAllByText("invoice-data.json")).length).toBeGreaterThan(0);
    expect(screen.queryByLabelText("추출 필드 편집")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "필드 편집" }));
    fireEvent.click(screen.getByRole("button", { name: "필드 추가" }));
    fireEvent.change(screen.getByLabelText("필드 키 4"), { target: { value: "due_date" } });
    fireEvent.change(screen.getByLabelText("표시 이름 4"), { target: { value: "지급 예정일" } });
    fireEvent.change(screen.getByLabelText("필드 유형 4"), { target: { value: "date" } });
    fireEvent.click(screen.getByLabelText("필수 필드 4"));
    fireEvent.change(screen.getByLabelText("신뢰도 기준 4"), { target: { value: "0.9" } });
    fireEvent.change(screen.getByLabelText("별칭 4"), { target: { value: "Due Date, Payment Due" } });
    fireEvent.click(screen.getByRole("button", { name: "추출 작업 만들기" }));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.field_schema).toContainEqual({
      key: "due_date",
      label: "지급 예정일",
      type: "date",
      required: true,
      min_confidence: 0.9,
      aliases: ["Due Date", "Payment Due"],
    });
    expect(screen.queryByText(/field_schema|params JSON/)).not.toBeInTheDocument();
  });

  test("uses run and artifact deep links to create a job from real run artifacts", async () => {
    location.hash = "#documentIdp?run=run-doc-1&artifact=artifact-doc-2";
    const artifactRunCalls: string[] = [];
    const calls: DocumentJobCreateBody[] = [];
    renderApp(fakeClient({
      listRuns: async () => ({ items: [], next_cursor: null }),
      listRunArtifacts: async (runId) => {
        artifactRunCalls.push(runId);
        return {
          items: [
            {
              artifact_id: "artifact-image-1",
              type: "screen_capture",
              media_type: "image/png",
              filename: "screen.png",
              byte_size: 1024,
              duration_ms: null,
              redaction_status: "redacted",
              retention_until: null,
              legal_hold: false,
              created_at: "2026-06-23T09:00:00.000Z",
            },
            {
              artifact_id: "artifact-doc-2",
              type: "downloaded_file",
              media_type: "text/csv",
              filename: "contract-fields.csv",
              byte_size: 2048,
              duration_ms: null,
              redaction_status: "redacted",
              retention_until: null,
              legal_hold: false,
              created_at: "2026-06-23T09:00:01.000Z",
            },
          ],
          next_cursor: null,
        };
      },
      createDocumentJob: async (body) => {
        calls.push(body);
        return {
          document_job_id: "93000000-0000-4000-8000-000000000099",
          source_artifact_id: body.source_artifact_id,
          source_run_id: "run-doc-1",
          document_type: body.document_type,
          field_schema: body.field_schema,
          status: "created",
          created_by: "operator",
          created_at: "2026-06-23T09:10:00.000Z",
          updated_at: "2026-06-23T09:10:00.000Z",
        };
      },
    }));

    expect(await screen.findByText("contract-fields.csv")).toBeInTheDocument();
    expect(screen.queryByText("screen.png")).not.toBeInTheDocument();
    await waitFor(() => expect(artifactRunCalls).toContain("run-doc-1"));
    fireEvent.click(screen.getByRole("button", { name: "추출 작업 만들기" }));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.source_artifact_id).toBe("artifact-doc-2");
  });

  test("runs extraction and opens the human validation queue from row actions", async () => {
    const extracted: string[] = [];
    const validationJobs: string[] = [];
    renderApp(fakeClient({
      extractDocumentJob: async (jobId) => {
        extracted.push(jobId);
        return {
          document_extraction_id: "94000000-0000-4000-8000-000000000001",
          document_job_id: jobId,
          engine: "built_in_deterministic_text_v1",
          status: "validation_required",
          provider_alias: null,
          provider_receipt_id: null,
          normalized_schema_ref: null,
          evidence_ref: null,
          provider_metadata: {},
          fields: [],
          missing_fields: ["invoice_id"],
          validation_human_task_id: null,
          created_at: "2026-06-23T09:00:03.000Z",
          updated_at: "2026-06-23T09:00:03.000Z",
        };
      },
      createDocumentValidationTask: async (jobId) => {
        validationJobs.push(jobId);
        return {
          human_task_id: "55000000-0000-0000-0000-000000000055",
          state: "open",
          result_schema: { version: "business_form_v1", fields: [] },
          artifact_refs: ["72000000-0000-0000-0000-000000000001"],
        };
      },
    }));

    const invoiceButton = await screen.findByRole("button", { name: "송장" });
    const invoiceRow = invoiceButton.closest("tr") as HTMLTableRowElement;
    fireEvent.click(within(invoiceRow).getByRole("button", { name: "추출 실행" }));

    await waitFor(() => expect(extracted).toEqual(["93000000-0000-4000-8000-000000000001"]));
    expect(await screen.findByText("추출 완료: 검증이 필요한 필드가 있습니다.")).toBeInTheDocument();

    fireEvent.click(within(invoiceRow).getByRole("button", { name: "검증 작업" }));

    await waitFor(() => expect(validationJobs).toEqual(["93000000-0000-4000-8000-000000000001"]));
    expect(location.hash).toBe("#humanTasks?ht=55000000-0000-0000-0000-000000000055");
  });

  test("records external IDP normalized result as metadata-only alias and refs", async () => {
    const calls: Array<{ readonly jobId: string; readonly body: ExternalDocumentExtractionBody }> = [];
    renderApp(fakeClient({
      recordExternalDocumentExtraction: async (jobId, body) => {
        calls.push({ jobId, body });
        return {
          document_extraction_id: "94000000-0000-4000-8000-0000000000e1",
          document_job_id: jobId,
          engine: "external_idp_adapter_v1",
          status: "completed",
          provider_alias: body.provider_alias,
          provider_receipt_id: body.receipt_id,
          normalized_schema_ref: body.normalized_schema_ref,
          evidence_ref: body.evidence_ref ?? null,
          provider_metadata: body.metadata ?? {},
          fields: body.fields.map((field) => ({
            key: field.key,
            label: field.key,
            value: field.value === null ? null : String(field.value),
            confidence: field.confidence,
            status: field.value === null ? "missing" as const : "extracted" as const,
            source: "external_idp" as const,
          })),
          missing_fields: [],
          validation_human_task_id: null,
          created_at: "2026-06-23T09:00:05.000Z",
          updated_at: "2026-06-23T09:00:05.000Z",
        };
      },
    }));

    const invoiceButton = await screen.findByRole("button", { name: "송장" });
    fireEvent.click(within(invoiceButton.closest("tr") as HTMLTableRowElement).getByRole("button", { name: "결과 보기" }));

    expect(await screen.findByRole("form", { name: "외부 IDP normalized 결과 등록" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Provider alias"), { target: { value: "external-idp-prod" } });
    fireEvent.change(screen.getByLabelText("Receipt ref"), { target: { value: "receipt-20260630-001" } });
    fireEvent.change(screen.getByLabelText("Schema ref"), { target: { value: "document-extraction/invoice@1" } });
    fireEvent.change(screen.getByLabelText("Evidence ref"), { target: { value: "artifact:72000000-0000-0000-0000-000000000001" } });
    fireEvent.change(screen.getByLabelText("Provider metadata ref"), { target: { value: "metadata:external-idp-prod/batch-001" } });
    fireEvent.change(screen.getByLabelText("외부 필드 값 송장 번호"), { target: { value: "INV-900" } });
    fireEvent.change(screen.getByLabelText("외부 필드 신뢰도 송장 번호"), { target: { value: "0.93" } });
    fireEvent.change(screen.getByLabelText("외부 필드 값 금액"), { target: { value: "1200" } });
    fireEvent.change(screen.getByLabelText("외부 필드 신뢰도 금액"), { target: { value: "0.88" } });
    fireEvent.change(screen.getByLabelText("외부 필드 값 승인 여부"), { target: { value: "true" } });
    fireEvent.click(screen.getByRole("button", { name: "외부 결과 등록" }));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.jobId).toBe("93000000-0000-4000-8000-000000000001");
    expect(calls[0]?.body).toMatchObject({
      provider_alias: "external-idp-prod",
      receipt_id: "receipt-20260630-001",
      normalized_schema_ref: "document-extraction/invoice@1",
      evidence_ref: "artifact:72000000-0000-0000-0000-000000000001",
      metadata: {
        intake_mode: "metadata_only",
        provider_alias_ref: "external-idp-prod",
        receipt_ref: "receipt-20260630-001",
        normalized_schema_ref: "document-extraction/invoice@1",
        provider_metadata_ref: "metadata:external-idp-prod/batch-001",
      },
    });
    expect(calls[0]?.body.fields).toEqual([
      { key: "invoice_id", value: "INV-900", confidence: 0.93 },
      { key: "total", value: 1200, confidence: 0.88 },
      { key: "approved", value: true, confidence: 0.7 },
    ]);
    expect(JSON.stringify(calls[0]?.body).toLowerCase()).not.toMatch(/raw_ocr|provider_response|token|secret|document_bytes/);
    expect(await screen.findByText("외부 IDP normalized 결과를 metadata-only로 등록했습니다.")).toBeInTheDocument();
    expect(screen.getByText("external-idp-prod")).toBeInTheDocument();
    expect(screen.getByText("receipt-20260630-001")).toBeInTheDocument();
  });

  test("blocks raw external URL or secret-shaped values before recording external results", async () => {
    const calls: ExternalDocumentExtractionBody[] = [];
    renderApp(fakeClient({
      recordExternalDocumentExtraction: async (_jobId, body) => {
        calls.push(body);
        return {
          document_extraction_id: "94000000-0000-4000-8000-0000000000e1",
          document_job_id: "93000000-0000-4000-8000-000000000001",
          engine: "external_idp_adapter_v1",
          status: "completed",
          provider_alias: body.provider_alias,
          provider_receipt_id: body.receipt_id,
          normalized_schema_ref: body.normalized_schema_ref,
          evidence_ref: body.evidence_ref ?? null,
          provider_metadata: body.metadata ?? {},
          fields: [],
          missing_fields: [],
          validation_human_task_id: null,
          created_at: "2026-06-23T09:00:05.000Z",
          updated_at: "2026-06-23T09:00:05.000Z",
        };
      },
    }));

    const invoiceButton = await screen.findByRole("button", { name: "송장" });
    fireEvent.click(within(invoiceButton.closest("tr") as HTMLTableRowElement).getByRole("button", { name: "결과 보기" }));

    fireEvent.change(await screen.findByLabelText("Receipt ref"), { target: { value: "receipt-20260630-002" } });
    fireEvent.change(screen.getByLabelText("Schema ref"), { target: { value: "document-extraction/invoice@1" } });
    fireEvent.change(screen.getByLabelText("Provider metadata ref"), { target: { value: "https://idp.example/raw/provider-response?token=secret" } });
    fireEvent.change(screen.getByLabelText("외부 필드 값 송장 번호"), { target: { value: "INV-901" } });

    expect(await screen.findByRole("alert")).toHaveTextContent("raw URL, token, secret, provider response body");
    expect(screen.getByRole("button", { name: "외부 결과 등록" })).toBeDisabled();
    expect(calls).toHaveLength(0);
    expect(screen.queryByLabelText(/raw OCR|provider response body|raw document bytes/i)).not.toBeInTheDocument();
  });

  test("shows missing extraction as empty state but real extraction errors as retryable errors", async () => {
    renderApp(fakeClient({
      listDocumentJobs: async () => ({
        items: [{
          document_job_id: "93000000-0000-4000-8000-000000000001",
          source_artifact_id: "72000000-0000-0000-0000-000000000001",
          source_run_id: "11111111-aaaa-bbbb-cccc-000000000001",
          document_type: "invoice",
          field_schema: [{ key: "invoice_id", label: "송장 번호", required: true, type: "text", min_confidence: 0.8 }],
          status: "created",
          created_by: "auth0|raw-subject",
          created_at: "2026-06-23T09:00:00.000Z",
          updated_at: "2026-06-23T09:00:03.000Z",
        }],
        next_cursor: null,
      }),
      getDocumentExtraction: async () => {
        throw new ApiError(404, "RESOURCE_NOT_FOUND", { code: "RESOURCE_NOT_FOUND" });
      },
    }));

    const invoiceButton = await screen.findByRole("button", { name: "송장" });
    fireEvent.click(within(invoiceButton.closest("tr") as HTMLTableRowElement).getByRole("button", { name: "결과 보기" }));

    expect(await screen.findByText("아직 저장된 추출 결과가 없습니다.")).toBeInTheDocument();
    expect(screen.getByText("등록자 확인됨")).toBeInTheDocument();
    expect(screen.queryByText("auth0|raw-subject")).not.toBeInTheDocument();
  });

  test("does not treat extraction load failures as no-result state", async () => {
    renderApp(fakeClient({
      getDocumentExtraction: async () => {
        throw new ApiError(500, "CONTROL_PLANE_INTERNAL_ERROR", { code: "CONTROL_PLANE_INTERNAL_ERROR" });
      },
    }));

    const invoiceButton = await screen.findByRole("button", { name: "송장" });
    fireEvent.click(within(invoiceButton.closest("tr") as HTMLTableRowElement).getByRole("button", { name: "결과 보기" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("운영 실패");
    expect(alert).toHaveTextContent("추출 결과를 확인하지 못했습니다.");
    expect(screen.queryByText("아직 저장된 추출 결과가 없습니다.")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "다시 시도" })).toBeInTheDocument();
  });
});
