import { useEffect, useMemo, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";

import { useApiClient } from "../api/context";
import type { GenerationArtifactItem } from "../api/types";
import { ArtifactRef } from "./ArtifactLookup";
import { ArtifactMediaPreview } from "./ArtifactMediaPreview";
import { errorLabel } from "./badges";

function formatArtifactBytes(bytes: number | null | undefined): string | null {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function artifactMetaLabel(item: GenerationArtifactItem): string {
  return [
    item.media_type ?? null,
    formatArtifactBytes(item.byte_size),
    item.redaction_status,
  ].filter((value): value is string => value !== null && value.length > 0).join(" · ");
}

function previewGenerationArtifactMediaType(item: GenerationArtifactItem | undefined): string | null {
  if (item === undefined) return null;
  if (typeof item.media_type === "string" && (item.media_type.startsWith("image/") || item.media_type.startsWith("video/"))) {
    return item.media_type;
  }
  const hints = `${item.type} ${item.filename ?? ""}`.toLowerCase();
  if (hints.includes("video")) return "video/webm";
  if (hints.includes("screenshot") || hints.includes("screen_capture") || hints.includes("image") || /\.(png|jpe?g|webp)\b/.test(hints)) {
    return "image/png";
  }
  return null;
}

function artifactMediaKind(item: GenerationArtifactItem): "image" | "video" | null {
  const mediaType = previewGenerationArtifactMediaType(item);
  if (mediaType?.startsWith("image/")) return "image";
  if (mediaType?.startsWith("video/")) return "video";
  return null;
}

function artifactSummary(items: readonly GenerationArtifactItem[]): { images: number; videos: number } {
  return items.reduce(
    (acc, item) => {
      const kind = artifactMediaKind(item);
      if (kind === "image") acc.images += 1;
      if (kind === "video") acc.videos += 1;
      return acc;
    },
    { images: 0, videos: 0 },
  );
}

function dedupeArtifacts(items: readonly GenerationArtifactItem[]): readonly GenerationArtifactItem[] {
  const seen = new Set<string>();
  const deduped: GenerationArtifactItem[] = [];
  for (const item of items) {
    if (seen.has(item.artifact_id)) continue;
    seen.add(item.artifact_id);
    deduped.push(item);
  }
  return deduped;
}

function previewText(content: string): string {
  try {
    return JSON.stringify(JSON.parse(content), null, 2).slice(0, 3000);
  } catch {
    return content.slice(0, 3000);
  }
}

export function GenerationArtifactsPanel({
  generationId,
  title = "Planner 산출물",
}: {
  generationId: string;
  title?: string;
}): JSX.Element {
  const api = useApiClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const list = useInfiniteQuery({
    queryKey: ["scenario-generation-artifacts", generationId],
    queryFn: ({ pageParam }) =>
      api.listScenarioGenerationArtifacts(generationId, {
        limit: 20,
        ...(typeof pageParam === "string" ? { cursor: pageParam } : {}),
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.next_cursor,
    refetchInterval: 10_000,
  });
  const pages = list.data?.pages ?? [];
  const lastPage = pages.length > 0 ? pages[pages.length - 1] : undefined;
  const hasMore = (lastPage?.next_cursor ?? null) !== null;
  const items = useMemo(() => dedupeArtifacts(pages.flatMap((page) => page.items)), [pages]);
  const preferred = items.find((item) => previewGenerationArtifactMediaType(item) !== null) ?? items[0];
  const summary = artifactSummary(items);
  const effectiveSelectedId =
    selectedId !== null && items.some((item) => item.artifact_id === selectedId)
      ? selectedId
      : preferred?.artifact_id ?? null;
  useEffect(() => {
    if (items.length === 0) {
      if (selectedId !== null) setSelectedId(null);
      return;
    }
    if (selectedId === null || !items.some((item) => item.artifact_id === selectedId)) {
      setSelectedId(preferred?.artifact_id ?? null);
    }
  }, [items, preferred?.artifact_id, selectedId]);
  const selected = items.find((item) => item.artifact_id === effectiveSelectedId);
  const selectedMediaType = previewGenerationArtifactMediaType(selected);
  const detail = useQuery({
    queryKey: ["scenario-generation-artifact", generationId, effectiveSelectedId],
    queryFn: () => api.getScenarioGenerationArtifact(generationId, effectiveSelectedId as string),
    enabled: effectiveSelectedId !== null && selectedMediaType === null,
  });

  return (
    <div className="generation-artifacts" aria-label="generation artifacts">
      <div className="generation-artifacts-head">
        <strong>{title}</strong>
        {items.length > 0 && <span className="badge muted">{items.length}{hasMore ? "+" : ""}건</span>}
        {hasMore && <span className="badge amber">더 있음</span>}
        {summary.images > 0 && <span className="badge blue">image {summary.images}</span>}
        {summary.videos > 0 && <span className="badge amber">video {summary.videos}</span>}
        {hasMore && (
          <button className="linklike" type="button" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
            {list.isFetchingNextPage ? "더 불러오는 중" : "더 보기"}
          </button>
        )}
        <button className="linklike" type="button" onClick={() => void list.refetch()}>
          새로고침
        </button>
      </div>
      {list.isLoading ? (
        <p className="muted">산출물 확인 중</p>
      ) : list.isError ? (
        <p className="form-alert red">{errorLabel(list.error)}</p>
      ) : items.length === 0 && !hasMore ? (
        <p className="muted">표시할 planner 산출물이 없습니다. redaction 처리 중일 수 있습니다.</p>
      ) : (
        <div className="generation-artifact-grid">
          <div className="generation-artifact-list">
            {items.length === 0 && hasMore ? (
              <p className="muted">다음 페이지에 산출물이 더 있습니다.</p>
            ) : (
              items.map((item) => (
                <button
                  key={item.artifact_id}
                  className={item.artifact_id === effectiveSelectedId ? "active" : ""}
                  type="button"
                  onClick={() => setSelectedId(item.artifact_id)}
                >
                  <code>{item.artifact_id.slice(0, 8)}</code>
                  <span>{item.type}</span>
                  <small>{artifactMetaLabel(item)}</small>
                </button>
              ))
            )}
          </div>
          <div className="generation-artifact-preview">
            {selected !== undefined && (
              <div className="inline-facts">
                <span className="subtle">선택</span>
                <ArtifactRef id={selected.artifact_id} />
                <span className="subtle">유형 {selected.type}</span>
              </div>
            )}
            {selected !== undefined && selectedMediaType !== null ? (
              <ArtifactMediaPreview artifactId={selected.artifact_id} mediaType={selectedMediaType} filename={selected.filename} />
            ) : detail.isLoading ? (
              <p className="muted">본문 불러오는 중</p>
            ) : detail.isError ? (
              <p className="form-alert red">{errorLabel(detail.error)}</p>
            ) : detail.data !== undefined ? (
              <pre>{previewText(detail.data.content)}</pre>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}
