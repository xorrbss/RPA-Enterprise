import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";

import type { ApiClient } from "../api/client";
import { useCan } from "../api/permissions";
import type { HumanTaskBusinessFormField, HumanTaskBusinessFormSchema, HumanTaskItem, HumanTaskResolution } from "../api/types";
import { mergeParams } from "../router";
import { ArtifactLookup } from "./ArtifactLookup";
import { errorLabel } from "./badges";

type CorrectionRow = { readonly id: string; key: string; value: string };
type FormValue = string | boolean | undefined;
type SummaryItem = { readonly label: string; readonly value: string };
type BusinessFormParseResult = {
  readonly schema: HumanTaskBusinessFormSchema | null;
  readonly error: string | null;
};

const SUMMARY_KEY_LABELS: Record<string, string> = {
  approved: "승인 여부",
  doc_ref: "문서 링크",
  invoice_id: "송장 번호",
  status: "상태",
  total: "금액",
};
const TECHNICAL_SUMMARY_KEYS = new Set([
  "artifact_id",
  "correlation_id",
  "human_task_id",
  "run_id",
  "scenario_id",
  "scenario_version_id",
  "source_artifact_id",
  "source_run_id",
  "tenant_id",
]);

const DECISIONS: readonly { value: HumanTaskResolution["decision"]; label: string }[] = [
  { value: "approve", label: "승인" },
  { value: "reject", label: "반려" },
  { value: "correct", label: "수정 후 통과" },
  { value: "retry", label: "재시도 요청" },
];

function valueLabel(value: unknown): string {
  if (value === null || value === undefined) return "없음";
  if (typeof value === "string") return value.length > 80 ? `${value.slice(0, 80)}...` : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `${value.length}개 항목`;
  if (typeof value === "object") return "세부 정보 있음";
  return String(value);
}

function payloadSummaryItems(value: unknown): readonly SummaryItem[] {
  if (value === null || value === undefined) return [{ label: "내용", value: "없음" }];
  if (typeof value !== "object" || Array.isArray(value)) return [{ label: "내용", value: valueLabel(value) }];
  const items = Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !TECHNICAL_SUMMARY_KEYS.has(key))
    .slice(0, 6)
    .map(([key, item], index) => ({ label: SUMMARY_KEY_LABELS[key] ?? `추가 정보 ${index + 1}`, value: valueLabel(item) }));
  return items.length > 0 ? items : [{ label: "업무 데이터", value: "요약 가능한 값 없음" }];
}

function schemaSummaryLabel(schema: HumanTaskBusinessFormSchema | null, rawSchema: unknown): string {
  if (schema !== null) return `${schema.fields.length}개 입력 항목`;
  if (rawSchema === null || rawSchema === undefined) return "별도 입력 양식 없음";
  return "직접 입력 방식 사용";
}

function schemaDetailItems(schema: HumanTaskBusinessFormSchema | null): readonly SummaryItem[] {
  if (schema === null) return [{ label: "입력 방식", value: "항목명과 수정값을 직접 입력합니다." }];
  return schema.fields.map((field) => ({
    label: field.label,
    value: field.required === true ? "필수 입력" : "선택 입력",
  }));
}

