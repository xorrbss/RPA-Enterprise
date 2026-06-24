import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";

import { useApiClient } from "../api/context";
import type { ApiClient } from "../api/client";
import {
  ApiError,
  type DocumentExtraction,
  type DocumentExtractionField,
  type DocumentFieldSchema,
  type DocumentFieldType,
  type DocumentJobItem,
  type DocumentJobListParams,
  type DocumentJobStatus,
  type ListParams,
  type RunItem,
  type RunArtifactItem,
} from "../api/types";
import { useListView } from "../api/useListView";
import { mergeParams, navigate, useHashParam } from "../router";
import { errorLabel } from "../components/badges";
import { EmptyState, ErrorState, Loading } from "../components/states";

type FieldPreset = "invoice" | "contract";
type PickerPage<T> = { readonly items: readonly T[]; readonly truncated: boolean };

const FIELD_TYPES: readonly DocumentFieldType[] = ["text", "number", "date", "boolean"];

const FIELD_PRESETS: Record<FieldPreset, readonly DocumentFieldSchema[]> = {
  invoice: [
    { key: "invoice_id", label: "송장 번호", type: "text", required: true, aliases: ["Invoice ID"], min_confidence: 0.8 },
    { key: "total", label: "금액", type: "number", required: true, aliases: ["Total"], min_confidence: 0.8 },
    { key: "approved", label: "승인 여부", type: "boolean", required: false, min_confidence: 0.7 },
  ],
  contract: [
    { key: "contract_no", label: "계약 번호", type: "text", required: true, min_confidence: 0.8 },
    { key: "counterparty", label: "거래처", type: "text", required: true, aliases: ["Vendor", "Customer"], min_confidence: 0.8 },
    { key: "effective_date", label: "효력 시작일", type: "date", required: false, min_confidence: 0.75 },
  ],
};

const STATUS_FILTERS: readonly { value: "" | DocumentJobStatus; label: string }[] = [
  { value: "", label: "전체" },
  { value: "created", label: "추출 대기" },
  { value: "extracted", label: "추출 완료" },
  { value: "validation_required", label: "검증 필요" },
  { value: "validated", label: "검증 완료" },
  { value: "failed", label: "실패" },
];

async function collectPickerPages<T>(
  fetcher: (params: ListParams) => Promise<{ items: readonly T[]; next_cursor: string | null }>,
  limit: number,
  maxPages: number,
): Promise<PickerPage<T>> {
  let cursor: string | undefined;
  const items: T[] = [];
  for (let page = 0; page < maxPages; page += 1) {
    const result = await fetcher({ limit, ...(cursor !== undefined ? { cursor } : {}) });
    items.push(...result.items);
    if (result.next_cursor === null) return { items, truncated: false };
    cursor = result.next_cursor;
  }
  return { items, truncated: true };
}

function listRecentRunsForPicker(api: ApiClient): Promise<PickerPage<RunItem>> {
  return collectPickerPages((params) => api.listRuns(params), 20, 5);
}

function listRunArtifactsForPicker(api: ApiClient, runId: string): Promise<PickerPage<RunArtifactItem>> {
  return collectPickerPages((params) => api.listRunArtifacts(runId, params), 100, 10);
}

