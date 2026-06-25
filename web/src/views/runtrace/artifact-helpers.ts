import type { ArtifactDetail, RunArtifactItem, ScenarioGenerationEvidence } from "../../api/types";

export type JsonSummary = {
  label: string;
  count: number;
  keys: string[];
  sample: unknown[];
};

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function summarizeJsonArtifact(detail: ArtifactDetail): JsonSummary | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(detail.content);
  } catch {
    return null;
  }
  const candidates: Array<[string, unknown]> = Array.isArray(parsed)
    ? [["records", parsed]]
    : isRecord(parsed)
      ? [
          ["records", parsed.records],
          ["rows", parsed.rows],
          ["items", parsed.items],
          ["data", parsed.data],
        ]
      : [];
  const found = candidates.find(([, value]) => Array.isArray(value));
  if (found === undefined) return null;
  const [label, value] = found;
  const rows = value as unknown[];
  const firstRecord = rows.find(isRecord);
  return {
    label,
    count: rows.length,
    keys: firstRecord !== undefined ? Object.keys(firstRecord).slice(0, 8) : [],
    sample: rows.slice(0, 5),
  };
}

export function jsonSummaryLabel(label: string): string {
  switch (label) {
    case "records":
    case "rows":
    case "items":
    case "data":
      return "결과";
    default:
      return "결과";
  }
}

export function jsonCellLabel(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return "복합 값";
  }
}

export function shortId(id: string): string {
  return id.slice(0, 8);
}

export function artifactLabel(id: string): string {
  return `증빙 #${shortId(id)}`;
}

export function artifactTypeLabel(type: string): string {
  switch (type) {
    case "extract_result_json":
      return "추출 결과";
    case "screenshot":
    case "screenshot_masked":
      return "화면 증거";
    case "video":
    case "video_masked":
      return "영상 증거";
    case "planner_trace":
      return "생성 진단";
    default:
      return "산출물";
  }
}

export function mediaKindLabel(kind: "screenshot" | "video"): string {
  return kind === "video" ? "영상" : "스크린샷";
}

export function mediaTypeLabel(mediaType: string | null | undefined): string | null {
  if (mediaType === null || mediaType === undefined || mediaType.length === 0)
    return null;
  const lower = mediaType.toLowerCase();
  if (lower === "image/png") return "PNG 이미지";
  if (lower === "image/jpeg" || lower === "image/jpg") return "JPEG 이미지";
  if (lower === "image/webp") return "WebP 이미지";
  if (lower === "video/webm") return "WebM 영상";
  if (lower === "application/json") return "구조화 결과";
  if (lower.startsWith("image/")) return "이미지";
  if (lower.startsWith("video/")) return "영상";
  if (lower.startsWith("text/")) return "텍스트 문서";
  return "첨부 파일";
}

export function redactionStatusLabel(status: string): string {
  switch (status) {
    case "redacted":
    case "not_required":
      return "조회 가능";
    case "pending":
      return "처리 중";
    case "failed":
      return "처리 실패";
    default:
      return "상태 확인 필요";
  }
}

export function mediaKind(a: RunArtifactItem): "screenshot" | "video" | null {
  const hints =
    `${a.type} ${a.media_type ?? ""} ${a.filename ?? ""}`.toLowerCase();
  if (hints.includes("video")) return "video";
  if (
    hints.includes("screenshot") ||
    hints.includes("screen_capture") ||
    hints.includes("image_capture") ||
    hints.includes("image/") ||
    /\.(png|jpe?g|webp)\b/.test(hints)
  )
    return "screenshot";
  return null;
}

// 서버가 실제로 단언한 미디어 타입만 반환한다(날조 금지). 미상이면 null — ArtifactMediaPreview 가
//   실제 blob(q.data.type)에서 종류를 해석하므로 추측한 MIME("video/webm" 등)을 만들 필요가 없다.
export function previewMediaType(a: RunArtifactItem | undefined): string | null {
  if (a === undefined) return null;
  if (
    typeof a.media_type === "string" &&
    (a.media_type.startsWith("image/") || a.media_type.startsWith("video/"))
  )
    return a.media_type;
  return null;
}

// 미리보기 가능 여부 — 서버 미디어 타입 또는 artifact 종류(screenshot/video)로 판정. 정확한 MIME 단언과는 분리.
export function isPreviewableMedia(a: RunArtifactItem | undefined): boolean {
  if (a === undefined) return false;
  if (previewMediaType(a) !== null) return true;
  const kind = mediaKind(a);
  return kind === "video" || kind === "screenshot";
}

export function isArtifactReadable(a: RunArtifactItem | undefined): boolean {
  return (
    a?.redaction_status === "redacted" || a?.redaction_status === "not_required"
  );
}

function formatByteSize(bytes: number | null | undefined): string | null {
  if (
    bytes === null ||
    bytes === undefined ||
    !Number.isFinite(bytes) ||
    bytes < 0
  )
    return null;
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return unit === 0
    ? `${value} ${units[unit]}`
    : `${value.toFixed(1)} ${units[unit]}`;
}

function formatDuration(ms: number | null | undefined): string | null {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0)
    return null;
  return ms < 1000
    ? `${ms} ms`
    : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
}

export function mediaMetaLabels(a: RunArtifactItem): string[] {
  return [
    mediaTypeLabel(a.media_type),
    formatByteSize(a.byte_size),
    formatDuration(a.duration_ms),
  ].filter((v): v is string => v !== null && v !== "");
}

export function artifactProvenanceLabel(a: RunArtifactItem): string {
  if (typeof a.step_id === "string" && a.step_id.length > 0) {
    return typeof a.attempt === "number"
      ? `자동화 단계 · 시도 ${a.attempt}`
      : "자동화 단계";
  }
  return "실행 전체";
}

export function hasStepProvenance(
  a: RunArtifactItem,
): a is RunArtifactItem & { readonly step_id: string } {
  return typeof a.step_id === "string" && a.step_id.length > 0;
}

export function artifactSummary(items: readonly RunArtifactItem[]): {
  screenshots: number;
  videos: number;
  pending: number;
} {
  return items.reduce(
    (acc, item) => {
      const kind = mediaKind(item);
      if (isArtifactReadable(item)) {
        if (kind === "screenshot") acc.screenshots += 1;
        if (kind === "video") acc.videos += 1;
      }
      if (item.redaction_status === "pending") acc.pending += 1;
      return acc;
    },
    { screenshots: 0, videos: 0, pending: 0 },
  );
}

export function uniqueArtifactItems(
  items: readonly RunArtifactItem[],
): readonly RunArtifactItem[] {
  const seen = new Set<string>();
  const unique: RunArtifactItem[] = [];
  for (const item of items) {
    if (seen.has(item.artifact_id)) continue;
    seen.add(item.artifact_id);
    unique.push(item);
  }
  return unique;
}

export function mergeArtifactPages(
  firstPageItems: readonly RunArtifactItem[],
  extraItems: readonly RunArtifactItem[],
): readonly RunArtifactItem[] {
  return uniqueArtifactItems([...firstPageItems, ...extraItems]);
}

export function screenshotRequestLabel(
  value: ScenarioGenerationEvidence["screenshot"] | undefined,
): string {
  if (value === "each_step") return "매 단계";
  if (value === "failure") return "실패 시";
  return "요청 없음";
}

export function videoRequestLabel(
  value: ScenarioGenerationEvidence["video"] | undefined,
): string {
  if (value === "always") return "전체 실행";
  if (value === "failure") return "실패 시";
  return "요청 없음";
}
