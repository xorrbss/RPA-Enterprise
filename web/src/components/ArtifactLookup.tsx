import { useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { useApiClient } from "../api/context";
import { ApiError } from "../api/types";

// 산출물(artifact) ID 조회 — GET /v1/artifacts/{id}. 목록/생성 API가 v1 미노출이라 ID 직접 입력(운영자가 이벤트·로그·
// run_steps에서 얻은 artifact_id). redaction→RBAC 2단 게이트 + audit boundary는 백엔드가 강제: 미존재/미redacted/
// 타테넌트→404, 권한없음→403. 본문은 항상 redacted(at rest 마스킹) — 평문 없음. 조회는 read라 UI RBAC 게이팅 불요.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function errorText(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === "RESOURCE_NOT_FOUND") return "해당 산출물이 없거나 아직 준비(redaction)되지 않았습니다.";
    if (err.code === "SECRET_ACCESS_DENIED") return "이 산출물을 조회할 권한이 없습니다.";
    return `${err.code}${err.httpStatus ? ` (${err.httpStatus})` : ""}`;
  }
  return "조회에 실패했습니다.";
}

export function ArtifactLookup(): JSX.Element {
  const api = useApiClient();
  const [input, setInput] = useState("");
  const [id, setId] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ["artifact", id],
    queryFn: () => api.getArtifact(id as string),
    enabled: id !== null,
    retry: false,
  });

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
    <section className="panel" style={{ marginBottom: 16, padding: 16 }} aria-label="산출물 조회">
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
        <button className="btn primary" type="button" disabled={!valid || q.isFetching} onClick={() => setId(input.trim())}>
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
              <pre
                className="mono"
                style={{ background: "var(--surface-2)", border: "1px solid var(--line)", borderRadius: "var(--radius)", padding: 12, margin: 0, maxHeight: 320, overflow: "auto", whiteSpace: "pre-wrap", wordBreak: "break-word" }}
              >
                {q.data.content}
              </pre>
              <div>
                <button className="btn" type="button" onClick={download}>다운로드</button>
              </div>
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}
