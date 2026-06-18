import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { useApiClient } from "../api/context";
import { hashWith, mergeParams, useHashParam } from "../router";
import { ApiError } from "../api/types";
import { ArtifactMediaPreview } from "./ArtifactMediaPreview";
import { errorLabel } from "./badges";

// 산출물(artifact) ID 조회 — GET /v1/artifacts/{id}. 목록/생성 API가 v1 미노출이라 ID 직접 입력(운영자가 이벤트·로그·
// run_steps에서 얻은 artifact_id). redaction→RBAC 2단 게이트 + audit boundary는 백엔드가 강제: 미존재/미redacted/
// 타테넌트→404, 권한없음→403. 본문은 항상 redacted(at rest 마스킹) — 평문 없음. 조회는 read라 UI RBAC 게이팅 불요.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 단계 트레이스/산출물 목록의 artifact_id를 클릭하면 위 '산출물 조회'가 자동 입력·조회되도록 하는 트리거.
// 형제 드릴다운(run/wi/ht)과 동일하게 mergeParams 단일 진입점으로 해시의 artifact 파라미터에 전체 uuid를 실어
// 보존한다(run/status 등 기존 파라미터 유지 + navigate와 공유하는 중복-억제 가드 일관 적용). 표시는 8자리
// 축약이지만 핸들러는 전체 uuid 사용 — 운영자가 손으로 복붙하던 단계 제거.
export function ArtifactRef({ id }: { id: string }): JSX.Element {
  return (
    <button
      type="button"
      className="linklike"
      aria-label={`산출물 ${id} 조회`}
      title="클릭하면 위 '산출물 조회'에 입력됩니다"
      onClick={() => { mergeParams({ artifact: id }); }}
    >
      <code>{id.slice(0, 8)}</code>
    </button>
  );
}

function errorText(err: unknown): string {
  // web-고유 행동지향 분기 보존(계약 userMessage보다 맥락이 구체적): 미존재/미redaction·권한 안내.
  if (err instanceof ApiError) {
    if (err.code === "RESOURCE_NOT_FOUND") return "해당 산출물이 없거나 아직 준비(redaction)되지 않았습니다.";
    if (err.code === "SECRET_ACCESS_DENIED") return "이 산출물을 조회할 권한이 없습니다.";
  }
  return errorLabel(err);
}

function isPreviewableMedia(mediaType: string | null | undefined): boolean {
  return mediaType?.startsWith("image/") === true || mediaType?.startsWith("video/") === true;
}

export function ArtifactLookup(): JSX.Element {
  const api = useApiClient();
  const [input, setInput] = useState("");
  const [id, setId] = useState<string | null>(null);
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
    if (hashArtifact === null || !UUID_RE.test(hashArtifact)) return;
    setInput(hashArtifact);
    setId(hashArtifact);
    const el = sectionRef.current;
    if (el && typeof el.scrollIntoView === "function") {
      try { el.scrollIntoView({ block: "nearest" }); } catch { /* jsdom 등 미구현 환경 무시 */ }
    }
  }, [hashArtifact]);

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

  function download(): void {
    if (q.data === undefined) return;
    const blob = new Blob([q.data.content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `artifact-${q.data.artifact_id}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <section ref={sectionRef} className="panel" style={{ marginBottom: 16, padding: 16 }} aria-label="산출물 조회">
      <header style={{ marginBottom: 8 }}>
        <strong>산출물(artifact) 조회</strong>
        <span className="subtle" style={{ marginLeft: 8 }}>실행이 남긴 증빙을 ID로 조회 (본문은 마스킹·조회 감사 기록됨)</span>
      </header>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="artifact_id (uuid)"
          aria-label="artifact_id"
          style={{ fontFamily: "monospace", fontSize: 13, padding: 8, minWidth: 320, maxWidth: "100%" }}
        />
        <button className="btn primary" type="button" disabled={!valid || q.isFetching} onClick={() => commitArtifact(input.trim())}>
          {q.isFetching ? "조회 중…" : "조회"}
        </button>
        {input.trim() !== "" && !valid && <span className="subtle">uuid 형식의 artifact_id를 입력하세요.</span>}
      </div>

      {id !== null && (
        <div style={{ marginTop: 12 }}>
          {q.isLoading ? (
            <p className="subtle" role="status" style={{ margin: 0 }}>불러오는 중…</p>
          ) : q.isError ? (
            <p className="badge red" role="alert" style={{ display: "inline-block", margin: 0 }}>{errorText(q.error)}</p>
          ) : q.data !== undefined ? (
            <div style={{ display: "grid", gap: 8 }}>
              <dl style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "4px 16px", margin: 0 }}>
                <dt className="subtle">종류</dt>
                <dd style={{ margin: 0 }}>{q.data.type}</dd>
                <dt className="subtle">sha256</dt>
                <dd style={{ margin: 0 }}><code>{q.data.sha256}</code></dd>
                <dt className="subtle">redaction</dt>
                <dd style={{ margin: 0 }}><span className="badge muted">{q.data.redaction_status}</span></dd>
                <dt className="subtle">보존 만료</dt>
                <dd style={{ margin: 0 }}>{q.data.retention_until ?? "—"}</dd>
              </dl>
              {isPreviewableMedia(q.data.media_type) ? (
                <ArtifactMediaPreview artifactId={q.data.artifact_id} mediaType={q.data.media_type} filename={q.data.filename} />
              ) : (
                <>
                  <pre
                    className="mono"
                    style={{ background: "var(--surface-2)", border: "1px solid var(--line)", borderRadius: "var(--radius)", padding: 12, margin: 0, maxHeight: 320, overflow: "auto", whiteSpace: "pre-wrap", wordBreak: "break-word" }}
                  >
                    {q.data.content}
                  </pre>
                  <div>
                    <button className="btn" type="button" onClick={download}>다운로드</button>
                  </div>
                </>
              )}
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}
