import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { useApiClient } from "../api/context";
import { useCan } from "../api/permissions";
import { errorLabel } from "./badges";

// 사이트 신규 등록(온보딩) 폼 — api-surface §7 POST /v1/sites. site.create 권한(operator+) 없으면 숨김(백엔드 최종 강제).
// url_pattern은 http(s) origin이어야 백엔드가 수락(런타임 resolveSiteProfileId가 URL.origin 매칭) — 1차 검증.
// 조용한 실패 금지: 중복 name·비-origin 등은 ApiError(IR_SCHEMA_INVALID) 코드로 표면화.
const RISKS = ["green", "amber", "red"] as const;

function isHttpUrl(s: string): boolean {
  try {
    const u = new URL(s.trim());
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

export function SiteCreateForm(): JSX.Element | null {
  const api = useApiClient();
  const can = useCan();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [risk, setRisk] = useState<(typeof RISKS)[number]>("green");
  const [msg, setMsg] = useState<{ tone: "green" | "red"; text: string } | null>(null);

  const create = useMutation({
    mutationFn: () => api.createSite({ name: name.trim(), url_pattern: url.trim(), risk }, crypto.randomUUID()),
    onSuccess: () => {
      setMsg({ tone: "green", text: "사이트 등록됨" });
      setName("");
      setUrl("");
      setRisk("green");
      setOpen(false);
      void qc.invalidateQueries({ queryKey: ["sites"] });
    },
    onError: (e) => setMsg({ tone: "red", text: errorLabel(e) }),
  });

  if (!can("site.create")) return null;

  const invalid = name.trim() === "" || !isHttpUrl(url);
  return (
    <section className="panel" style={{ padding: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
        <strong>사이트 등록</strong>
        <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
          {msg !== null && <span className={`badge ${msg.tone}`}>{msg.text}</span>}
          <button className="btn" type="button" onClick={() => { setMsg(null); setOpen((v) => !v); }}>
            {open ? "닫기" : "새 사이트"}
          </button>
        </span>
      </div>
      {open && (
        <div style={{ display: "grid", gap: 8, marginTop: 10, maxWidth: 520 }}>
          <label style={{ display: "grid", gap: 4 }}>
            <span className="subtle">이름</span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="예: 하이웍스" />
          </label>
          <label style={{ display: "grid", gap: 4 }}>
            <span className="subtle">URL 패턴 (http/https origin)</span>
            <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="예: https://login.office.hiworks.com" style={{ fontFamily: "monospace" }} />
          </label>
          <label style={{ display: "grid", gap: 4 }}>
            <span className="subtle">위험도 (red는 등록 후 승인 필요)</span>
            <select value={risk} onChange={(e) => setRisk(e.target.value as (typeof RISKS)[number])}>
              {RISKS.map((r) => (
                <option key={r} value={r}>{r}</option>
              ))}
            </select>
          </label>
          <div>
            <button className="btn primary" type="button" disabled={invalid || create.isPending} onClick={() => create.mutate()}>
              {create.isPending ? "등록 중…" : "등록"}
            </button>
            {invalid && <span className="subtle" style={{ marginLeft: 8 }}>이름과 http(s) URL을 입력하세요.</span>}
          </div>
        </div>
      )}
    </section>
  );
}
