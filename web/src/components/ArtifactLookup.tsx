import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { useApiClient } from "../api/context";
import { hashWith, mergeParams, useHashParam } from "../router";
import { ApiError, type ArtifactDetail } from "../api/types";
import { ArtifactMediaPreview } from "./ArtifactMediaPreview";
import { errorLabel } from "./badges";

// 산출물(artifact) ID 조회 — GET /v1/artifacts/{id}. 목록/생성 API가 v1 미노출이라 ID 직접 입력(운영자가 이벤트·로그·
// run_steps에서 얻은 artifact_id). redaction→RBAC 2단 게이트 + audit boundary는 백엔드가 강제: 미존재/미redacted/
// 타테넌트→404, 권한없음→403. 본문은 항상 redacted(at rest 마스킹) — 평문 없음. 조회는 read라 UI RBAC 게이팅 불요.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 단계 트레이스/산출물 목록의 artifact_id를 클릭하면 위 '산출물 조회'가 자동 입력·조회되도록 하는 트리거.
// 형제 드릴다운(run/wi/ht)과 동일하게 mergeParams 단일 진입점으로 해시의 artifact 파라미터에 전체 uuid를 실어
// 보존한다(run/status 등 기존 파라미터 유지 + navigate와 공유하는 중복-억제 가드 일관 적용). 표시는 8자리
// 축약이지만 핸들러는 전체 uuid 사용 — 운영자가 손으로 복붙하던 단계 제거.
export function ArtifactRef({ id }: { id: string }): JSX.Element {
  const short = id.slice(0, 8);
  return (
    <button
      type="button"
      className="linklike"
      aria-label={`증빙 ${id} 조회`}
      title={`전체 증빙 번호: ${id}`}
      onClick={() => {
        mergeParams({ artifact: id });
      }}
    >
      <span>증빙 {short}</span>
    </button>
  );
}

function errorText(err: unknown): string {
  // web-고유 행동지향 분기 보존(계약 userMessage보다 맥락이 구체적): 미존재/미redaction·권한 안내.
  if (err instanceof ApiError) {
    if (err.code === "RESOURCE_NOT_FOUND")
      return "해당 증빙이 없거나 아직 조회 준비가 끝나지 않았습니다.";
    if (err.code === "SECRET_ACCESS_DENIED")
      return "이 증빙을 조회할 권한이 없습니다.";
  }
  return errorLabel(err);
}

function previewMediaType(artifact: {
  type: string;
  media_type?: string | null;
  filename?: string | null;
}): string | null {
  if (
    artifact.media_type?.startsWith("image/") === true ||
    artifact.media_type?.startsWith("video/") === true
  ) {
    return artifact.media_type;
  }
  const hints = `${artifact.type} ${artifact.filename ?? ""}`.toLowerCase();
  if (hints.includes("video")) return "video/webm";
  if (
    hints.includes("screenshot") ||
    hints.includes("screen_capture") ||
    hints.includes("image_capture") ||
    /\.(png|jpe?g|webp)\b/.test(hints)
  ) {
    return "image/png";
  }
  return null;
}

function artifactTypeLabel(
  type: string,
  mediaType?: string | null,
  filename?: string | null,
): string {
  const lower = `${type} ${mediaType ?? ""} ${filename ?? ""}`.toLowerCase();
  if (type === "extract_result_json") return "추출 결과";
  if (type === "scenario_generation_planner_output") return "생성 진단";
  if (type === "scenario_generation_validation_report") return "검증 보고서";
  if (
    lower.includes("screen_capture") ||
    lower.includes("screenshot") ||
    lower.includes("image")
  )
    return "화면 캡처";
  if (lower.includes("video")) return "실행 영상";
  if (mediaType?.startsWith("application/json") === true) return "구조화 결과";
  if (mediaType?.startsWith("text/") === true) return "텍스트 증빙";
  return "증빙";
}

function redactionLabel(status: string): string {
  if (status === "redacted" || status === "not_required") return "조회 가능";
  if (status === "pending") return "처리 중";
  if (status === "failed") return "처리 실패";
  return "상태 확인 필요";
}

