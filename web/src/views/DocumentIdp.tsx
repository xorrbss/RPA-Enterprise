import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";

import { useApiClient } from "../api/context";
import type {
  DocumentFieldSchema,
  DocumentJobItem,
  DocumentJobListParams,
  DocumentJobStatus,
  ExternalDocumentExtractionBody,
  ListParams,
} from "../api/types";
import { useListView } from "../api/useListView";
import { mergeParams, navigate, useHashIdParam } from "../router";
import { EmptyState, Loading } from "../components/states";
import { formatDateTime } from "../util/time";
import { DocumentDetail } from "./document-idp/DocumentDetail";
import { FieldSchemaEditor } from "./document-idp/FieldSchemaEditor";
import {
  FIELD_PRESETS,
  STATUS_FILTERS,
  artifactLabel,
  artifactLabelById,
  artifactPickerHint,
  cleanFieldSchema,
  cloneFields,
  documentTypeLabel,
  fieldSchemaValidationMessage,
  isDocumentSourceArtifact,
  listRecentRunsForPicker,
  listRunArtifactsForPicker,
  requiredFieldCount,
  runOptionLabel,
  type FieldPreset,
} from "./document-idp/helpers";
import { ClassifiedErrorState, DocumentStatusBadge } from "./document-idp/status";

export function DocumentIdpView(): JSX.Element {
  const api = useApiClient();
  const queryClient = useQueryClient();
  // id 딥링크 파라미터는 useHashIdParam(path-traversal 가드) — doc/run/artifact 가 client.ts path 보간으로 흐르므로
  //   조작 해시(`doc=../../gateway/policy`)가 다른 제어평면 엔드포인트를 인증 GET 하는 것 차단(적대감사 #C2).
  const selectedId = useHashIdParam("doc");
  const runParam = useHashIdParam("run");
  const artifactParam = useHashIdParam("artifact");
  const [status, setStatus] = useState<"" | DocumentJobStatus>("");
  const [sourceRunId, setSourceRunId] = useState<string>(runParam ?? "");
  const [sourceArtifactId, setSourceArtifactId] = useState<string>(artifactParam ?? "");
  const [preset, setPreset] = useState<FieldPreset>("invoice");
  const [fields, setFields] = useState<DocumentFieldSchema[]>(() => cloneFields(FIELD_PRESETS.invoice));
  const [message, setMessage] = useState<string | null>(null);
  const [templateMode, setTemplateMode] = useState(false);

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
  const fieldEditorVisible = templateMode || sourceArtifactId.trim().length > 0;

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

  const recordExternalExtraction = useMutation({
    mutationFn: (request: { readonly jobId: string; readonly body: ExternalDocumentExtractionBody }) =>
      api.recordExternalDocumentExtraction(request.jobId, request.body, crypto.randomUUID()),
    onSuccess: (result) => {
      setMessage("외부 IDP normalized 결과를 metadata-only로 등록했습니다.");
      mergeParams({ doc: result.document_job_id });
      queryClient.setQueryData(["document-extraction", result.document_job_id], result);
      void queryClient.invalidateQueries({ queryKey: ["document-jobs"] });
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
            <button className="btn" type="button" onClick={() => setTemplateMode((value) => !value)}>
              {templateMode ? "템플릿 편집 닫기" : "템플릿 편집"}
            </button>
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
          <div className="document-source-flow" aria-label="문서 소스 기반 추출 설정">
            <span className={`badge ${sourceArtifactId.trim().length > 0 ? "green" : "amber"}`}>
              {sourceArtifactId.trim().length > 0 ? "소스 선택됨" : "소스 필요"}
            </span>
            <span className="subtle">
              {sourceArtifactId.trim().length > 0
                ? "선택한 실행 산출물 기준으로 필드 템플릿을 조정합니다."
                : "실행 산출물을 선택하면 필드 편집기가 열립니다."}
            </span>
          </div>
          {fieldEditorVisible ? (
            <>
              <FieldSchemaEditor fields={fields} onChange={setFields} />
              {fieldValidation !== null && <p className="notice warning" role="alert">{fieldValidation}</p>}
            </>
          ) : (
            <EmptyState
              title="설정 필요"
              message="문서 소스 산출물을 먼저 선택하세요. 기존 템플릿만 수정하려면 템플릿 편집을 여세요."
              action={
                <button className="btn" type="button" onClick={() => navigate("runTrace")}>
                  실행 산출물 찾기
                </button>
              }
            />
          )}
          {message !== null && <p className="notice success" role="status">{message}</p>}
          {createJob.isError && <ClassifiedErrorState error={createJob.error} message="문서 추출 작업을 만들지 못했습니다." />}
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
            <ClassifiedErrorState error={list.query.error} message="문서 작업 목록을 확인하지 못했습니다." onRetry={() => void list.query.refetch()} />
          ) : (list.query.data?.items.length ?? 0) === 0 ? (
            <EmptyState title="첫 실행 전" message="문서 작업이 없습니다." />
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
        onRecordExternalExtraction={(jobId, body) => recordExternalExtraction.mutate({ jobId, body })}
        isRecordingExternalExtraction={recordExternalExtraction.isPending}
        externalExtractionError={recordExternalExtraction.isError ? recordExternalExtraction.error : null}
      />
    </div>
  );
}
