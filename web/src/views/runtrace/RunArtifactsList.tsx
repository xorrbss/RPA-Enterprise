import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { useApiClient } from "../../api/context";
import { mergeParams, useHashParam } from "../../router";
import { ArtifactRef } from "../../components/ArtifactLookup";
import { ArtifactMediaPreview } from "../../components/ArtifactMediaPreview";
import { ErrorState, Loading } from "../../components/states";
import type { RunArtifactItem, ScenarioGenerationEvidence } from "../../api/types";
import { POLL_MS } from "./constants";
import {
  artifactLabel,
  artifactProvenanceLabel,
  artifactSummary,
  artifactTypeLabel,
  hasStepProvenance,
  isArtifactReadable,
  isPreviewableMedia,
  jsonSummaryLabel,
  mediaKind,
  mediaKindLabel,
  mediaMetaLabels,
  mergeArtifactPages,
  previewMediaType,
  redactionStatusLabel,
  shortId,
  summarizeJsonArtifact,
  uniqueArtifactItems,
} from "./artifact-helpers";
import { JsonSummaryPreview, TextArtifactSummaryPreview } from "./ArtifactPreview";
import { EvidenceStorageReadout } from "./EvidenceStorageReadout";

// 산출물(artifact) 목록 + 결과 미리보기 — 본문 조회는 getArtifact(redaction→RBAC→audit 게이트)를 통한다. 라이브=폴링.
export function RunArtifactsList({
  runId,
  focusOnMount,
  runStatus,
  evidencePolicy,
}: {
  runId: string;
  focusOnMount: boolean;
  runStatus: string | undefined;
  evidencePolicy: ScenarioGenerationEvidence | undefined;
}): JSX.Element {
  const api = useApiClient();
  const artifactsRef = useRef<HTMLDivElement | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pagination, setPagination] = useState<{
    runId: string;
    firstPageCursor: string | null;
    nextCursor: string | null;
    extraItems: readonly RunArtifactItem[];
    loadingMore: boolean;
    loadMoreError: string | null;
  }>({
    runId,
    firstPageCursor: null,
    nextCursor: null,
    extraItems: [],
    loadingMore: false,
    loadMoreError: null,
  });
  const hashArtifactId = useHashParam("artifact");
  const q = useQuery({
    queryKey: ["run-artifacts", runId],
    queryFn: () => api.listRunArtifacts(runId, { limit: 100 }),
    refetchInterval: POLL_MS,
  });
  const firstPageItems: readonly RunArtifactItem[] = q.data?.items ?? [];
  const firstPageCursor = q.data?.next_cursor ?? null;
  const paginationMatchesFirstPage =
    pagination.runId === runId &&
    pagination.firstPageCursor === firstPageCursor;
  const extraItems = paginationMatchesFirstPage ? pagination.extraItems : [];
  const nextCursor = paginationMatchesFirstPage
    ? pagination.nextCursor
    : firstPageCursor;
  const loadingMore = paginationMatchesFirstPage
    ? pagination.loadingMore
    : false;
  const loadMoreError = paginationMatchesFirstPage
    ? pagination.loadMoreError
    : null;
  const items: readonly RunArtifactItem[] = mergeArtifactPages(
    firstPageItems,
    extraItems,
  );
  const hasMoreArtifacts = nextCursor !== null;
  const preferred =
    items.find((a) => isArtifactReadable(a) && isPreviewableMedia(a)) ??
    items.find(
      (a) =>
        isArtifactReadable(a) && /json|extract|output|result/i.test(a.type),
    ) ??
    items.find(isArtifactReadable) ??
    items[0];
  const hashSelectedId =
    hashArtifactId !== null &&
    items.some((a) => a.artifact_id === hashArtifactId)
      ? hashArtifactId
      : null;
  const stateSelectedId =
    selectedId !== null && items.some((a) => a.artifact_id === selectedId)
      ? selectedId
      : null;
  const effectiveSelectedId =
    hashSelectedId ?? stateSelectedId ?? preferred?.artifact_id ?? null;
  const selectedItem = items.find((a) => a.artifact_id === effectiveSelectedId);
  const selectedIsReadable = isArtifactReadable(selectedItem);
  const selectedIsMedia = isPreviewableMedia(selectedItem);
  const selectedMediaType = previewMediaType(selectedItem);
  const counts = artifactSummary(items);
  useEffect(() => {
    setPagination((current) => {
      if (
        current.runId === runId &&
        current.firstPageCursor === firstPageCursor
      )
        return current;
      return {
        runId,
        firstPageCursor,
        nextCursor: firstPageCursor,
        extraItems: [],
        loadingMore: false,
        loadMoreError: null,
      };
    });
  }, [firstPageCursor, runId]);
  useEffect(() => {
    if (hashSelectedId !== null && selectedId !== hashSelectedId) {
      setSelectedId(hashSelectedId);
    }
  }, [hashSelectedId, selectedId]);
  useEffect(() => {
    if (focusOnMount) artifactsRef.current?.focus();
  }, [focusOnMount]);
  const detail = useQuery({
    queryKey: ["artifact-detail", effectiveSelectedId],
    queryFn: () => api.getArtifact(effectiveSelectedId as string),
    enabled:
      effectiveSelectedId !== null && selectedIsReadable && !selectedIsMedia,
  });
  const summary =
    detail.data !== undefined ? summarizeJsonArtifact(detail.data) : null;
  async function loadMoreArtifacts(): Promise<void> {
    if (nextCursor === null || loadingMore) return;
    const cursor = nextCursor;
    setPagination((current) => {
      if (
        current.runId === runId &&
        current.firstPageCursor === firstPageCursor
      ) {
        return { ...current, loadingMore: true, loadMoreError: null };
      }
      return {
        runId,
        firstPageCursor,
        nextCursor: cursor,
        extraItems: [],
        loadingMore: true,
        loadMoreError: null,
      };
    });
    try {
      const page = await api.listRunArtifacts(runId, { limit: 100, cursor });
      setPagination((current) => {
        if (
          current.runId !== runId ||
          current.firstPageCursor !== firstPageCursor
        )
          return current;
        const firstPageIds = new Set(
          firstPageItems.map((item) => item.artifact_id),
        );
        const nextExtraItems = uniqueArtifactItems([
          ...current.extraItems,
          ...page.items,
        ]).filter((item) => !firstPageIds.has(item.artifact_id));
        return {
          ...current,
          nextCursor: page.next_cursor,
          extraItems: nextExtraItems,
          loadingMore: false,
          loadMoreError: null,
        };
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown error";
      setPagination((current) =>
        current.runId === runId && current.firstPageCursor === firstPageCursor
          ? { ...current, loadingMore: false, loadMoreError: message }
          : current,
      );
    }
  }
  return (
    <div
      ref={artifactsRef}
      role="region"
      aria-label="실행 결과·증빙"
      tabIndex={focusOnMount ? -1 : undefined}
      style={{ marginTop: 14 }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 8,
          flexWrap: "wrap",
        }}
      >
        <strong style={{ fontSize: 13 }}>실행 결과·증빙</strong>
        {items.length > 0 && (
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              flexWrap: "wrap",
            }}
            aria-label="증빙 요약"
          >
            <span className="subtle">
              증빙 {items.length}
              {hasMoreArtifacts ? "+건" : "건"}
            </span>
            <span className="badge blue">스크린샷 {counts.screenshots}</span>
            <span className="badge amber">동영상 {counts.videos}</span>
            {hasMoreArtifacts && <span className="badge muted">더 있음</span>}
            {counts.pending > 0 && (
              <span className="badge muted">처리 대기 {counts.pending}</span>
            )}
          </span>
        )}
      </div>
      <EvidenceStorageReadout
        policy={evidencePolicy}
        counts={counts}
        runStatus={runStatus}
        loaded={!q.isLoading && !q.isError}
      />
      {q.isLoading ? (
        <Loading />
      ) : q.isError ? (
        <ErrorState
          message="증빙 목록을 불러오지 못했습니다."
          onRetry={() => void q.refetch()}
        />
      ) : items.length === 0 ? (
        <p className="subtle" style={{ margin: "8px 0 0" }}>
          표시할 증빙이 없습니다. 이미지나 동영상 증거는 아직 처리 중일 수
          있습니다.
        </p>
      ) : (
        <div style={{ display: "grid", gap: 10, marginTop: 8 }}>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>증빙</th>
                  <th>단계/시도</th>
                  <th>종류</th>
                  <th>파일명</th>
                  <th>파일 정보</th>
                  <th>처리 상태</th>
                  <th>보존 만료</th>
                  <th>보존 잠금</th>
                  <th>결과 보기</th>
                </tr>
              </thead>
              <tbody>
                {items.map((a) => {
                  const kind = mediaKind(a);
                  const labels = mediaMetaLabels(a);
                  const isReadable = isArtifactReadable(a);
                  return (
                    <tr
                      key={a.artifact_id}
                      data-current={
                        a.artifact_id === effectiveSelectedId
                          ? "true"
                          : undefined
                      }
                    >
                      <td>
                        <span title="원문 증빙 번호">
                          {artifactLabel(a.artifact_id)}
                        </span>
                        <details className="developer-details">
                          <summary>증빙 번호 보기</summary>
                          <ArtifactRef id={a.artifact_id} />
                        </details>
                      </td>
                      <td>
                        {hasStepProvenance(a) ? (
                          <button
                            className="linklike"
                            type="button"
                            onClick={() =>
                              mergeParams({
                                step: a.step_id,
                                attempt:
                                  typeof a.attempt === "number"
                                    ? String(a.attempt)
                                    : null,
                              })
                            }
                          >
                            <span title={a.step_id}>{artifactProvenanceLabel(a)}</span>
                          </button>
                        ) : (
                          <span className="subtle">
                            {artifactProvenanceLabel(a)}
                          </span>
                        )}
                      </td>
                      <td>
                        <span
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 6,
                            flexWrap: "wrap",
                          }}
                        >
                          <span title={a.type}>
                            {artifactTypeLabel(a.type)}
                          </span>
                          {kind !== null && (
                            <span
                              className={`badge ${kind === "video" ? "amber" : "blue"}`}
                            >
                              {mediaKindLabel(kind)}
                            </span>
                          )}
                        </span>
                      </td>
                      <td>{a.filename ?? "—"}</td>
                      <td>
                        {labels.length > 0 ? (
                          <span className="subtle">{labels.join(" · ")}</span>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td>
                        <span
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 6,
                            flexWrap: "wrap",
                          }}
                        >
                          <span
                            className={`badge ${isReadable ? "green" : "amber"}`}
                            title="마스킹 처리 상태"
                          >
                            {redactionStatusLabel(a.redaction_status)}
                          </span>
                          {!isReadable && (
                            <span className="subtle">처리 대기</span>
                          )}
                        </span>
                      </td>
                      <td>{a.retention_until ?? "—"}</td>
                      <td>{a.legal_hold ? "예" : "—"}</td>
                      <td>
                        <button
                          className="btn"
                          type="button"
                          disabled={!isReadable}
                          title={
                            !isReadable
                              ? "처리가 완료되면 미리볼 수 있습니다."
                              : undefined
                          }
                          onClick={() => {
                            setSelectedId(a.artifact_id);
                            mergeParams({
                              artifact: a.artifact_id,
                              focus: "artifacts",
                            });
                          }}
                        >
                          {a.artifact_id === effectiveSelectedId
                            ? "선택됨"
                            : "미리보기"}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {(hasMoreArtifacts || loadingMore || loadMoreError !== null) && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                flexWrap: "wrap",
              }}
            >
              <button
                className="btn"
                type="button"
                disabled={loadingMore || nextCursor === null}
                onClick={() => void loadMoreArtifacts()}
              >
                {loadingMore ? "불러오는 중" : "더 보기"}
              </button>
              {hasMoreArtifacts && (
                <span className="subtle">다음 증빙이 더 있습니다.</span>
              )}
              {loadMoreError !== null && (
                <span className="badge amber" role="status">
                  다음 페이지 로드 실패: {loadMoreError}
                </span>
              )}
            </div>
          )}
          {effectiveSelectedId !== null && (
            <div
              style={{ borderTop: "1px solid var(--border)", paddingTop: 10 }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  flexWrap: "wrap",
                }}
              >
                <strong style={{ fontSize: 13 }}>결과 미리보기</strong>
                <span className="subtle">
                  선택한 증빙 참조 번호 {shortId(effectiveSelectedId)}
                </span>
                {summary !== null && (
                  <span className="badge green">
                    {jsonSummaryLabel(summary.label)} {summary.count}건
                  </span>
                )}
                {summary !== null && summary.keys.length > 0 && (
                  <span className="subtle">
                    표시 항목 {summary.keys.join(", ")}
                  </span>
                )}
              </div>
              {selectedItem !== undefined && !selectedIsReadable ? (
                <p
                  className="subtle"
                  role="status"
                  style={{ margin: "8px 0 0" }}
                >
                  처리가 완료되면 미리볼 수 있습니다.
                </p>
              ) : detail.isLoading ? (
                <Loading />
              ) : detail.isError ? (
                <ErrorState
                  message="증빙 결과를 불러오지 못했습니다."
                  onRetry={() => void detail.refetch()}
                />
              ) : selectedItem !== undefined && selectedIsMedia ? (
                <ArtifactMediaPreview
                  artifactId={selectedItem.artifact_id}
                  mediaType={selectedMediaType}
                  filename={selectedItem.filename}
                />
              ) : detail.data !== undefined ? (
                summary !== null ? (
                  <JsonSummaryPreview summary={summary} />
                ) : (
                  <TextArtifactSummaryPreview content={detail.data.content} />
                )
              ) : null}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