function byteSizeLabel(size: number | null | undefined): string | null {
  if (size === null || size === undefined) return null;
  if (size >= 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  if (size >= 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${size} B`;
}

function durationLabel(ms: number | null | undefined): string | null {
  if (ms === null || ms === undefined) return null;
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)} s`;
  return `${ms} ms`;
}

function contentSummary(content: string): string[] {
  const trimmed = content.trim();
  if (trimmed === "") return ["결과 없음"];
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
    ) {
      const obj = parsed as Record<string, unknown>;
      const rows = Array.isArray(obj.rows) ? obj.rows : null;
      const keys = Object.keys(obj);
      const lines = [
        "구조화 결과",
        `포함 항목 ${keys.length}개`,
      ];
      if (rows !== null) {
        lines.push(`자료 행 ${rows.length}건`);
        const first = rows.find(
          (row): row is Record<string, unknown> =>
            row !== null && typeof row === "object" && !Array.isArray(row),
        );
        if (first !== undefined)
          lines.push(`첫 행 항목 ${Object.keys(first).length}개`);
      }
      return lines;
    }
    if (Array.isArray(parsed)) return [`목록 결과`, `${parsed.length}건`];
    return ["결과값"];
  } catch {
    const lineCount = trimmed.split(/\r?\n/).length;
    return [
      "텍스트 결과",
      `${trimmed.length.toLocaleString("ko-KR")}자`,
      `${lineCount.toLocaleString("ko-KR")}줄`,
    ];
  }
}

function ArtifactLookupResult({
  artifact,
  onDownload,
  downloadError,
  isDownloading,
}: {
  artifact: ArtifactDetail;
  onDownload: () => void;
  downloadError: boolean;
  isDownloading: boolean;
}): JSX.Element {
  const mediaType = previewMediaType(artifact);
  const meta = [
    artifact.filename ?? null,
    byteSizeLabel(artifact.byte_size),
    durationLabel(artifact.duration_ms),
  ].filter((item): item is string => item !== null);
  const summary = mediaType === null ? contentSummary(artifact.content) : [];
  return (
    <div style={{ display: "grid", gap: 8 }}>
      {mediaType !== null && (
        <ArtifactMediaPreview
          artifactId={artifact.artifact_id}
          mediaType={mediaType}
          filename={artifact.filename}
        />
      )}
      <dl
        style={{
          display: "grid",
          gridTemplateColumns: "auto 1fr",
          gap: "4px 16px",
          margin: 0,
        }}
      >
        <dt className="subtle">종류</dt>
        <dd style={{ margin: 0 }}>
          <strong>
            {artifactTypeLabel(
              artifact.type,
              artifact.media_type,
              artifact.filename,
            )}
          </strong>
        </dd>
        {meta.length > 0 && (
          <>
            <dt className="subtle">파일 정보</dt>
            <dd style={{ margin: 0 }}>{meta.join(" · ")}</dd>
          </>
        )}
        <dt className="subtle">보호 처리 상태</dt>
        <dd style={{ margin: 0 }}>
          <span className="badge muted">
            {redactionLabel(artifact.redaction_status)}
          </span>
        </dd>
        <dt className="subtle">보존 만료</dt>
        <dd style={{ margin: 0 }}>{artifact.retention_until ?? "—"}</dd>
      </dl>
      {mediaType === null && (
        <div className="artifact-json-summary" aria-label="결과 요약">
          {summary.map((line) => (
            <span key={line}>
              <strong>{line}</strong>
            </span>
          ))}
        </div>
      )}
      <details className="artifact-technical-details">
        <summary>감사 세부 정보 보기</summary>
        <dl className="artifact-technical-grid">
          <dt className="subtle">증빙 참조</dt>
          <dd style={{ margin: 0 }}>
            <ArtifactRef id={artifact.artifact_id} />
          </dd>
          <dt className="subtle">저장 분류</dt>
          <dd style={{ margin: 0 }}>
            <code>{artifact.type}</code>
          </dd>
          <dt className="subtle">무결성 해시</dt>
          <dd style={{ margin: 0 }}>
            <code>{artifact.sha256}</code>
          </dd>
          <dt className="subtle">보호 처리 원값</dt>
          <dd style={{ margin: 0 }}>
            <code>{artifact.redaction_status}</code>
          </dd>
        </dl>
        {mediaType === null && (
          <div className="artifact-source-download">
            <p className="subtle" style={{ margin: 0 }}>
              원본 본문은 화면에 직접 펼치지 않습니다. 감사나 재처리에 필요한 경우 권한 검사를 거쳐 파일로 내려받으세요.
            </p>
            <div style={{ marginTop: 8 }}>
              <button
                className="btn"
                type="button"
                onClick={onDownload}
                disabled={isDownloading}
              >
                {isDownloading ? "다운로드 준비 중" : "원본 파일 다운로드"}
              </button>
              {downloadError && (
                <span className="badge red" role="alert" style={{ marginLeft: 8 }}>
                  다운로드 실패
                </span>
              )}
            </div>
          </div>
        )}
      </details>
    </div>
  );
}

