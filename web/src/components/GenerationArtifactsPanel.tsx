import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { useApiClient } from "../api/context";
import type { GenerationArtifactItem } from "../api/types";
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
  const list = useQuery({
    queryKey: ["scenario-generation-artifacts", generationId],
    queryFn: () => api.listScenarioGenerationArtifacts(generationId, { limit: 20 }),
    refetchInterval: 10_000,
  });
  const items = list.data?.items ?? [];

  useEffect(() => {
    if (selectedId === null && items[0] !== undefined) {
      setSelectedId(items[0].artifact_id);
    } else if (selectedId !== null && items.length > 0 && !items.some((item) => item.artifact_id === selectedId)) {
      setSelectedId(items[0]?.artifact_id ?? null);
    }
  }, [items, selectedId]);

  const selected = items.find((item) => item.artifact_id === selectedId);
  const selectedMediaType = previewGenerationArtifactMediaType(selected);
  const detail = useQuery({
    queryKey: ["scenario-generation-artifact", generationId, selectedId],
    queryFn: () => api.getScenarioGenerationArtifact(generationId, selectedId as string),
    enabled: selectedId !== null && selectedMediaType === null,
  });

  return (
    <div className="generation-artifacts" aria-label="generation artifacts">
      <div className="generation-artifacts-head">
        <strong>{title}</strong>
        {items.length > 0 && <span className="badge muted">{items.length}건</span>}
        <button className="linklike" type="button" onClick={() => void list.refetch()}>
          새로고침
        </button>
      </div>
      {list.isLoading ? (
        <p className="muted">산출물 확인 중</p>
      ) : list.isError ? (
        <p className="form-alert red">{errorLabel(list.error)}</p>
      ) : items.length === 0 ? (
        <p className="muted">표시할 planner 산출물이 없습니다. redaction 처리 중일 수 있습니다.</p>
      ) : (
        <div className="generation-artifact-grid">
          <div className="generation-artifact-list">
            {items.map((item) => (
              <button
                key={item.artifact_id}
                className={item.artifact_id === selectedId ? "active" : ""}
                type="button"
                onClick={() => setSelectedId(item.artifact_id)}
              >
                <code>{item.artifact_id.slice(0, 8)}</code>
                <span>{item.type}</span>
                <small>{artifactMetaLabel(item)}</small>
              </button>
            ))}
          </div>
          <div className="generation-artifact-preview">
            {selected !== undefined && (
              <div className="inline-facts">
                <span className="subtle">선택</span>
                <code>{selected.artifact_id.slice(0, 8)}</code>
                <span className="subtle">{selected.type}</span>
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