export function DocumentIdpView(): JSX.Element {
  const api = useApiClient();
  const queryClient = useQueryClient();
  const selectedId = useHashParam("doc");
  const runParam = useHashParam("run");
  const artifactParam = useHashParam("artifact");
  const [status, setStatus] = useState<"" | DocumentJobStatus>("");
  const [sourceRunId, setSourceRunId] = useState<string>(runParam ?? "");
  const [sourceArtifactId, setSourceArtifactId] = useState<string>(artifactParam ?? "");
  const [preset, setPreset] = useState<FieldPreset>("invoice");
  const [fields, setFields] = useState<DocumentFieldSchema[]>(() => cloneFields(FIELD_PRESETS.invoice));
  const [message, setMessage] = useState<string | null>(null);

  const recentRuns = useQuery({
    queryKey: ["document-idp", "runs"],
    queryFn: () => listRecentRunsForPicker(api),
    refetchInterval: 10_000,
  });
  const runItems = recentRuns.data?.items ?? [];
  const selectedRunInList = runItems.some((run) => run.run_id === sourceRunId);
  const runArtifacts = useQuery({
    queryKey: ["document-idp", "run-artifacts", sourceRunId],
    queryFn: () => listRunArtifactsForPicker(api, sourceRunId),
    enabled: sourceRunId.trim().length > 0,
    retry: false,
  });
  const sourceArtifacts = useMemo(
    () => (runArtifacts.data?.items ?? []).filter(isDocumentSourceArtifact),
    [runArtifacts.data?.items],
  );

  useEffect(() => {
    if (runParam !== null && runParam !== sourceRunId) setSourceRunId(runParam);
  }, [runParam, sourceRunId]);
  useEffect(() => {
    if (artifactParam === null || runArtifacts.data === undefined) return;
    if (sourceArtifacts.some((artifact) => artifact.artifact_id === artifactParam) && artifactParam !== sourceArtifactId) {
      setSourceArtifactId(artifactParam);
    }
  }, [artifactParam, runArtifacts.data, sourceArtifactId, sourceArtifacts]);
  useEffect(() => {
    if (sourceRunId !== "" || runItems.length === 0) return;
    const firstRun = runItems[0];
    if (firstRun !== undefined) setSourceRunId(firstRun.run_id);
  }, [runItems, sourceRunId]);
  useEffect(() => {
    setFields(cloneFields(FIELD_PRESETS[preset]));
  }, [preset]);
  useEffect(() => {
    if (runArtifacts.data === undefined) return;
    if (sourceArtifacts.some((artifact) => artifact.artifact_id === sourceArtifactId)) return;
    const nextArtifactId = sourceArtifacts[0]?.artifact_id ?? "";
    if (sourceArtifactId !== nextArtifactId) setSourceArtifactId(nextArtifactId);
  }, [runArtifacts.data, sourceArtifactId, sourceArtifacts]);

  const list = useListView<DocumentJobItem>(
    ["document-jobs", status],
    (params: ListParams) => {
      const page = { limit: params.limit, cursor: params.cursor };
      const request: DocumentJobListParams = status !== "" ? { ...page, status } : page;
      return api.listDocumentJobs(request);
    },
    { limit: 20, refetchInterval: 10_000 },
  );

  const selectedFromList = useMemo(
    () => list.query.data?.items.find((item) => item.document_job_id === selectedId) ?? null,
    [list.query.data?.items, selectedId],
  );

  const detail = useQuery({
    queryKey: ["document-job", selectedId],
    queryFn: () => api.getDocumentJob(selectedId!),
    enabled: selectedId !== null && selectedFromList === null,
  });
  const selected = selectedFromList ?? detail.data ?? null;

  const extraction = useQuery({
    queryKey: ["document-extraction", selectedId],
    queryFn: () => api.getDocumentExtraction(selectedId!),
    enabled: selectedId !== null,
    retry: false,
  });

  const createJob = useMutation({
    mutationFn: () =>
      api.createDocumentJob(
        {
          source_artifact_id: sourceArtifactId,
          document_type: preset,
          field_schema: cleanFieldSchema(fields),
        },
        crypto.randomUUID(),
      ),
    onSuccess: (job) => {
      setMessage("문서 추출 작업을 만들었습니다.");
      mergeParams({ doc: job.document_job_id, run: job.source_run_id, artifact: job.source_artifact_id });
      void queryClient.invalidateQueries({ queryKey: ["document-jobs"] });
    },
  });

  const fieldValidation = fieldSchemaValidationMessage(fields);
  const canCreateJob = sourceRunId.trim().length > 0
    && sourceArtifactId.trim().length > 0
    && !runArtifacts.isError
    && fieldValidation === null;

  const extractJob = useMutation({
    mutationFn: (jobId: string) => api.extractDocumentJob(jobId, crypto.randomUUID()),
    onSuccess: (result) => {
      setMessage(result.status === "validation_required" ? "추출 완료: 검증이 필요한 필드가 있습니다." : "추출이 완료되었습니다.");
      mergeParams({ doc: result.document_job_id });
      void queryClient.invalidateQueries({ queryKey: ["document-jobs"] });
      void queryClient.invalidateQueries({ queryKey: ["document-extraction", result.document_job_id] });
    },
  });

  const createValidationTask = useMutation({
    mutationFn: (jobId: string) => api.createDocumentValidationTask(jobId, crypto.randomUUID()),
    onSuccess: (result) => {
      setMessage("검증 작업을 사람 확인함에 배정했습니다.");
      navigate("humanTasks", { ht: result.human_task_id });
    },
  });

  return (
    <div className="stack document-idp">
      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>문서 자동화</h2>
            <p className="subtle">브라우저 산출물의 텍스트·CSV·JSON에서 필드를 추출하고, 불확실한 값은 검증 큐로 보냅니다.</p>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button className="btn" type="button" onClick={() => navigate("connectorCatalog")}>템플릿 보기</button>
            <button className="btn" type="button" onClick={() => navigate("humanTasks")}>검증 큐</button>
          </div>
        </div>
        <div className="panel-body">
          <div className="form-grid">
            <label className="field">
              <span className="label">실행 기록</span>
              <select
                value={sourceRunId}
                onChange={(event) => {
                  setSourceRunId(event.target.value);
                  setSourceArtifactId("");
                  mergeParams({ run: event.target.value || null, artifact: null });
                }}
                disabled={recentRuns.isLoading}
              >
                {sourceRunId === "" && <option value="">실행 기록 선택</option>}
                {sourceRunId !== "" && !selectedRunInList && (
                  <option value={sourceRunId}>딥링크로 선택된 실행</option>
                )}
                {runItems.map((run) => (
                  <option key={run.run_id} value={run.run_id}>{runOptionLabel(run)}</option>
                ))}
              </select>
              <small>
                {recentRuns.isError
                  ? "실행 기록을 불러오지 못했습니다."
                  : recentRuns.data?.truncated === true
                    ? "최근 실행 100건 기준입니다. 더 오래된 실행은 실행 기록 화면에서 먼저 선택하세요."
                    : "문서가 내려받힌 브라우저 실행을 선택하세요."}
              </small>
            </label>
            <label className="field">
              <span className="label">증빙 자료</span>
              <select
                value={sourceArtifactId}
                onChange={(event) => {
                  setSourceArtifactId(event.target.value);
                  mergeParams({ artifact: event.target.value || null });
                }}
                disabled={sourceRunId === "" || runArtifacts.isLoading || sourceArtifacts.length === 0}
              >
                {sourceArtifacts.length === 0 ? (
                  <option value="">선택 가능한 문서 산출물 없음</option>
                ) : (
                  sourceArtifacts.map((artifact) => (
                    <option key={artifact.artifact_id} value={artifact.artifact_id}>{artifactLabel(artifact)}</option>
                  ))
                )}
              </select>
              <small>{artifactPickerHint(sourceRunId, runArtifacts.isLoading, runArtifacts.isError, sourceArtifacts.length, runArtifacts.data?.truncated === true)}</small>
            </label>
            <label className="field">
              <span className="label">문서 종류</span>
              <select value={preset} onChange={(event) => setPreset(event.target.value as FieldPreset)}>
                <option value="invoice">송장</option>
                <option value="contract">계약서</option>
              </select>
              <small>프리셋을 바꾸면 추출 필드 목록이 초기화됩니다.</small>
            </label>
            <div style={{ alignSelf: "end" }}>
              <button className="btn primary" type="button" disabled={createJob.isPending || !canCreateJob} onClick={() => createJob.mutate()}>
                {createJob.isPending ? "만드는 중" : "추출 작업 만들기"}
              </button>
            </div>
          </div>
          <FieldSchemaEditor fields={fields} onChange={setFields} />
          {fieldValidation !== null && <p className="notice warning" role="alert">{fieldValidation}</p>}
          {message !== null && <p className="notice success" role="status">{message}</p>}
          {createJob.isError && <ErrorState message={errorLabel(createJob.error)} />}
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>문서 작업 목록</h2>
          <label style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            <span className="label">상태</span>
            <select value={status} onChange={(event) => setStatus(event.target.value as "" | DocumentJobStatus)}>
              {STATUS_FILTERS.map((item) => (
                <option key={item.value || "all"} value={item.value}>{item.label}</option>
              ))}
            </select>
          </label>
        </div>
        <div className="panel-body">
          {list.query.isLoading ? (
            <Loading />
          ) : list.query.isError ? (
            <ErrorState message={errorLabel(list.query.error)} onRetry={() => void list.query.refetch()} />
          ) : (list.query.data?.items.length ?? 0) === 0 ? (
            <EmptyState message="문서 작업이 없습니다." />
          ) : (
            <div className="table-wrap">
              <table className="ops-table">
                <thead>
                  <tr>
                    <th>문서</th>
                    <th>상태</th>
                    <th>필드</th>
                    <th>업데이트</th>
                    <th>작업</th>
                  </tr>
                </thead>
                <tbody>
                  {(list.query.data?.items ?? []).map((job) => (
                    <tr key={job.document_job_id}>
                      <td>
                        <button className="linklike" type="button" onClick={() => mergeParams({ doc: job.document_job_id })}>
                          {documentTypeLabel(job.document_type)}
                        </button>
                        <div className="subtle">{artifactLabelById(job.source_artifact_id, sourceArtifacts)}</div>
                      </td>
                      <td><DocumentStatusBadge status={job.status} /></td>
                      <td>{requiredFieldCount(job.field_schema)}개 필수 · {job.field_schema.length}개 전체</td>
                      <td>{formatDateTime(job.updated_at)}</td>
                      <td>
                        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                          <button className="btn" type="button" onClick={() => mergeParams({ doc: job.document_job_id })}>결과 보기</button>
                          <button className="btn" type="button" disabled={extractJob.isPending} onClick={() => extractJob.mutate(job.document_job_id)}>추출 실행</button>
                          <button className="btn" type="button" disabled={createValidationTask.isPending} onClick={() => createValidationTask.mutate(job.document_job_id)}>검증 작업</button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>

      <DocumentDetail
        job={selected}
        isLoading={selectedId !== null && selected === null && detail.isLoading}
        extraction={extraction.data ?? null}
        extractionError={extraction.isError ? extraction.error : null}
        sourceArtifacts={sourceArtifacts}
        onExtract={(jobId) => extractJob.mutate(jobId)}
        onRetryExtraction={() => void extraction.refetch()}
        onCreateValidationTask={(jobId) => createValidationTask.mutate(jobId)}
      />
    </div>
  );
}

function FieldSchemaEditor(props: {
  fields: readonly DocumentFieldSchema[];
  onChange: (fields: DocumentFieldSchema[]) => void;
}): JSX.Element {
  const updateField = (index: number, patch: Partial<DocumentFieldSchema>): void => {
    props.onChange(props.fields.map((field, fieldIndex) => fieldIndex === index ? { ...field, ...patch } : field));
  };
  const addField = (): void => {
    props.onChange([
      ...props.fields,
      {
        key: `field_${props.fields.length + 1}`,
        label: "새 필드",
        type: "text",
        required: false,
        min_confidence: 0.8,
      },
    ]);
  };
  const removeField = (index: number): void => {
    props.onChange(props.fields.filter((_field, fieldIndex) => fieldIndex !== index));
  };

  return (
    <div className="document-field-editor" aria-label="추출 필드 편집">
      <div className="document-field-editor-head">
        <div>
          <strong>추출 필드</strong>
          <span className="subtle">{requiredFieldCount(props.fields)}개 필수 · {props.fields.length}개 전체</span>
        </div>
        <button className="btn" type="button" onClick={addField}>필드 추가</button>
      </div>
      <div className="table-wrap">
        <table className="ops-table">
          <thead>
            <tr>
              <th scope="col">필드 키</th>
              <th scope="col">표시 이름</th>
              <th scope="col">유형</th>
              <th scope="col">필수</th>
              <th scope="col">신뢰도</th>
              <th scope="col">별칭</th>
              <th scope="col">작업</th>
            </tr>
          </thead>
          <tbody>
            {props.fields.map((field, index) => (
              <tr key={`${field.key}-${index}`}>
                <td>
                  <input
                    aria-label={`필드 키 ${index + 1}`}
                    value={field.key}
                    onChange={(event) => updateField(index, { key: event.target.value })}
                    placeholder="invoice_id"
                  />
                </td>
                <td>
                  <input
                    aria-label={`표시 이름 ${index + 1}`}
                    value={field.label ?? ""}
                    onChange={(event) => updateField(index, { label: event.target.value })}
                    placeholder="송장 번호"
                  />
                </td>
                <td>
                  <select
                    aria-label={`필드 유형 ${index + 1}`}
                    value={field.type ?? "text"}
                    onChange={(event) => updateField(index, { type: event.target.value as DocumentFieldType })}
                  >
                    {FIELD_TYPES.map((type) => <option key={type} value={type}>{fieldTypeLabel(type)}</option>)}
                  </select>
                </td>
                <td>
                  <label className="checkbox-inline">
                    <input
                      aria-label={`필수 필드 ${index + 1}`}
                      type="checkbox"
                      checked={field.required === true}
                      onChange={(event) => updateField(index, { required: event.target.checked })}
                    />
                    <span>{field.required === true ? "필수" : "선택"}</span>
                  </label>
                </td>
                <td>
                  <input
                    aria-label={`신뢰도 기준 ${index + 1}`}
                    type="number"
                    min={0}
                    max={1}
                    step={0.05}
                    value={field.min_confidence ?? 0.8}
                    onChange={(event) => updateField(index, { min_confidence: Number(event.target.value) })}
                  />
                </td>
                <td>
                  <input
                    aria-label={`별칭 ${index + 1}`}
                    value={(field.aliases ?? []).join(", ")}
                    onChange={(event) => updateField(index, { aliases: splitAliases(event.target.value) })}
                    placeholder="Invoice ID, Total"
                  />
                </td>
                <td>
                  <button className="btn" type="button" onClick={() => removeField(index)} disabled={props.fields.length <= 1}>
                    삭제
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function DocumentDetail(props: {
  job: DocumentJobItem | null;
  isLoading: boolean;
  extraction: DocumentExtraction | null;
  extractionError: unknown | null;
  sourceArtifacts: readonly RunArtifactItem[];
  onExtract: (jobId: string) => void;
  onRetryExtraction: () => void;
  onCreateValidationTask: (jobId: string) => void;
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
          <EmptyState message="아직 저장된 추출 결과가 없습니다." action={<button className="btn" type="button" onClick={() => props.onExtract(props.job!.document_job_id)}>지금 추출</button>} />
        ) : props.extractionError !== null ? (
          <ErrorState message={`추출 결과를 불러오지 못했습니다. ${errorLabel(props.extractionError)}`} onRetry={props.onRetryExtraction} />
        ) : props.extraction === null ? (
          <Loading />
        ) : (
          <ExtractionResult extraction={props.extraction} />
        )}
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
        {props.extraction.validation_human_task_id !== null && (
          <button className="linklike" type="button" onClick={() => navigate("humanTasks", { ht: props.extraction.validation_human_task_id! })}>
            검증 작업 열기
          </button>
        )}
      </div>
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

function DocumentStatusBadge(props: { status: DocumentJobStatus }): JSX.Element {
  return <span className={`badge ${documentStatusTone(props.status)}`}>{documentStatusLabel(props.status)}</span>;
}

function DocumentExtractionStatusBadge(props: { status: DocumentExtraction["status"] }): JSX.Element {
  return <span className={`badge ${props.status === "completed" ? "green" : props.status === "failed" ? "red" : "amber"}`}>{props.status === "completed" ? "추출 완료" : props.status === "failed" ? "실패" : "검증 필요"}</span>;
}

function FieldStatusBadge(props: { field: DocumentExtractionField }): JSX.Element {
  const label = props.field.status === "extracted" ? "확정" : props.field.status === "low_confidence" ? "검증 필요" : "누락";
  const tone = props.field.status === "extracted" ? "green" : "amber";
  return <span className={`badge ${tone}`}>{label}</span>;
}

function documentStatusLabel(status: DocumentJobStatus): string {
  switch (status) {
    case "created": return "추출 대기";
    case "extracted": return "추출 완료";
    case "validation_required": return "검증 필요";
    case "validated": return "검증 완료";
    case "failed": return "실패";
  }
}

function documentStatusTone(status: DocumentJobStatus): "green" | "amber" | "red" | "blue" {
  switch (status) {
    case "created": return "blue";
    case "extracted":
    case "validated": return "green";
    case "validation_required": return "amber";
    case "failed": return "red";
  }
}

function documentTypeLabel(type: string): string {
  if (type === "invoice") return "송장";
  if (type === "contract") return "계약서";
  return type;
}

function fieldTypeLabel(type: string): string {
  if (type === "number") return "숫자";
  if (type === "date") return "날짜";
  if (type === "boolean") return "참/거짓";
  return "텍스트";
}

function fieldSourceLabel(source: string): string {
  if (source === "json") return "JSON 키";
  if (source === "csv") return "CSV 헤더";
  if (source === "pattern") return "패턴";
  if (source === "label") return "라벨 문장";
  return "누락";
}

function requiredFieldCount(fields: readonly DocumentFieldSchema[]): number {
  return fields.filter((field) => field.required === true).length;
}

function cloneFields(fields: readonly DocumentFieldSchema[]): DocumentFieldSchema[] {
  return fields.map((field) => ({ ...field, aliases: field.aliases === undefined ? undefined : [...field.aliases] }));
}

function cleanFieldSchema(fields: readonly DocumentFieldSchema[]): DocumentFieldSchema[] {
  return fields.map((field) => {
    const aliases = (field.aliases ?? []).map((alias) => alias.trim()).filter((alias) => alias.length > 0);
    return {
      key: field.key.trim(),
      ...(field.label?.trim() ? { label: field.label.trim() } : {}),
      type: field.type ?? "text",
      required: field.required === true,
      ...(aliases.length > 0 ? { aliases } : {}),
      min_confidence: field.min_confidence ?? 0.8,
    };
  });
}

function fieldSchemaValidationMessage(fields: readonly DocumentFieldSchema[]): string | null {
  if (fields.length === 0) return "추출 필드는 1개 이상이어야 합니다.";
  const keys = new Set<string>();
  for (const field of fields) {
    const key = field.key.trim();
    if (key.length === 0) return "필드 키를 입력하세요.";
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(key)) return "필드 키는 영문자로 시작하고 영문, 숫자, 밑줄만 사용할 수 있습니다.";
    if (keys.has(key)) return "중복된 필드 키가 있습니다.";
    keys.add(key);
    if ((field.label ?? "").trim().length === 0) return "표시 이름을 입력하세요.";
    const confidence = field.min_confidence ?? 0.8;
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) return "신뢰도 기준은 0에서 1 사이여야 합니다.";
  }
  return null;
}

function splitAliases(value: string): readonly string[] | undefined {
  const aliases = value.split(",").map((item) => item.trim()).filter((item) => item.length > 0);
  return aliases.length > 0 ? aliases : undefined;
}

function isDocumentSourceArtifact(artifact: RunArtifactItem): boolean {
  if (artifact.redaction_status !== "redacted" && artifact.redaction_status !== "not_required") return false;
  const mediaType = (artifact.media_type ?? "").toLowerCase();
  const filename = (artifact.filename ?? "").toLowerCase();
  const type = artifact.type.toLowerCase();
  return (
    mediaType === "application/json" ||
    mediaType === "text/csv" ||
    mediaType.startsWith("text/") ||
    filename.endsWith(".json") ||
    filename.endsWith(".csv") ||
    filename.endsWith(".txt") ||
    type.includes("json") ||
    type.includes("csv") ||
    type.includes("text")
  );
}

function runOptionLabel(run: RunItem): string {
  const time = run.updated_at ?? run.as_of;
  return time !== null && time !== undefined
    ? `${runStatusLabel(run.status)} · ${formatDateTime(time)}`
    : runStatusLabel(run.status);
}

function runStatusLabel(status: string): string {
  switch (status) {
    case "queued": return "대기 실행";
    case "running": return "실행 중";
    case "completed": return "완료 실행";
    case "failed_system":
    case "failed_business": return "실패 실행";
    case "suspended": return "사람 확인 대기";
    case "cancelled": return "취소된 실행";
    default: return "실행 기록";
  }
}

function artifactLabel(artifact: RunArtifactItem): string {
  const name = artifact.filename?.trim();
  if (name !== undefined && name.length > 0) return name;
  if (artifact.media_type === "application/json" || artifact.type.toLowerCase().includes("json")) return "JSON 결과";
  if (artifact.media_type === "text/csv" || artifact.type.toLowerCase().includes("csv")) return "CSV 문서";
  if (artifact.media_type?.startsWith("text/") === true || artifact.type.toLowerCase().includes("text")) return "텍스트 문서";
  return "문서 산출물";
}

function artifactLabelById(id: string, artifacts: readonly RunArtifactItem[]): string {
  const artifact = artifacts.find((item) => item.artifact_id === id);
  return artifact !== undefined ? artifactLabel(artifact) : "선택한 증빙 자료";
}

function principalDisplayLabel(value: string): string {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value) || value.includes("|")) {
    return "등록자 확인됨";
  }
  return value;
}

function isExtractionNotFound(error: unknown): boolean {
  return error instanceof ApiError && error.httpStatus === 404;
}

function artifactPickerHint(runId: string, loading: boolean, failed: boolean, count: number, truncated: boolean): string {
  if (runId.trim().length === 0) return "먼저 실행 기록을 선택하세요.";
  if (loading) return "실행 산출물을 불러오는 중입니다.";
  if (failed) return "실행 산출물을 불러오지 못했습니다.";
  if (count === 0) return "redacted 처리된 JSON, CSV, 텍스트 산출물이 있는 실행을 선택하세요.";
  if (truncated) return "문서 후보 1000건 기준입니다. 필요한 산출물이 없으면 실행 기록에서 직접 열어 확인하세요.";
  return "redacted 처리된 JSON, CSV, 텍스트 산출물만 표시합니다.";
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat("ko-KR", { dateStyle: "short", timeStyle: "short" }).format(new Date(value));
}