export function ArtifactLookup({
  consumeHashParam = true,
  embedded = false,
}: { consumeHashParam?: boolean; embedded?: boolean } = {}): JSX.Element {
  const api = useApiClient();
  const [input, setInput] = useState("");
  const [id, setId] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);
  const sectionRef = useRef<HTMLElement>(null);
  const q = useQuery({
    queryKey: ["artifact", id],
    queryFn: () => api.getArtifact(id as string),
    enabled: id !== null,
    retry: false,
  });

  // 해시의 artifact 파라미터(ArtifactRef 클릭 → `#runTrace?run=...&artifact=<uuid>`)로 자동 입력·조회.
  const hashArtifact = useHashParam("artifact");
  useEffect(() => {
    if (!consumeHashParam) return;
    if (hashArtifact === null || !UUID_RE.test(hashArtifact)) return;
    setInput(hashArtifact);
    setId(hashArtifact);
    const el = sectionRef.current;
    if (el && typeof el.scrollIntoView === "function") {
      try {
        el.scrollIntoView({ block: "nearest" });
      } catch {
        /* jsdom 등 미구현 환경 무시 */
      }
    }
  }, [consumeHashParam, hashArtifact]);

  // 수동 조회도 해시를 갱신해 단일 진실원천 유지(ArtifactRef와 일관, run/status 등 기존 파라미터는 hashWith로 보존).
  // 해시가 이미 동일하면 hashchange가 안 일어나므로 직접 커밋한다(조용한 무반응 금지) — 'ref Y → 수동 Z → ref Y 재클릭'에서도 Y로 복귀.
  function commitArtifact(uuid: string): void {
    const base = hashWith({ artifact: uuid });
    if (location.hash === base) {
      setInput(uuid);
      setId(uuid);
    } else {
      location.hash = base;
    }
  }

  const valid = UUID_RE.test(input.trim());

  async function download(): Promise<void> {
    if (q.data === undefined) return;
    setDownloadError(false);
    setIsDownloading(true);
    let url: string | null = null;
    try {
      const blob = await api.getArtifactBlob(q.data.artifact_id);
      url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = q.data.filename ?? `evidence-${q.data.artifact_id}.txt`;
      a.click();
    } catch {
      setDownloadError(true);
    } finally {
      if (url !== null) URL.revokeObjectURL(url);
      setIsDownloading(false);
    }
  }

  return (
    <section
      ref={sectionRef}
      className={
        embedded
          ? "artifact-lookup artifact-lookup-embedded"
          : "panel artifact-lookup"
      }
      style={{ marginBottom: embedded ? 0 : 16, padding: embedded ? 12 : 16 }}
      aria-label="증빙 조회"
    >
      <header style={{ marginBottom: 8 }}>
        <strong>증빙 조회</strong>
        <span className="subtle" style={{ marginLeft: 8 }}>
          실행·검토 증빙을 증빙 번호로 조회합니다. 결과는 권한과 처리 상태를
          통과한 경우에만 표시됩니다.
        </span>
      </header>
      <div
        style={{
          display: "flex",
          gap: 8,
          alignItems: "center",
          flexWrap: "wrap",
        }}
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="증빙 목록에서 복사한 번호"
          aria-label="증빙 번호"
          style={{
            fontFamily: "monospace",
            fontSize: 13,
            padding: 8,
            minWidth: 320,
            maxWidth: "100%",
          }}
        />
        <button
          className="btn primary"
          type="button"
          disabled={!valid || q.isFetching}
          onClick={() => commitArtifact(input.trim())}
        >
          {q.isFetching ? "조회 중…" : "조회"}
        </button>
        {input.trim() !== "" && !valid && (
          <span className="subtle">증빙 번호 형식을 확인하세요.</span>
        )}
      </div>

      {id !== null && (
        <div style={{ marginTop: 12 }}>
          {q.isLoading ? (
            <p className="subtle" role="status" style={{ margin: 0 }}>
              불러오는 중…
            </p>
          ) : q.isError ? (
            <p
              className="badge red"
              role="alert"
              style={{ display: "inline-block", margin: 0 }}
            >
              {errorText(q.error)}
            </p>
          ) : q.data !== undefined ? (
            <ArtifactLookupResult
              artifact={q.data}
              onDownload={() => {
                void download();
              }}
              downloadError={downloadError}
              isDownloading={isDownloading}
            />
          ) : null}
        </div>
      )}
    </section>
  );
}
