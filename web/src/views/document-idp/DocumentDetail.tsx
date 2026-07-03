import { useEffect, useState } from "react";

import type {
  DocumentExtraction,
  DocumentFieldSchema,
  DocumentFieldType,
  DocumentJobItem,
  ExternalDocumentExtractionBody,
  RunArtifactItem,
} from "../../api/types";
import { EmptyState, Loading } from "../../components/states";
import { navigate } from "../../router";
import { formatDateTime } from "../../util/time";
import {
  artifactLabelById,
  documentTypeLabel,
  fieldSourceLabel,
  fieldTypeLabel,
  isExtractionNotFound,
  principalDisplayLabel,
  requiredFieldCount,
} from "./helpers";
import { ClassifiedErrorState, DocumentExtractionStatusBadge, DocumentStatusBadge, FieldStatusBadge } from "./status";

type ExternalFieldDraft = {
  readonly key: string;
  readonly label: string;
  readonly type: DocumentFieldType;
  readonly value: string;
  readonly confidence: string;
};

export function DocumentDetail(props: {
  job: DocumentJobItem | null;
  isLoading: boolean;
  extraction: DocumentExtraction | null;
  extractionError: unknown | null;
  sourceArtifacts: readonly RunArtifactItem[];
  onExtract: (jobId: string) => void;
  onRetryExtraction: () => void;
  onCreateValidationTask: (jobId: string) => void;
  onRecordExternalExtraction: (jobId: string, body: ExternalDocumentExtractionBody) => void;
  isRecordingExternalExtraction: boolean;
  externalExtractionError: unknown | null;
}): JSX.Element {
  if (props.isLoading) {
    return (
      <section className="panel" aria-label="문서 자동화 상세">
        <div className="panel-body"><Loading /></div>
      </section>
    );
  }
  if (props.job === null) {
    return (
      <section className="panel" aria-label="문서 자동화 상세">
        <div className="panel-body"><EmptyState message="목록에서 문서 작업을 선택하세요." /></div>
      </section>
    );
  }
  return (
    <section className="panel" aria-label="문서 자동화 상세">
      <div className="panel-head">
        <div>
          <h2>{documentTypeLabel(props.job.document_type)} 상세</h2>
          <p className="subtle">검증 기준: {requiredFieldCount(props.job.field_schema)}개 필수 필드 · 엔진 built-in deterministic text v1</p>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button className="btn" type="button" onClick={() => navigate("runTrace", { run: props.job!.source_run_id, focus: "artifacts" })}>실행 기록</button>
          <button className="btn" type="button" onClick={() => props.onExtract(props.job!.document_job_id)}>다시 추출</button>
          <button className="btn primary" type="button" onClick={() => props.onCreateValidationTask(props.job!.document_job_id)}>검증 큐로 보내기</button>
        </div>
      </div>
      <div className="panel-body">
        <dl className="kv-grid">
          <div><dt>상태</dt><dd><DocumentStatusBadge status={props.job.status} /></dd></div>
          <div><dt>증빙 자료</dt><dd>{artifactLabelById(props.job.source_artifact_id, props.sourceArtifacts)}</dd></div>
          <div><dt>생성자</dt><dd>{principalDisplayLabel(props.job.created_by)}</dd></div>
          <div><dt>업데이트</dt><dd>{formatDateTime(props.job.updated_at)}</dd></div>
        </dl>
        <h3>필드 기준</h3>
        <div className="table-wrap">
          <table className="ops-table">
            <thead><tr><th>필드</th><th>유형</th><th>필수 여부</th><th>신뢰도 기준</th></tr></thead>
            <tbody>
              {props.job.field_schema.map((field) => (
                <tr key={field.key}>
                  <td>{field.label ?? field.key}</td>
                  <td>{fieldTypeLabel(field.type ?? "text")}</td>
                  <td>{field.required === true ? "필수" : "선택"}</td>
                  <td>{Math.round((field.min_confidence ?? 0.8) * 100)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <h3>추출 결과</h3>
        {props.extractionError !== null && isExtractionNotFound(props.extractionError) ? (
          <EmptyState title="첫 실행 전" message="아직 저장된 추출 결과가 없습니다." action={<button className="btn" type="button" onClick={() => props.onExtract(props.job!.document_job_id)}>지금 추출</button>} />
        ) : props.extractionError !== null ? (
          <ClassifiedErrorState error={props.extractionError} message="추출 결과를 확인하지 못했습니다." onRetry={props.onRetryExtraction} />
        ) : props.extraction === null ? (
          <Loading />
        ) : (
          <ExtractionResult extraction={props.extraction} />
        )}
        <ExternalExtractionForm
          job={props.job}
          isPending={props.isRecordingExternalExtraction}
          error={props.externalExtractionError}
          onSubmit={(body) => props.onRecordExternalExtraction(props.job!.document_job_id, body)}
        />
      </div>
    </section>
  );
}

function ExtractionResult(props: { extraction: DocumentExtraction }): JSX.Element {
  return (
    <div className="stack">
      <div className="inline-list">
        <DocumentExtractionStatusBadge status={props.extraction.status} />
        <span className="badge muted">검증 필요 {props.extraction.missing_fields.length}개</span>
        {props.extraction.provider_alias !== null && <span className="badge blue">외부 IDP</span>}
        {props.extraction.validation_human_task_id !== null && (
          <button className="linklike" type="button" onClick={() => navigate("humanTasks", { ht: props.extraction.validation_human_task_id! })}>
            검증 작업 열기
          </button>
        )}
      </div>
      {props.extraction.provider_alias !== null && (
        <dl className="kv-grid" aria-label="외부 IDP metadata">
          <div><dt>Provider alias</dt><dd>{props.extraction.provider_alias}</dd></div>
          <div><dt>Receipt ref</dt><dd>{props.extraction.provider_receipt_id ?? "미등록"}</dd></div>
          <div><dt>Schema ref</dt><dd>{props.extraction.normalized_schema_ref ?? "미등록"}</dd></div>
          <div><dt>Evidence ref</dt><dd>{props.extraction.evidence_ref ?? "미등록"}</dd></div>
        </dl>
      )}
      <div className="table-wrap">
        <table className="ops-table">
          <thead><tr><th>필드</th><th>값</th><th>상태</th><th>근거</th></tr></thead>
          <tbody>
            {props.extraction.fields.map((field) => (
              <tr key={field.key}>
                <td>{field.label}</td>
                <td>{field.value ?? "확인 필요"}</td>
                <td><FieldStatusBadge field={field} /></td>
                <td>{fieldSourceLabel(field.source)} · {Math.round(field.confidence * 100)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ExternalExtractionForm(props: {
  readonly job: DocumentJobItem;
  readonly isPending: boolean;
  readonly error: unknown | null;
  readonly onSubmit: (body: ExternalDocumentExtractionBody) => void;
}): JSX.Element {
  const [providerAlias, setProviderAlias] = useState("external-idp");
  const [receiptId, setReceiptId] = useState("");
  const [normalizedSchemaRef, setNormalizedSchemaRef] = useState(() => defaultSchemaRef(props.job));
  const [evidenceRef, setEvidenceRef] = useState("");
  const [providerMetadataRef, setProviderMetadataRef] = useState("");
  const [fieldDrafts, setFieldDrafts] = useState<ExternalFieldDraft[]>(() => createExternalFieldDrafts(props.job.field_schema));

  useEffect(() => {
    setNormalizedSchemaRef(defaultSchemaRef(props.job));
    setEvidenceRef("");
    setProviderMetadataRef("");
    setFieldDrafts(createExternalFieldDrafts(props.job.field_schema));
  }, [props.job.document_job_id, props.job.document_type, props.job.field_schema]);

  const validationMessage = externalExtractionValidationMessage({
    providerAlias,
    receiptId,
    normalizedSchemaRef,
    evidenceRef,
    providerMetadataRef,
    fieldDrafts,
  });
  const shouldShowValidationMessage = validationMessage !== null && externalExtractionDraftTouched({
    providerAlias,
    receiptId,
    normalizedSchemaRef,
    evidenceRef,
    providerMetadataRef,
    fieldDrafts,
    defaultSchemaRef: defaultSchemaRef(props.job),
  });
  const canSubmit = validationMessage === null && !props.isPending;

  const updateFieldDraft = (key: string, patch: Partial<Pick<ExternalFieldDraft, "value" | "confidence">>): void => {
    setFieldDrafts((drafts) => drafts.map((draft) => draft.key === key ? { ...draft, ...patch } : draft));
  };

  return (
    <form
      className="stack"
      aria-label="외부 IDP normalized 결과 등록"
      onSubmit={(event) => {
        event.preventDefault();
        if (validationMessage !== null) return;
        props.onSubmit(buildExternalExtractionBody(providerAlias, receiptId, normalizedSchemaRef, evidenceRef, providerMetadataRef, fieldDrafts));
      }}
    >
      <div className="panel-subhead">
        <div>
          <h3>외부 IDP normalized 결과 등록</h3>
          <p className="subtle">provider alias와 receipt/schema/evidence ref, normalized 필드값만 저장합니다.</p>
        </div>
      </div>
      <div className="form-grid">
        <label className="field">
          <span className="label">Provider alias</span>
          <input aria-label="Provider alias" value={providerAlias} onChange={(event) => setProviderAlias(event.target.value)} placeholder="external-idp" />
        </label>
        <label className="field">
          <span className="label">Receipt ref</span>
          <input aria-label="Receipt ref" value={receiptId} onChange={(event) => setReceiptId(event.target.value)} placeholder="receipt-20260630-001" />
        </label>
        <label className="field">
          <span className="label">Schema ref</span>
          <input aria-label="Schema ref" value={normalizedSchemaRef} onChange={(event) => setNormalizedSchemaRef(event.target.value)} placeholder="document-extraction/invoice@1" />
        </label>
        <label className="field">
          <span className="label">Evidence ref</span>
          <input aria-label="Evidence ref" value={evidenceRef} onChange={(event) => setEvidenceRef(event.target.value)} placeholder="artifact:72000000-..." />
        </label>
        <label className="field">
          <span className="label">Provider metadata ref</span>
          <input aria-label="Provider metadata ref" value={providerMetadataRef} onChange={(event) => setProviderMetadataRef(event.target.value)} placeholder="metadata:external-idp/run-001" />
        </label>
      </div>
      <div className="table-wrap">
        <table className="ops-table">
          <thead><tr><th>필드</th><th>값</th><th>신뢰도</th></tr></thead>
          <tbody>
            {fieldDrafts.map((field) => (
              <tr key={field.key}>
                <td>
                  {field.label}
                  <div className="subtle">{field.key}</div>
                </td>
                <td>{renderExternalFieldValueInput(field, updateFieldDraft)}</td>
                <td>
                  <input
                    aria-label={`외부 필드 신뢰도 ${field.label}`}
                    type="number"
                    min={0}
                    max={1}
                    step={0.01}
                    value={field.confidence}
                    onChange={(event) => updateFieldDraft(field.key, { confidence: event.target.value })}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {shouldShowValidationMessage && <p className="notice warning" role="alert">{validationMessage}</p>}
      {props.error !== null && <ClassifiedErrorState error={props.error} message="외부 IDP 결과를 등록하지 못했습니다." />}
      <div>
        <button className="btn primary" type="submit" disabled={!canSubmit}>
          {props.isPending ? "등록 중" : "외부 결과 등록"}
        </button>
      </div>
    </form>
  );
}

function renderExternalFieldValueInput(
  field: ExternalFieldDraft,
  updateFieldDraft: (key: string, patch: Partial<Pick<ExternalFieldDraft, "value" | "confidence">>) => void,
): JSX.Element {
  if (field.type === "boolean") {
    return (
      <select
        aria-label={`외부 필드 값 ${field.label}`}
        value={field.value}
        onChange={(event) => updateFieldDraft(field.key, { value: event.target.value })}
      >
        <option value="">확인 필요</option>
        <option value="true">참</option>
        <option value="false">거짓</option>
      </select>
    );
  }
  return (
    <input
      aria-label={`외부 필드 값 ${field.label}`}
      type={field.type === "number" ? "number" : field.type === "date" ? "date" : "text"}
      value={field.value}
      onChange={(event) => updateFieldDraft(field.key, { value: event.target.value })}
    />
  );
}

function defaultSchemaRef(job: DocumentJobItem): string {
  return `document-extraction/${job.document_type}@1`;
}

function createExternalFieldDrafts(fields: readonly DocumentFieldSchema[]): ExternalFieldDraft[] {
  return fields.map((field) => ({
    key: field.key,
    label: field.label ?? field.key,
    type: field.type ?? "text",
    value: "",
    confidence: String(field.min_confidence ?? 0.8),
  }));
}

function buildExternalExtractionBody(
  providerAlias: string,
  receiptId: string,
  normalizedSchemaRef: string,
  evidenceRef: string,
  providerMetadataRef: string,
  fieldDrafts: readonly ExternalFieldDraft[],
): ExternalDocumentExtractionBody {
  const evidence = evidenceRef.trim();
  const metadataRef = providerMetadataRef.trim();
  return {
    provider_alias: providerAlias.trim(),
    receipt_id: receiptId.trim(),
    normalized_schema_ref: normalizedSchemaRef.trim(),
    ...(evidence.length > 0 ? { evidence_ref: evidence } : {}),
    fields: fieldDrafts.map((field) => ({
      key: field.key,
      value: externalFieldValue(field),
      confidence: Number(field.confidence),
    })),
    metadata: {
      intake_mode: "metadata_only",
      provider_alias_ref: providerAlias.trim(),
      receipt_ref: receiptId.trim(),
      normalized_schema_ref: normalizedSchemaRef.trim(),
      ...(metadataRef.length > 0 ? { provider_metadata_ref: metadataRef } : {}),
    },
  };
}

function externalFieldValue(field: ExternalFieldDraft): string | number | boolean | null {
  const value = field.value.trim();
  if (value.length === 0) return null;
  if (field.type === "number") return Number(value);
  if (field.type === "boolean") return value === "true";
  return value;
}

function externalExtractionValidationMessage(values: {
  readonly providerAlias: string;
  readonly receiptId: string;
  readonly normalizedSchemaRef: string;
  readonly evidenceRef: string;
  readonly providerMetadataRef: string;
  readonly fieldDrafts: readonly ExternalFieldDraft[];
}): string | null {
  const safeFields = [
    ["Provider alias", values.providerAlias],
    ["Receipt ref", values.receiptId],
    ["Schema ref", values.normalizedSchemaRef],
    ["Evidence ref", values.evidenceRef],
    ["Provider metadata ref", values.providerMetadataRef],
  ] as const;
  for (const [label, value] of safeFields) {
    const safeMessage = safeMetadataValueMessage(label, value);
    if (safeMessage !== null) return safeMessage;
  }
  if (values.providerAlias.trim().length === 0) return "Provider alias를 입력하세요.";
  if (values.receiptId.trim().length === 0) return "Receipt ref를 입력하세요.";
  if (values.normalizedSchemaRef.trim().length === 0) return "Schema ref를 입력하세요.";
  let hasValue = false;
  for (const field of values.fieldDrafts) {
    const value = field.value.trim();
    const fieldMessage = safeMetadataValueMessage(field.label, value);
    if (fieldMessage !== null) return fieldMessage;
    const confidence = Number(field.confidence);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) return `${field.label} 신뢰도는 0에서 1 사이여야 합니다.`;
    if (field.type === "number" && value.length > 0 && !Number.isFinite(Number(value))) return `${field.label} 값은 숫자여야 합니다.`;
    if (value.length > 0) hasValue = true;
  }
  if (!hasValue) return "normalized 필드값을 1개 이상 입력하세요.";
  return null;
}

function externalExtractionDraftTouched(values: {
  readonly providerAlias: string;
  readonly receiptId: string;
  readonly normalizedSchemaRef: string;
  readonly evidenceRef: string;
  readonly providerMetadataRef: string;
  readonly fieldDrafts: readonly ExternalFieldDraft[];
  readonly defaultSchemaRef: string;
}): boolean {
  return values.providerAlias.trim() !== "external-idp"
    || values.receiptId.trim().length > 0
    || values.normalizedSchemaRef.trim() !== values.defaultSchemaRef
    || values.evidenceRef.trim().length > 0
    || values.providerMetadataRef.trim().length > 0
    || values.fieldDrafts.some((field) => field.value.trim().length > 0 || field.confidence.trim() === "");
}

function safeMetadataValueMessage(label: string, value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > 256) return `${label}은 256자 이하의 alias/ref 값이어야 합니다.`;
  if (/(?:https?:\/\/|www\.|bearer\s+|api[_-]?key|secret|token|password|provider[_ -]?response|document[_ -]?bytes|ocr[_ -]?text|response[_ -]?body|raw[_ -]?(?:document|ocr|text|url|bytes|body|response))/iu.test(trimmed)) {
    return `${label}에는 raw URL, token, secret, provider response body를 입력할 수 없습니다.`;
  }
  return null;
}
