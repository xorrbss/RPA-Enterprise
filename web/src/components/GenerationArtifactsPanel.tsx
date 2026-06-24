import { useEffect, useMemo, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";

import { useApiClient } from "../api/context";
import type { ArtifactDetail, GenerationArtifactItem } from "../api/types";
import { ArtifactRef } from "./ArtifactLookup";
import { ArtifactMediaPreview } from "./ArtifactMediaPreview";
import { errorLabel } from "./badges";

type GenerationArtifactSource = "planner" | "result";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatArtifactBytes(bytes: number | null | undefined): string | null {
  if (
    bytes === null ||
    bytes === undefined ||
    !Number.isFinite(bytes) ||
    bytes < 0
  )
    return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function artifactRedactionLabel(
  status: GenerationArtifactItem["redaction_status"],
): string {
  if (status === "redacted") return "마스킹 완료";
  if (status === "not_required") return "마스킹 불필요";
  if (status === "pending") return "마스킹 대기";
  return status;
}

function artifactMetaLabel(item: GenerationArtifactItem): string {
  return [
    item.filename ?? null,
    formatArtifactBytes(item.byte_size),
    artifactRedactionLabel(item.redaction_status),
  ]
    .filter((value): value is string => value !== null && value.length > 0)
    .join(" · ");
}

function previewGenerationArtifactMediaType(
  item: GenerationArtifactItem | undefined,
): string | null {
  if (item === undefined) return null;
  if (
    typeof item.media_type === "string" &&
    (item.media_type.startsWith("image/") ||
      item.media_type.startsWith("video/"))
  ) {
    return item.media_type;
  }
  const hints = `${item.type} ${item.filename ?? ""}`.toLowerCase();
  if (hints.includes("video")) return "video/webm";
  if (
    hints.includes("screenshot") ||
    hints.includes("screen_capture") ||
    hints.includes("image") ||
    /\.(png|jpe?g|webp)\b/.test(hints)
  ) {
    return "image/png";
  }
  return null;
}

function artifactMediaKind(
  item: GenerationArtifactItem,
): "image" | "video" | null {
  const mediaType = previewGenerationArtifactMediaType(item);
  if (mediaType?.startsWith("image/")) return "image";
  if (mediaType?.startsWith("video/")) return "video";
  return null;
}

function artifactTypeLabel(item: GenerationArtifactItem): string {
  if (item.type === "extract_result_json") return "추출 결과";
  if (item.type === "scenario_generation_planner_output") return "생성 진단";
  if (item.type === "scenario_generation_validation_report")
    return "검증 보고서";
  if (item.type === "screen_capture" || item.type === "screenshot")
    return "화면 캡처";
  if (item.type === "run_video" || item.type.includes("video"))
    return "실행 영상";
  const kind = artifactMediaKind(item);
  if (kind === "image") return "이미지 증거";
  if (kind === "video") return "영상 증거";
  return "증빙";
}

function isArtifactReadable(item: GenerationArtifactItem | undefined): boolean {
  return (
    item?.redaction_status === "redacted" ||
    item?.redaction_status === "not_required"
  );
}

function artifactSummary(items: readonly GenerationArtifactItem[]): {
  images: number;
  videos: number;
  pending: number;
} {
  return items.reduce(
    (acc, item) => {
      const kind = artifactMediaKind(item);
      if (isArtifactReadable(item)) {
        if (kind === "image") acc.images += 1;
        if (kind === "video") acc.videos += 1;
      }
      if (item.redaction_status === "pending") acc.pending += 1;
      return acc;
    },
    { images: 0, videos: 0, pending: 0 },
  );
}

function dedupeArtifacts(
  items: readonly GenerationArtifactItem[],
): readonly GenerationArtifactItem[] {
  const seen = new Set<string>();
  const deduped: GenerationArtifactItem[] = [];
  for (const item of items) {
    if (seen.has(item.artifact_id)) continue;
    seen.add(item.artifact_id);
    deduped.push(item);
  }
  return deduped;
}

function validationIssueSummary(issue: unknown): string {
  if (!isRecord(issue)) return "검증 항목을 확인하세요.";
  const key =
    `${issue.rule ?? ""} ${issue.code ?? ""} ${issue.message ?? ""} ${issue.reason ?? ""}`.toLowerCase();
  if (key.includes("target") || key.includes("branch") || key.includes("node"))
    return "조건 분기 대상 단계 연결을 확인하세요.";
  if (key.includes("action") || key.includes("unsupported"))
    return "지원하지 않는 자동화 동작을 다시 선택하세요.";
  if (key.includes("instruction") || key.includes("extract"))
    return "데이터 추출 지시문 또는 출력 형식을 확인하세요.";
  if (key.includes("priority")) return "조건 우선순위가 겹치는지 확인하세요.";
  if (key.includes("loop")) return "반복 단계의 종료 조건을 확인하세요.";
  if (key.includes("url") || key.includes("navigate"))
    return "페이지 이동 주소와 사이트 등록 상태를 확인하세요.";
  return "검증 항목을 확인하세요.";
}

function validationReportSummary(
  content: string,
): readonly { key: string; value: string }[] | null {
  try {
    const parsed: unknown = JSON.parse(content);
    const report =
      isRecord(parsed) && isRecord(parsed.report) ? parsed.report : parsed;
    if (!isRecord(report)) return null;
    const errors = Array.isArray(report.errors) ? report.errors : [];
    const warnings = Array.isArray(report.warnings) ? report.warnings : [];
    const rows: { key: string; value: string }[] = [];
    if (errors.length > 0) {
      rows.push({ key: "오류", value: `${errors.length}건` });
      rows.push({ key: "주요 조치", value: validationIssueSummary(errors[0]) });
    }
    if (warnings.length > 0)
      rows.push({ key: "주의", value: `${warnings.length}건` });
    if (rows.length === 0)
      rows.push({ key: "검증 결과", value: "추가 조치 없음" });
    return rows;
  } catch {
    return null;
  }
}

function summaryValueLabel(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "예" : "아니오";
  if (typeof value === "number") return value.toLocaleString("ko-KR");
  if (typeof value === "string") {
    return value.length > 120 ? `${value.slice(0, 120)}…` : value;
  }
  if (Array.isArray(value)) {
    const firstRecord = value.find(isRecord);
    const keys =
      firstRecord !== undefined ? Object.keys(firstRecord).slice(0, 4) : [];
    const suffix = keys.length > 0 ? ` · 항목 ${keys.join(", ")}` : "";
    return `목록 ${value.length.toLocaleString("ko-KR")}건${suffix}`;
  }
  if (isRecord(value))
    return `구조화 값 ${Object.keys(value).length.toLocaleString("ko-KR")}개 항목`;
  return "복합 값";
}

function artifactJsonSummary(
  content: string,
  artifactType?: string,
): readonly { key: string; value: string }[] | null {
  if (artifactType === "scenario_generation_validation_report") {
    const validationSummary = validationReportSummary(content);
    if (validationSummary !== null) return validationSummary;
  }
  try {
    const parsed: unknown = JSON.parse(content);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
      return null;
    return Object.entries(parsed as Record<string, unknown>)
      .slice(0, 8)
      .map(([key, value]) => ({
        key,
        value: summaryValueLabel(value),
      }));
  } catch {
    return null;
  }
}

function TextArtifactSummary({ content }: { content: string }): JSX.Element {
  const trimmed = content.trim();
  const lineCount = trimmed === "" ? 0 : trimmed.split(/\r?\n/).length;
  return (
    <div className="artifact-json-summary" aria-label="결과 요약">
      <span>
        <span className="subtle">형식</span>
        <strong>텍스트 결과</strong>
      </span>
      <span>
        <span className="subtle">크기</span>
        <strong>{trimmed.length.toLocaleString("ko-KR")}자</strong>
      </span>
      <span>
        <span className="subtle">줄 수</span>
        <strong>{lineCount.toLocaleString("ko-KR")}줄</strong>
      </span>
    </div>
  );
}

function ArtifactTextPreview({
  content,
  artifactType,
}: {
  content: string;
  artifactType?: string;
}): JSX.Element {
  const summary = artifactJsonSummary(content, artifactType);
  if (summary === null || summary.length === 0)
    return <TextArtifactSummary content={content} />;
  return (
    <div className="artifact-text-preview">
      <div className="artifact-json-summary" aria-label="결과 요약">
        {summary.map((field) => (
          <span key={field.key}>
            <span className="subtle">{field.key}</span>
            <strong>{field.value}</strong>
          </span>
        ))}
      </div>
    </div>
  );
}

function defaultTitle(source: GenerationArtifactSource): string {
  return source === "result" ? "실행 결과 증빙" : "생성 진단 결과";
}

function emptyMessage(source: GenerationArtifactSource): string {
  return source === "result"
    ? "표시할 실행 결과 증빙이 없습니다. 이미지나 동영상 증거는 아직 처리 중일 수 있습니다."
    : "표시할 생성 진단 결과가 없습니다. 아직 처리 중일 수 있습니다.";
}

export function GenerationArtifactsPanel({
  generationId,
  source = "planner",
  title,
}: {
  generationId: string;
  source?: GenerationArtifactSource;
  title?: string;
}): JSX.Element {
  const api = useApiClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const panelTitle = title ?? defaultTitle(source);
  const list = useInfiniteQuery({
    queryKey: ["scenario-generation-artifacts", source, generationId],
    queryFn: ({ pageParam }) =>
      (source === "result"
        ? api.listScenarioGenerationResultArtifacts
        : api.listScenarioGenerationArtifacts)(generationId, {
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
  const items = useMemo(
    () => dedupeArtifacts(pages.flatMap((page) => page.items)),
    [pages],
  );
  const preferred =
    items.find(
      (item) =>
        isArtifactReadable(item) &&
        previewGenerationArtifactMediaType(item) !== null,
    ) ??
    items.find(isArtifactReadable) ??
    items[0];
  const summary = artifactSummary(items);
  const effectiveSelectedId =
    selectedId !== null && items.some((item) => item.artifact_id === selectedId)
      ? selectedId
      : (preferred?.artifact_id ?? null);
  useEffect(() => {
    if (items.length === 0) {
      if (selectedId !== null) setSelectedId(null);
      return;
    }
    if (
      selectedId === null ||
      !items.some((item) => item.artifact_id === selectedId)
    ) {
      setSelectedId(preferred?.artifact_id ?? null);
    }
  }, [items, preferred?.artifact_id, selectedId]);
  const selected = items.find(
    (item) => item.artifact_id === effectiveSelectedId,
  );
  const selectedIsReadable = isArtifactReadable(selected);
  const selectedMediaType = previewGenerationArtifactMediaType(selected);
  const detail = useQuery<ArtifactDetail>({
    queryKey: [
      "scenario-generation-artifact",
      source,
      generationId,
      effectiveSelectedId,
    ],
    queryFn: () =>
      source === "result"
        ? api.getArtifact(effectiveSelectedId as string)
        : api.getScenarioGenerationArtifact(
            generationId,
            effectiveSelectedId as string,
          ),
    enabled:
      effectiveSelectedId !== null &&
      selectedIsReadable &&
      selectedMediaType === null,
  });

  return (
    <div className="generation-artifacts" aria-label="생성 결과 증빙">
      <div className="generation-artifacts-head">
        <strong>{panelTitle}</strong>
        {items.length > 0 && (
          <span className="badge muted">
            {items.length}
            {hasMore ? "+" : ""}건
          </span>
        )}
        {hasMore && <span className="badge amber">더 있음</span>}
        {summary.images > 0 && (
          <span className="badge blue">이미지 {summary.images}</span>
        )}
        {summary.videos > 0 && (
          <span className="badge amber">영상 {summary.videos}</span>
        )}
        {summary.pending > 0 && (
          <span className="badge muted">처리 대기 {summary.pending}</span>
        )}
        {hasMore && (
          <button
            className="linklike"
            type="button"
            disabled={list.isFetchingNextPage}
            onClick={() => void list.fetchNextPage()}
          >
            {list.isFetchingNextPage ? "불러오는 중" : "더 보기"}
          </button>
        )}
        <button
          className="linklike"
          type="button"
          onClick={() => void list.refetch()}
        >
          새로고침
        </button>
      </div>
      {list.isLoading ? (
        <p className="muted">증빙 확인 중</p>
      ) : list.isError ? (
        <p className="form-alert red">{errorLabel(list.error)}</p>
      ) : items.length === 0 && !hasMore ? (
        <p className="muted">{emptyMessage(source)}</p>
      ) : (
        <div className="generation-artifact-grid">
          <div className="generation-artifact-list">
            {items.length === 0 && hasMore ? (
              <p className="muted">다음 페이지에 증빙이 더 있습니다.</p>
            ) : (
              items.map((item) => (
                <button
                  key={item.artifact_id}
                  className={
                    item.artifact_id === effectiveSelectedId ? "active" : ""
                  }
                  type="button"
                  onClick={() => setSelectedId(item.artifact_id)}
                >
                  <strong>{artifactTypeLabel(item)}</strong>
                  <small>{artifactMetaLabel(item)}</small>
                </button>
              ))
            )}
          </div>
          <div className="generation-artifact-preview">
            {selected !== undefined && (
              <div className="inline-facts">
                <span className="subtle">선택</span>
                <strong>{artifactTypeLabel(selected)}</strong>
                <span className="subtle">{artifactMetaLabel(selected)}</span>
              </div>
            )}
            {selected !== undefined && (
              <details className="developer-details artifact-technical-details">
                <summary>증빙 번호 보기</summary>
                <div className="artifact-technical-grid">
                  <span className="subtle">원문 증빙 번호</span>
                  <ArtifactRef id={selected.artifact_id} />
                  <span className="subtle">원문 증빙 유형</span>
                  <code>{selected.type}</code>
                  <span className="subtle">파일 형식</span>
                  <code>{selected.media_type ?? "-"}</code>
                </div>
              </details>
            )}
            {selected !== undefined && !selectedIsReadable ? (
              <p className="muted" role="status">
                처리가 완료되면 미리볼 수 있습니다.
              </p>
            ) : selected !== undefined && selectedMediaType !== null ? (
              <ArtifactMediaPreview
                artifactId={selected.artifact_id}
                mediaType={selectedMediaType}
                filename={selected.filename}
              />
            ) : detail.isLoading ? (
              <p className="muted">결과 불러오는 중</p>
            ) : detail.isError ? (
              <p className="form-alert red">{errorLabel(detail.error)}</p>
            ) : detail.data !== undefined ? (
              <ArtifactTextPreview
                content={detail.data.content}
                artifactType={selected?.type}
              />
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}
