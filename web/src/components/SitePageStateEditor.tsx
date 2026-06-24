import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { useApiClient } from "../api/context";
import { useCan } from "../api/permissions";
import type { SiteItem } from "../api/types";
import { errorLabel } from "./badges";

const FLAG_KEYS = [
  "no_next_page",
  "login_required",
  "blocked",
  "not_found",
  "no_review_message_visible",
  "reviews_visible",
] as const;
const FLAG_KINDS = ["present", "absent", "min_count"] as const;

type FlagKey = (typeof FLAG_KEYS)[number];
type FlagKind = (typeof FLAG_KINDS)[number];

const FLAG_KEY_LABELS: Record<FlagKey, string> = {
  no_next_page: "다음 페이지 없음",
  login_required: "로그인 필요 화면",
  blocked: "차단 화면",
  not_found: "페이지 없음",
  no_review_message_visible: "리뷰 없음 안내 표시",
  reviews_visible: "리뷰 목록 표시",
};

const FLAG_KIND_LABELS: Record<FlagKind, string> = {
  present: "화면에 있으면 참",
  absent: "화면에 없으면 참",
  min_count: "최소 개수 이상",
};

interface FlagRow {
  readonly id: number;
  readonly key: FlagKey;
  readonly kind: FlagKind;
  readonly selector: string;
  readonly n: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function rowsFromSelectors(value: unknown): { loginUrl: string; authenticatedSelector: string; rows: FlagRow[] } {
  if (!isRecord(value)) return { loginUrl: "", authenticatedSelector: "", rows: [] };
  const loginUrl = typeof value.loginUrl === "string" ? value.loginUrl : "";
  const authenticatedWhen = isRecord(value.authenticatedWhen) && typeof value.authenticatedWhen.selector === "string"
    ? value.authenticatedWhen.selector
    : "";
  const flags = isRecord(value.flags) ? value.flags : {};
  const rows: FlagRow[] = [];
  let index = 1;
  for (const key of FLAG_KEYS) {
    const raw = flags[key];
    if (!isRecord(raw)) continue;
    const kind = raw.kind === "absent" || raw.kind === "min_count" ? raw.kind : "present";
    const selector = typeof raw.selector === "string" ? raw.selector : "";
    const n = typeof raw.n === "number" && Number.isFinite(raw.n) ? Math.max(1, Math.floor(raw.n)) : 1;
    rows.push({ id: Date.now() + index, key, kind, selector, n });
    index += 1;
  }
  return { loginUrl, authenticatedSelector: authenticatedWhen, rows };
}

export function SitePageStateEditor({ site }: { site: SiteItem }): JSX.Element | null {
  const api = useApiClient();
  const can = useCan();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [loginUrl, setLoginUrl] = useState("");
  const [authenticatedSelector, setAuthenticatedSelector] = useState("");
  const [rows, setRows] = useState<FlagRow[]>([]);
  const [msg, setMsg] = useState<{ tone: "green" | "red"; text: string } | null>(null);

  const detail = useQuery({
    queryKey: ["site", site.site_profile_id],
    queryFn: () => api.getSite(site.site_profile_id),
    enabled: open,
  });

  useEffect(() => {
    if (!open || detail.data === undefined) return;
    const parsed = rowsFromSelectors(detail.data.page_state_selectors);
    setLoginUrl(parsed.loginUrl);
    setAuthenticatedSelector(parsed.authenticatedSelector);
    setRows(parsed.rows);
  }, [detail.data, open]);

  const save = useMutation({
    mutationFn: (selectors: unknown | null) => api.updateSitePageState(site.site_profile_id, selectors, crypto.randomUUID()),
    onSuccess: () => {
      setMsg({ tone: "green", text: "판정 설정 저장됨" });
      void qc.invalidateQueries({ queryKey: ["sites"] });
      void qc.invalidateQueries({ queryKey: ["site", site.site_profile_id] });
    },
    onError: (error) => setMsg({ tone: "red", text: errorLabel(error) }),
  });

  if (!can("site.update")) return null;
  const summary = site.page_state_summary;
  const summaryText = summary?.configured === true
    ? `상태 판정 ${summary.flag_count}개`
    : "판정 미설정";
  const invalid = loginUrl.trim() !== "" && !isHttpUrl(loginUrl);
  const canSave = !invalid && !save.isPending;

  function addRow(): void {
    setRows((current) => [
      ...current,
      { id: Date.now(), key: "no_next_page", kind: "present", selector: "", n: 1 },
    ]);
  }

  function updateRow(id: number, patch: Partial<FlagRow>): void {
    setRows((current) => current.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  }

  function removeRow(id: number): void {
    setRows((current) => current.filter((row) => row.id !== id));
  }

  function buildSelectors(): unknown {
    const flags: Record<string, unknown> = {};
    for (const row of rows) {
      const selector = row.selector.trim();
      if (selector === "") continue;
      flags[row.key] = row.kind === "min_count"
        ? { kind: row.kind, selector, n: Math.max(1, Math.floor(row.n)) }
        : { kind: row.kind, selector };
    }
    return {
      ...(loginUrl.trim() !== "" ? { loginUrl: loginUrl.trim() } : {}),
      ...(authenticatedSelector.trim() !== "" ? { authenticatedWhen: { selector: authenticatedSelector.trim() } } : {}),
      flags,
    };
  }

  return (
    <span className="page-state-editor">
      <span className={`badge ${summary?.configured === true ? "blue" : "muted"}`}>{summaryText}</span>
      <button className="btn" type="button" onClick={() => setOpen((value) => !value)}>
        {open ? "판정 닫기" : "판정 설정"}
      </button>
      {open && (
        <span className="page-state-editor-panel" role="region" aria-label={`${site.name ?? "사이트"} 화면 상태 판정`}>
          <span className="page-state-editor-head">
            <strong>화면 상태 판정</strong>
            {msg !== null && <span className={`badge ${msg.tone}`} role={msg.tone === "red" ? "alert" : "status"}>{msg.text}</span>}
          </span>
          {detail.isLoading ? (
            <span className="subtle">설정을 불러오는 중…</span>
          ) : detail.isError ? (
            <span className="badge red" role="alert">설정을 불러오지 못했습니다</span>
          ) : (
            <>
              <label className="page-state-field">
                <span className="subtle">로그인 주소</span>
                <input value={loginUrl} onChange={(event) => setLoginUrl(event.target.value)} placeholder="https://login.example.com" />
              </label>
              <label className="page-state-field">
                <span className="subtle">로그인 완료 확인 조건</span>
                <input value={authenticatedSelector} onChange={(event) => setAuthenticatedSelector(event.target.value)} placeholder="사용자 메뉴" />
              </label>
              <span className="page-state-editor-head">
                <span className="subtle">화면 상태 판정</span>
                <button className="btn" type="button" onClick={addRow}>+ 판정</button>
              </span>
              {rows.length === 0 ? (
                <span className="subtle">등록된 화면 상태 판정이 없습니다.</span>
              ) : (
                <span className="page-state-rows">
                  {rows.map((row) => (
                    <span className="page-state-row" key={row.id}>
                      <select aria-label="판정 항목" value={row.key} onChange={(event) => updateRow(row.id, { key: event.target.value as FlagKey })}>
                        {FLAG_KEYS.map((key) => <option key={key} value={key}>{FLAG_KEY_LABELS[key]}</option>)}
                      </select>
                      <select aria-label="판정 방식" value={row.kind} onChange={(event) => updateRow(row.id, { kind: event.target.value as FlagKind })}>
                        {FLAG_KINDS.map((kind) => <option key={kind} value={kind}>{FLAG_KIND_LABELS[kind]}</option>)}
                      </select>
                      <input aria-label="화면 확인 조건" value={row.selector} onChange={(event) => updateRow(row.id, { selector: event.target.value })} placeholder="리뷰 카드" />
                      <input aria-label="최소 개수" type="number" min={1} value={row.n} disabled={row.kind !== "min_count"} onChange={(event) => updateRow(row.id, { n: Number(event.target.value) })} />
                      <button className="btn" type="button" onClick={() => removeRow(row.id)}>삭제</button>
                      <details style={{ gridColumn: "1 / -1", fontSize: 12 }}>
                        <summary className="subtle">판정 기준 보기</summary>
                        <code>{`화면 판정 조건 · ${FLAG_KEY_LABELS[row.key]} · ${FLAG_KIND_LABELS[row.kind]}${row.kind === "min_count" ? " · 최소 개수" : ""}`}</code>
                      </details>
                    </span>
                  ))}
                </span>
              )}
              {invalid && <span className="badge red" role="alert">로그인 주소는 http(s) URL이어야 합니다.</span>}
              <span className="page-state-actions">
                <button className="btn primary" type="button" disabled={!canSave} onClick={() => save.mutate(buildSelectors())}>
                  {save.isPending ? "저장 중…" : "저장"}
                </button>
                <button className="btn" type="button" disabled={save.isPending} onClick={() => save.mutate(null)}>
                  설정 해제
                </button>
              </span>
            </>
          )}
        </span>
      )}
    </span>
  );
}
