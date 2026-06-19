import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { useApiClient } from "../api/context";
import { useCan } from "../api/permissions";
import { errorLabel } from "./badges";
import { navigate } from "../router";

// 사이트 신규 등록(온보딩) 폼 — api-surface §7 POST /v1/sites. site.create 권한(operator+) 없으면 숨김(백엔드 최종 강제).
// url_pattern은 http(s) origin이어야 백엔드가 수락(런타임 resolveSiteProfileId가 URL.origin 매칭) — 1차 검증.
// 조용한 실패 금지: 중복 name·비-origin 등은 ApiError(IR_SCHEMA_INVALID) 코드로 표면화.
const RISKS = ["green", "amber", "red"] as const;
const FLAG_KEYS = [
  "no_next_page",
  "cursor_reached",
  "login_required",
  "blocked",
  "not_found",
  "no_review_message_visible",
  "reviews_visible",
] as const;
const FLAG_KINDS = ["present", "absent", "min_count"] as const;

type FlagRow = {
  id: number;
  key: (typeof FLAG_KEYS)[number];
  kind: (typeof FLAG_KINDS)[number];
  selector: string;
  n: number;
};

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
  const [loginUrl, setLoginUrl] = useState("");
  const [authenticatedSelector, setAuthenticatedSelector] = useState("");
  const [reviewsSelector, setReviewsSelector] = useState("");
  const [flagRows, setFlagRows] = useState<FlagRow[]>([]);
  const [msg, setMsg] = useState<{ tone: "green" | "red"; text: string } | null>(null);

  function pageStateSelectors(): unknown | undefined {
    const login = loginUrl.trim();
    const auth = authenticatedSelector.trim();
    const reviews = reviewsSelector.trim();
    const flags: Record<string, unknown> = {};
    if (reviews !== "") flags.reviews_visible = { kind: "min_count", selector: reviews, n: 1 };
    for (const row of flagRows) {
      const selector = row.selector.trim();
      if (selector === "") continue;
      flags[row.key] = row.kind === "min_count"
        ? { kind: row.kind, selector, n: Math.max(1, Math.floor(row.n)) }
        : { kind: row.kind, selector };
    }
    if (login === "" && auth === "" && Object.keys(flags).length === 0) return undefined;
    return {
      ...(login !== "" ? { loginUrl: login } : {}),
      ...(auth !== "" ? { authenticatedWhen: { selector: auth } } : {}),
      flags,
    };
  }

  const create = useMutation({
    mutationFn: () => {
      const selectors = pageStateSelectors();
      return api.createSite(
        { name: name.trim(), url_pattern: url.trim(), risk, ...(selectors !== undefined ? { page_state_selectors: selectors } : {}) },
        crypto.randomUUID(),
      );
    },
    onSuccess: (created) => {
      setMsg({ tone: "green", text: "사이트 등록됨" });
      setName("");
      setUrl("");
      setRisk("green");
      setLoginUrl("");
      setAuthenticatedSelector("");
      setReviewsSelector("");
      setFlagRows([]);
      setOpen(false);
      void qc.invalidateQueries({ queryKey: ["sites"] });
      navigate("scenarioStudio", {
        site: created.site_profile_id,
        start_url: created.url_pattern,
        browser_identity: created.default_browser_identity_id,
        network_policy: created.default_network_policy_id,
      });
    },
    onError: (e) => setMsg({ tone: "red", text: errorLabel(e) }),
  });

  if (!can("site.create")) return null;

  const addFlagRow = () => {
    setFlagRows((rows) => [
      ...rows,
      { id: Date.now(), key: "no_next_page", kind: "present", selector: "", n: 1 },
    ]);
  };
  const updateFlagRow = (id: number, patch: Partial<FlagRow>) => {
    setFlagRows((rows) => rows.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  };
  const removeFlagRow = (id: number) => {
    setFlagRows((rows) => rows.filter((row) => row.id !== id));
  };

  const invalid = name.trim() === "" || !isHttpUrl(url) || (loginUrl.trim() !== "" && !isHttpUrl(loginUrl));
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
          <label style={{ display: "grid", gap: 4 }}>
            <span className="subtle">로그인 URL (선택)</span>
            <input
              value={loginUrl}
              onChange={(e) => setLoginUrl(e.target.value)}
              placeholder="예: https://login.office.hiworks.com"
              style={{ fontFamily: "monospace" }}
            />
          </label>
          <label style={{ display: "grid", gap: 4 }}>
            <span className="subtle">로그인 확인 selector (선택)</span>
            <input
              value={authenticatedSelector}
              onChange={(e) => setAuthenticatedSelector(e.target.value)}
              placeholder="예: .user-menu"
              style={{ fontFamily: "monospace" }}
            />
          </label>
          <label style={{ display: "grid", gap: 4 }}>
            <span className="subtle">reviews_visible selector (선택)</span>
            <input
              value={reviewsSelector}
              onChange={(e) => setReviewsSelector(e.target.value)}
              placeholder="예: .review-item"
              style={{ fontFamily: "monospace" }}
            />
          </label>
          <div className="panel" style={{ padding: 10, display: "grid", gap: 8 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
              <span className="subtle">추가 page-state flags</span>
              <button className="btn" type="button" onClick={addFlagRow}>+ flag</button>
            </div>
            {flagRows.length === 0 ? (
              <span className="subtle">마지막 페이지, 로그인 필요, 차단 화면 같은 실행 전/중 판정을 selector로 추가할 수 있습니다.</span>
            ) : (
              flagRows.map((row) => (
                <div key={row.id} style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 6, alignItems: "center" }}>
                  <select value={row.key} onChange={(e) => updateFlagRow(row.id, { key: e.target.value as FlagRow["key"] })}>
                    {FLAG_KEYS.map((key) => (
                      <option key={key} value={key}>{key}</option>
                    ))}
                  </select>
                  <select value={row.kind} onChange={(e) => updateFlagRow(row.id, { kind: e.target.value as FlagRow["kind"] })}>
                    {FLAG_KINDS.map((kind) => (
                      <option key={kind} value={kind}>{kind}</option>
                    ))}
                  </select>
                  <input
                    value={row.selector}
                    onChange={(e) => updateFlagRow(row.id, { selector: e.target.value })}
                    placeholder="예: .pagination .disabled-next"
                    style={{ fontFamily: "monospace", minWidth: 0 }}
                  />
                  <input
                    type="number"
                    min={1}
                    value={row.n}
                    disabled={row.kind !== "min_count"}
                    onChange={(e) => updateFlagRow(row.id, { n: Number(e.target.value) })}
                  />
                  <button className="btn" type="button" onClick={() => removeFlagRow(row.id)}>삭제</button>
                </div>
              ))
            )}
          </div>
          <div>
            <button className="btn primary" type="button" disabled={invalid || create.isPending} onClick={() => create.mutate()}>
              {create.isPending ? "등록 중…" : "등록"}
            </button>
            {invalid && <span className="subtle" style={{ marginLeft: 8 }}>이름과 http(s) URL을 입력하세요. 로그인 URL도 http(s)여야 합니다.</span>}
          </div>
        </div>
      )}
    </section>
  );
}
