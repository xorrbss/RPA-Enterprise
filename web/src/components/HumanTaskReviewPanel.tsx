import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";

import type { ApiClient } from "../api/client";
import { useCan } from "../api/permissions";
import type { HumanTaskBusinessFormField, HumanTaskItem, HumanTaskResolution } from "../api/types";
import { mergeParams } from "../router";
import { ArtifactLookup } from "./ArtifactLookup";
import { errorLabel } from "./badges";
import type { FormValue } from "./human-task-review/business-form";
import { buildFormCorrections, businessFormSchema, formError, initialFormValues } from "./human-task-review/business-form";
import type { CorrectionRow } from "./human-task-review/corrections";
import { buildCorrections, correctionRowsFromResult, manualCorrectionsError } from "./human-task-review/corrections";
import { DECISIONS, payloadSummaryItems, schemaDetailItems, schemaSummaryLabel } from "./human-task-review/summary";

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
  const formFieldKeys = useMemo(() => new Set((formSchema?.fields ?? []).map((field) => field.key)), [formSchema]);
  const payloadItems = useMemo(() => payloadSummaryItems(task.payload ?? null, formFieldKeys), [task.payload, formFieldKeys]);
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
            // 반려는 사유 필수(조용한 반려 방지 — 재개 분기/감사에서 사유 유실 차단).
            if (decision === "reject" && reason.trim() === "") {
              setMessage({ tone: "red", text: "반려 사유를 입력하세요." });
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
            판정(승인/반려/수정/재시도)에 따라 자동화가 재개·분기됩니다. 입력·수정한 값은 검토 기록으로 저장되며, 자동화가 그 값을 사용하도록 설계된 항목은 재개된 동작에 그대로 반영됩니다(예: 답장 내용을 편집·승인하면 그 내용으로 실제 발송).
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

          {/* 처리 사유: 반려/수정 판정에만 노출(승인은 사유 불필요). 반려는 필수(조용한 반려 방지). */}
          {(decision === "reject" || decision === "correct") && (
            <label className="field field-wide">
              <span>처리 사유{decision === "reject" ? " *" : ""}</span>
              <input aria-label="처리 사유" value={reason} onChange={(event) => setReason(event.target.value)} placeholder={decision === "reject" ? "반려 사유를 입력하세요" : "수정 사유 (선택)"} />
            </label>
          )}
          {/* 확신도·검토 메모: 계약상 optional — 기본 접기(점진 공개). 삭제 아닌 노출 지연이라 검증·전송 로직은 그대로 유지. */}
          <details className="developer-details">
            <summary>검토 기록 남기기 (선택 — 확신도·메모)</summary>
            <div className="form-grid">
              <label className="field">
                <span>확신도</span>
                <input inputMode="decimal" placeholder="0.0 - 1.0" value={confidence} onChange={(event) => setConfidence(event.target.value)} />
              </label>
              <label className="field field-wide">
                <span>검토 메모</span>
                <textarea value={notes} onChange={(event) => setNotes(event.target.value)} />
              </label>
            </div>
          </details>

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