function parseCorrectionValue(value: string): unknown {
  const trimmed = value.trim();
  if (trimmed === "") return "";
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

function buildCorrections(rows: readonly CorrectionRow[]): Record<string, unknown> | undefined {
  const entries = rows
    .map((row) => [row.key.trim(), parseCorrectionValue(row.value)] as const)
    .filter(([key]) => key !== "");
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function correctionValueForInput(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function correctionRowsFromResult(corrections: Record<string, unknown> | undefined): CorrectionRow[] {
  if (corrections === undefined || Object.keys(corrections).length === 0) {
    return [{ id: crypto.randomUUID(), key: "", value: "" }];
  }
  return Object.entries(corrections).map(([key, value]) => ({
    id: crypto.randomUUID(),
    key,
    value: correctionValueForInput(value),
  }));
}

function manualCorrectionsError(rows: readonly CorrectionRow[]): string | null {
  const seen = new Set<string>();
  for (const row of rows) {
    const key = row.key.trim();
    if (key === "") continue;
    if (seen.has(key)) return `중복된 수정 항목입니다: ${key}`;
    seen.add(key);
  }
  return null;
}

function businessFormSchema(value: unknown): BusinessFormParseResult {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return { schema: null, error: null };
  const candidate = value as { version?: unknown; fields?: unknown };
  if (candidate.version === undefined) return { schema: null, error: null };
  if (candidate.version !== "business_form_v1") return { schema: null, error: "지원하지 않는 입력 양식입니다." };
  if (!Array.isArray(candidate.fields) || candidate.fields.length === 0) return { schema: null, error: "입력 양식 필드가 올바르지 않습니다." };

  const seen = new Set<string>();
  const fields: HumanTaskBusinessFormField[] = [];
  for (const field of candidate.fields) {
    if (field === null || typeof field !== "object" || Array.isArray(field)) return { schema: null, error: "입력 양식 필드가 올바르지 않습니다." };
    const item = field as Record<string, unknown>;
    for (const key of Object.keys(item)) {
      if (!["key", "label", "type", "required", "options", "help_text"].includes(key)) return { schema: null, error: "입력 양식 필드가 올바르지 않습니다." };
    }
    const key = item.key;
    if (typeof key !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key)) return { schema: null, error: "입력 양식 필드 키가 올바르지 않습니다." };
    if (seen.has(key)) return { schema: null, error: `중복된 입력 양식 필드입니다: ${key}` };
    seen.add(key);
    const label = item.label;
    if (typeof label !== "string" || label.length === 0) return { schema: null, error: "입력 양식 라벨이 올바르지 않습니다." };
    const type = item.type;
    if (!["text", "textarea", "number", "boolean", "date", "select"].includes(String(type))) return { schema: null, error: "입력 양식 타입이 올바르지 않습니다." };
    const required = item.required;
    if (required !== undefined && typeof required !== "boolean") return { schema: null, error: "입력 양식 필수 여부가 올바르지 않습니다." };
    const helpText = item.help_text;
    if (helpText !== undefined && typeof helpText !== "string") return { schema: null, error: "입력 양식 도움말이 올바르지 않습니다." };
    const options = item.options;
    if (type === "select") {
      if (!Array.isArray(options) || options.length === 0 || options.some((option) => typeof option !== "string" || option.length === 0)) {
        return { schema: null, error: "선택형 입력 양식 옵션이 올바르지 않습니다." };
      }
    } else if (options !== undefined) {
      return { schema: null, error: "선택형이 아닌 필드에 옵션이 있습니다." };
    }
    fields.push({
      key,
      label,
      type: type as HumanTaskBusinessFormField["type"],
      ...(required !== undefined ? { required } : {}),
      ...(type === "select" ? { options: options as string[] } : {}),
      ...(helpText !== undefined ? { help_text: helpText } : {}),
    });
  }

  return { schema: { version: "business_form_v1", fields }, error: null };
}

function initialFormValues(
  schema: HumanTaskBusinessFormSchema | null,
  corrections: Record<string, unknown> | undefined,
  payload: unknown,
): Record<string, FormValue> {
  if (schema === null) return {};
  const payloadValues = payload !== null && typeof payload === "object" && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : {};
  return Object.fromEntries(schema.fields.map((field) => {
    const value = corrections?.[field.key] ?? payloadValues[field.key];
    if (field.type === "boolean") return [field.key, typeof value === "boolean" ? String(value) : ""];
    if (value === undefined || value === null) return [field.key, ""];
    return [field.key, String(value)];
  }));
}

function typedFieldError(field: HumanTaskBusinessFormField, value: FormValue): string | null {
  if (field.type === "number" && !Number.isFinite(Number(value))) {
    return `${field.label} 값은 숫자여야 합니다.`;
  }
  if (field.type === "date" && (typeof value !== "string" || Number.isNaN(Date.parse(`${value}T00:00:00Z`)))) {
    return `${field.label} 값은 YYYY-MM-DD 형식이어야 합니다.`;
  }
  if (field.type === "select" && (typeof value !== "string" || !(field.options ?? []).includes(value))) {
    return `${field.label} 값은 선택지 중 하나여야 합니다.`;
  }
  if (field.type === "boolean" && value !== "true" && value !== "false") {
    return `${field.label} 값은 예/아니오 중 하나여야 합니다.`;
  }
  return null;
}

function formError(
  schema: HumanTaskBusinessFormSchema,
  values: Record<string, FormValue>,
  decision: HumanTaskResolution["decision"],
): string | null {
  for (const field of schema.fields) {
    const value = values[field.key];
    const empty = value === undefined || value === "";
    if (decision === "correct" && field.required === true && empty) {
      return `${field.label} 값이 필요합니다.`;
    }
    if (empty) continue;
    const typedError = typedFieldError(field, value);
    if (typedError !== null) return typedError;
    if (field.type === "number" && value !== undefined && value !== "" && !Number.isFinite(Number(value))) {
      return `${field.label}은 숫자여야 합니다.`;
    }
  }
  return null;
}

function buildFormCorrections(schema: HumanTaskBusinessFormSchema, values: Record<string, FormValue>): Record<string, unknown> | undefined {
  const entries: Array<readonly [string, unknown]> = [];
  for (const field of schema.fields) {
    const value = values[field.key];
    if (value === undefined || value === "") continue;
    if (field.type === "number") entries.push([field.key, Number(value)]);
    else if (field.type === "boolean") entries.push([field.key, value === "true"]);
    else entries.push([field.key, value]);
  }
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function ArtifactEvidenceButton({ id }: { id: string }): JSX.Element {
  return (
    <button
      className="linklike artifact-evidence-link"
      type="button"
      onClick={() => mergeParams({ artifact: id })}
      aria-label={`증빙 자료 ${id} 조회`}
      title="증빙 조회 패널에 이 증빙 번호를 연결합니다"
    >
      증빙 자료 열기
    </button>
  );
}

export function HumanTaskReviewPanel({ api, task }: { api: ApiClient; task: HumanTaskItem }): JSX.Element {
  const can = useCan();
  const qc = useQueryClient();
  const formParse = useMemo(() => businessFormSchema(task.result_schema ?? null), [task.result_schema]);
  const formSchema = formParse.schema;
  const formSchemaError = formParse.error;
  const [decision, setDecision] = useState<HumanTaskResolution["decision"]>(task.result?.decision ?? "approve");
  const [corrections, setCorrections] = useState<CorrectionRow[]>(() => correctionRowsFromResult(task.result?.corrections));
  const [formValues, setFormValues] = useState<Record<string, FormValue>>(() => initialFormValues(formSchema, task.result?.corrections, task.payload ?? null));
  const [reason, setReason] = useState(task.result?.reason ?? "");
  const [confidence, setConfidence] = useState(task.result?.confidence !== undefined ? String(task.result.confidence) : "");
  const [notes, setNotes] = useState(task.result?.notes ?? "");
  const [message, setMessage] = useState<{ tone: "green" | "red"; text: string } | null>(null);
  const action = `human_task.resolve.${task.kind}`;
  const canResolve = can(action);
  const payloadItems = useMemo(() => payloadSummaryItems(task.payload ?? null), [task.payload]);
  const schemaItems = useMemo(() => schemaDetailItems(formSchema), [formSchema]);
  const artifactRefs = task.artifact_refs ?? [];

  useEffect(() => {
    setDecision(task.result?.decision ?? "approve");
    setCorrections(correctionRowsFromResult(task.result?.corrections));
    setFormValues(initialFormValues(formSchema, task.result?.corrections, task.payload ?? null));
    setReason(task.result?.reason ?? "");
    setConfidence(task.result?.confidence !== undefined ? String(task.result.confidence) : "");
    setNotes(task.result?.notes ?? "");
    setMessage(null);
  }, [task.human_task_id]);

  const mutation = useMutation({
    mutationFn: (result: HumanTaskResolution) => api.resolveHumanTask(task.human_task_id, crypto.randomUUID(), result),
    onSuccess: () => {
      setMessage({ tone: "green", text: "판정 기록을 저장하고 재개 신호를 보냈습니다." });
      void qc.invalidateQueries({ queryKey: ["human-tasks"] });
      void qc.invalidateQueries({ queryKey: ["humantask-detail", task.human_task_id] });
    },
    onError: (error) => setMessage({ tone: "red", text: errorLabel(error) }),
  });

  const confidenceNumber = confidence.trim() === "" ? undefined : Number(confidence);
  const confidenceInvalid = confidenceNumber !== undefined && (!Number.isFinite(confidenceNumber) || confidenceNumber < 0 || confidenceNumber > 1);
  const updateFormValue = (field: HumanTaskBusinessFormField, value: FormValue) => {
    setFormValues((current) => ({ ...current, [field.key]: value }));
  };

  return (
    <section className="human-review" aria-label="검증/교정 워크벤치">
      <div className="human-review-head">
        <div>
          <strong>검증/교정 워크벤치</strong>
          <p className="subtle">검토할 내용과 증빙을 확인하고 판정 기록과 자동화 재개 신호를 보냅니다.</p>
        </div>
      </div>

      <div className="human-review-grid">
        <section>
          <h3>검토할 내용</h3>
          <dl className="human-summary-list">
            {payloadItems.map((item) => (
              <div key={item.label}>
                <dt>{item.label}</dt>
                <dd>{item.value}</dd>
              </div>
            ))}
          </dl>
          <p className="subtle">원문 요청은 감사 추적과 증빙에서 확인하고, 여기서는 검토에 필요한 업무 항목만 표시합니다.</p>
        </section>
        <section>
          <h3>입력 양식</h3>
          <p className="subtle">{formSchemaError ?? schemaSummaryLabel(formSchema, task.result_schema ?? null)}</p>
          <details className="developer-details">
            <summary>입력 방식 보기</summary>
            <dl className="human-summary-list">
              {schemaItems.map((item) => (
                <div key={item.label}>
                  <dt>{item.label}</dt>
                  <dd>{item.value}</dd>
                </div>
              ))}
            </dl>
          </details>
        </section>
      </div>

      <section>
        <h3>증빙 자료</h3>
        {artifactRefs.length > 0 ? (
          <>
            <ul className="artifact-ref-list">
              {artifactRefs.map((ref) => (
                <li key={ref}>
                  <ArtifactEvidenceButton id={ref} />
                </li>
              ))}
            </ul>
            <ArtifactLookup embedded />
          </>
        ) : (
          <p className="subtle">연결된 증빙 자료가 없습니다.</p>
        )}
      </section>

      {task.state === "in_progress" && (
        <form
          className="human-review-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (confidenceInvalid) {
              setMessage({ tone: "red", text: "확신도는 0에서 1 사이 숫자여야 합니다." });
              return;
            }
            if (formSchemaError !== null) {
              setMessage({ tone: "red", text: formSchemaError });
              return;
            }
            const schemaError = formSchema !== null ? formError(formSchema, formValues, decision) : null;
            if (schemaError !== null) {
              setMessage({ tone: "red", text: schemaError });
              return;
            }
            const correctionError = formSchema === null ? manualCorrectionsError(corrections) : null;
            if (correctionError !== null) {
              setMessage({ tone: "red", text: correctionError });
              return;
            }
            const builtCorrections = formSchema !== null ? buildFormCorrections(formSchema, formValues) : buildCorrections(corrections);
            mutation.mutate({
              decision,
              ...(builtCorrections !== undefined ? { corrections: builtCorrections } : {}),
              ...(reason.trim() !== "" ? { reason: reason.trim() } : {}),
              ...(confidenceNumber !== undefined ? { confidence: confidenceNumber } : {}),
              ...(notes.trim() !== "" ? { notes: notes.trim() } : {}),
            });
          }}
        >
          <p className="form-alert amber" role="note">
            현재 런타임은 resolve 신호로 자동화를 재개합니다. 반려, 수정, 재시도 판정과 입력값은 감사·후속 검토 기록으로 저장되며 재개 분기에는 자동 반영되지 않습니다.
          </p>
          <label className="field">
            <span>판정</span>
            <select value={decision} onChange={(event) => setDecision(event.target.value as HumanTaskResolution["decision"])}>
              {DECISIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>

          {formSchemaError !== null && (
            <p className="form-alert red" role="alert">
              {formSchemaError}
            </p>
          )}

          {formSchema !== null ? (
            <div className="human-business-form">
              <div className="human-corrections-head">
                <span>업무 입력 항목</span>
                <span className="badge blue">구조화 양식</span>
              </div>
              <div className="form-grid">
                {formSchema.fields.map((field) => (
                  <label className={`field ${field.type === "textarea" ? "field-wide" : ""}`} key={field.key}>
                    <span>{field.label}{field.required === true ? " *" : ""}</span>
                    {field.type === "textarea" ? (
                      <textarea value={String(formValues[field.key] ?? "")} onChange={(event) => updateFormValue(field, event.target.value)} />
                    ) : field.type === "select" ? (
                      <select value={String(formValues[field.key] ?? "")} onChange={(event) => updateFormValue(field, event.target.value)}>
                        <option value="">선택</option>
                        {(field.options ?? []).map((option) => <option key={option} value={option}>{option}</option>)}
                      </select>
                    ) : field.type === "boolean" ? (
                      <select value={String(formValues[field.key] ?? "")} onChange={(event) => updateFormValue(field, event.target.value)}>
                        <option value="">선택</option>
                        <option value="true">예</option>
                        <option value="false">아니오</option>
                      </select>
                    ) : (
                      <input
                        type={field.type === "number" ? "number" : field.type === "date" ? "date" : "text"}
                        value={String(formValues[field.key] ?? "")}
                        onChange={(event) => updateFormValue(field, event.target.value)}
                      />
                    )}
                    {field.help_text !== undefined && <small className="subtle">{field.help_text}</small>}
                  </label>
                ))}
              </div>
            </div>
          ) : (
            <div className="human-corrections">
              <div className="human-corrections-head">
                <span>수정 항목 직접 입력</span>
                <button className="btn" type="button" onClick={() => setCorrections((rows) => [...rows, { id: crypto.randomUUID(), key: "", value: "" }])}>
                  추가
                </button>
              </div>
              {corrections.map((row) => (
                <div className="human-correction-row" key={row.id}>
                  <input
                    aria-label="수정 항목명"
                    placeholder="항목명"
                    value={row.key}
                    onChange={(event) => setCorrections((rows) => rows.map((item) => item.id === row.id ? { ...item, key: event.target.value } : item))}
                  />
                  <input
                    aria-label="수정값"
                    placeholder="수정값 예: ok, 3, true"
                    value={row.value}
                    onChange={(event) => setCorrections((rows) => rows.map((item) => item.id === row.id ? { ...item, value: event.target.value } : item))}
                  />
                  <button className="btn" type="button" disabled={corrections.length === 1} onClick={() => setCorrections((rows) => rows.filter((item) => item.id !== row.id))}>
                    삭제
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="form-grid">
            <label className="field">
              <span>처리 사유</span>
              <input value={reason} onChange={(event) => setReason(event.target.value)} />
            </label>
            <label className="field">
              <span>확신도</span>
              <input inputMode="decimal" placeholder="0.0 - 1.0" value={confidence} onChange={(event) => setConfidence(event.target.value)} />
            </label>
            <label className="field field-wide">
              <span>검토 메모</span>
              <textarea value={notes} onChange={(event) => setNotes(event.target.value)} />
            </label>
          </div>

          <div className="human-review-actions">
            <button className="btn primary" type="submit" disabled={!canResolve || mutation.isPending || formSchemaError !== null}>
              {mutation.isPending ? "전송 중" : "판정 기록 후 재개 신호 보내기"}
            </button>
            {!canResolve && <span className="badge amber">권한 없음</span>}
            {message !== null && <span className={`badge ${message.tone}`} role={message.tone === "green" ? "status" : "alert"}>{message.text}</span>}
          </div>
        </form>
      )}
    </section>
  );
}
