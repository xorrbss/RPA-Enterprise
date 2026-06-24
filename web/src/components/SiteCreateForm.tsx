import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { useApiClient } from "../api/context";
import { useCan } from "../api/permissions";
import { errorLabel } from "./badges";
import { navigate } from "../router";

// 사이트 신규 등록(온보딩) 폼 — api-surface §7 POST /v1/sites. site.create 권한(operator+) 없으면 숨김(백엔드 최종 강제).
// url_pattern은 http(s) origin이어야 백엔드가 수락(런타임 resolveSiteProfileId가 URL.origin 매칭) — 1차 검증.
// 조용한 실패 금지: 중복 name·비-origin 등은 ApiError(IR_SCHEMA_INVALID) 코드로 표면화.
const RISKS = ["green", "amber", "red"] as const;
const RISK_LABELS: Record<(typeof RISKS)[number], string> = {
  green: "낮음",
  amber: "중간",
  red: "높음",
};
const FLAG_KEYS = [
  "no_next_page",
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

const FLAG_KEY_LABELS: Record<FlagRow["key"], string> = {
  no_next_page: "다음 페이지 없음",
  login_required: "로그인 필요 화면",
  blocked: "차단 화면",
  not_found: "페이지 없음",
  no_review_message_visible: "리뷰 없음 안내 표시",
  reviews_visible: "리뷰 목록 표시",
};

const FLAG_KIND_LABELS: Record<FlagRow["kind"], string> = {
  present: "화면에 있으면 참",
  absent: "화면에 없으면 참",
  min_count: "최소 개수 이상",
};

export interface CreatedSite {
  readonly site_profile_id: string;
  readonly name?: string;
  readonly url_pattern?: string;
  readonly risk?: string;
  readonly approved?: boolean;
  readonly default_browser_identity_id?: string | null;
  readonly default_network_policy_id?: string | null;
}

interface SiteCreateFormProps {
  readonly title?: string;
  readonly triggerLabel?: string;
  readonly initialUrl?: string;
  readonly openSignal?: number;
  readonly embedded?: boolean;
  readonly onCreated?: (site: CreatedSite) => void;
}

function isHttpUrl(s: string): boolean {
  try {
    const u = new URL(s.trim());
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function httpOrigin(value: string | undefined): string {
  if (value === undefined || value.trim() === "") return "";
  try {
    const u = new URL(value.trim());
    return u.protocol === "http:" || u.protocol === "https:" ? u.origin : "";
  } catch {
    return "";
  }
}

function createdSiteFromResponse(value: unknown): CreatedSite | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return typeof record.site_profile_id === "string" && record.site_profile_id.trim() !== ""
    ? {
        site_profile_id: record.site_profile_id,
        ...(typeof record.name === "string" ? { name: record.name } : {}),
        ...(typeof record.url_pattern === "string" ? { url_pattern: record.url_pattern } : {}),
        ...(typeof record.risk === "string" ? { risk: record.risk } : {}),
        ...(typeof record.approved === "boolean" ? { approved: record.approved } : {}),
        ...(typeof record.default_browser_identity_id === "string" || record.default_browser_identity_id === null
          ? { default_browser_identity_id: record.default_browser_identity_id }
          : {}),
        ...(typeof record.default_network_policy_id === "string" || record.default_network_policy_id === null
          ? { default_network_policy_id: record.default_network_policy_id }
          : {}),
      }
    : null;
}

export function SiteCreateForm({
  title = "사이트 등록",
  triggerLabel = "새 사이트",
  initialUrl,
  openSignal,
  embedded = false,
  onCreated,
}: SiteCreateFormProps = {}): JSX.Element | null {
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
      const createdSite = createdSiteFromResponse(created);
      if (createdSite !== null) onCreated?.(createdSite);
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
      if (!embedded) {
        navigate("scenarioStudio", {
          site: created.site_profile_id,
          start_url: created.url_pattern,
          browser_identity: created.default_browser_identity_id,
          network_policy: created.default_network_policy_id,
        });
      }
    },
    onError: (e) => setMsg({ tone: "red", text: errorLabel(e) }),
  });

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

  useEffect(() => {
    if (openSignal === undefined || openSignal <= 0) return;
    setMsg(null);
    setOpen(true);
    const seeded = httpOrigin(initialUrl);
    if (seeded !== "") {
      setUrl((current) => (current.trim() === "" ? seeded : current));
    }
  }, [initialUrl, openSignal]);

  if (!can("site.create")) return null;

  const toggleOpen = () => {
    setMsg(null);
    setOpen((current) => {
      const next = !current;
      if (next && url.trim() === "") {
        const seeded = httpOrigin(initialUrl);
        if (seeded !== "") setUrl(seeded);
      }
      return next;
    });
  };

  const invalid = name.trim() === "" || !isHttpUrl(url) || (loginUrl.trim() !== "" && !isHttpUrl(loginUrl));
  return (
    <section className={embedded ? "site-create-inline" : "panel"} style={{ padding: embedded ? undefined : 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
        <strong>{title}</strong>
        <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
          {msg !== null && <span className={`badge ${msg.tone}`}>{msg.text}</span>}
          <button className="btn" type="button" onClick={toggleOpen}>
            {open ? "닫기" : triggerLabel}
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
            <span className="subtle">사이트 주소</span>
            <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="예: https://login.office.hiworks.com" style={{ fontFamily: "monospace" }} />
          </label>
          <label style={{ display: "grid", gap: 4 }}>
            <span className="subtle">사이트 위험도</span>
            <select value={risk} onChange={(e) => setRisk(e.target.value as (typeof RISKS)[number])}>
              {RISKS.map((r) => (
                <option key={r} value={r}>{RISK_LABELS[r]}</option>
              ))}
            </select>
            <span className="subtle">높음은 등록 후 승인되어야 실행할 수 있습니다.</span>
          </label>
          <label style={{ display: "grid", gap: 4 }}>
            <span className="subtle">로그인 주소 (선택)</span>
            <input
              value={loginUrl}
              onChange={(e) => setLoginUrl(e.target.value)}
              placeholder="예: https://login.office.hiworks.com"
              style={{ fontFamily: "monospace" }}
            />
          </label>
          <label style={{ display: "grid", gap: 4 }}>
            <span className="subtle">로그인 완료 확인 조건 (선택)</span>
            <input
              value={authenticatedSelector}
              onChange={(e) => setAuthenticatedSelector(e.target.value)}
              placeholder="예: 사용자 메뉴"
              style={{ fontFamily: "monospace" }}
            />
          </label>
          <label style={{ display: "grid", gap: 4 }}>
            <span className="subtle">리뷰 목록 확인 조건 (선택)</span>
            <input
              value={reviewsSelector}
              onChange={(e) => setReviewsSelector(e.target.value)}
              placeholder="예: 리뷰 카드"
              style={{ fontFamily: "monospace" }}
            />
          </label>
          <details style={{ fontSize: 12 }}>
            <summary className="subtle">판정 기준 보기</summary>
            <code>화면 판정 조건 · 리뷰 목록 표시 · 최소 개수</code>
          </details>
          <div className={embedded ? "site-create-flags" : "panel"} style={{ padding: 10, display: "grid", gap: 8 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
              <span className="subtle">추가 화면 상태 판정</span>
              <button className="btn" type="button" onClick={addFlagRow}>+ 판정</button>
            </div>
            {flagRows.length === 0 ? (
              <span className="subtle">마지막 페이지, 로그인 필요, 차단 화면 같은 실행 전/중 판정을 화면에서 확인할 조건으로 추가할 수 있습니다.</span>
            ) : (
              flagRows.map((row) => (
                <div key={row.id} style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 6, alignItems: "center" }}>
                  <select aria-label="판정 항목" value={row.key} onChange={(e) => updateFlagRow(row.id, { key: e.target.value as FlagRow["key"] })}>
                    {FLAG_KEYS.map((key) => (
                      <option key={key} value={key}>{FLAG_KEY_LABELS[key]}</option>
                    ))}
                  </select>
                  <select aria-label="판정 방식" value={row.kind} onChange={(e) => updateFlagRow(row.id, { kind: e.target.value as FlagRow["kind"] })}>
                    {FLAG_KINDS.map((kind) => (
                      <option key={kind} value={kind}>{FLAG_KIND_LABELS[kind]}</option>
                    ))}
                  </select>
                  <input
                    aria-label="화면 확인 조건"
                    value={row.selector}
                    onChange={(e) => updateFlagRow(row.id, { selector: e.target.value })}
                    placeholder="예: 다음 버튼 비활성"
                    style={{ fontFamily: "monospace", minWidth: 0 }}
                  />
                  <input
                    aria-label="최소 개수"
                    type="number"
                    min={1}
                    value={row.n}
                    disabled={row.kind !== "min_count"}
                    onChange={(e) => updateFlagRow(row.id, { n: Number(e.target.value) })}
                  />
                  <button className="btn" type="button" onClick={() => removeFlagRow(row.id)}>삭제</button>
                  <details style={{ gridColumn: "1 / -1", fontSize: 12 }}>
                    <summary className="subtle">판정 기준 보기</summary>
                    <code>{`화면 판정 조건 · ${FLAG_KEY_LABELS[row.key]} · ${FLAG_KIND_LABELS[row.kind]}${row.kind === "min_count" ? " · 최소 개수" : ""}`}</code>
                  </details>
                </div>
              ))
            )}
          </div>
          <div>
            <button className="btn primary" type="button" disabled={invalid || create.isPending} onClick={() => create.mutate()}>
              {create.isPending ? "등록 중…" : "등록"}
            </button>
            {invalid && <span className="subtle" style={{ marginLeft: 8 }}>사이트 이름과 http(s) 사이트 주소를 입력하세요. 로그인 주소도 http(s)여야 합니다.</span>}
          </div>
        </div>
      )}
    </section>
  );
}
