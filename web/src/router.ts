import { useEffect, useState } from "react";

// 12 view key. 해시 라우터 — HTML 콘솔의 navigate/hashchange 미러.
export const VIEW_KEYS = [
  "scenarioStudio",
  "playground",
  "dashboard",
  "openGate",
  "workitems",
  "humanTasks",
  "approvalInbox",
  "runTrace",
  "irValidation",
  "llmGateway",
  "security",
  "idempotency",
] as const;

export type ViewKey = (typeof VIEW_KEYS)[number];

// 사이드바 3그룹(제작/운영/고급 설정) — 12개 뷰를 업무 흐름으로 묶어 탐색 부담을 낮춘다.
// 모든 VIEW_KEYS가 정확히 한 그룹에 속해야 한다(router.test가 강제). nav 순서는 그룹 순서를 따른다.
export const NAV_GROUPS: readonly { readonly label: string; readonly keys: readonly ViewKey[] }[] = [
  { label: "제작", keys: ["scenarioStudio", "playground", "irValidation"] },
  { label: "운영", keys: ["dashboard", "runTrace", "workitems", "humanTasks", "approvalInbox"] },
  { label: "고급 설정", keys: ["llmGateway", "security", "idempotency", "openGate"] },
];

const DEFAULT_VIEW: ViewKey = "dashboard";

export function viewFromHash(hash: string): ViewKey {
  // `#viewKey` 또는 `#viewKey?param=...` — 뷰 키는 `?` 이전 부분(드릴다운 딥링크가 쿼리 파라미터를 붙임).
  const key = hash.replace(/^#/, "").split("?")[0] ?? "";
  return (VIEW_KEYS as readonly string[]).includes(key) ? (key as ViewKey) : DEFAULT_VIEW;
}

export function navigate(view: ViewKey, params?: Record<string, string>): void {
  // 뷰 전환 + 드릴다운 파라미터(예: 실행 시작 직후 그 run 상세로 직행 — `#runTrace?run=<id>`). 파라미터 없으면 기존 동작.
  const qs = params !== undefined ? new URLSearchParams(params).toString() : "";
  const next = `#${view}${qs ? `?${qs}` : ""}`;
  if (location.hash !== next) location.hash = next;
}

/**
 * 현재 뷰를 유지한 채 해시 쿼리 파라미터에 updates를 병합해 이동한다(값이 null이면 해당 키 제거).
 * hashWith(병합·테스트됨)와 navigate의 중복-억제 가드를 한데 묶은 단일 진입점 — 뷰가 location.hash를
 * 직접 대입하던 같은-뷰 드릴다운(run/wi/ht)을 여기로 모아 다른 파라미터를 잃지 않게 한다(단방향 의존).
 * artifact 드릴다운은 '동일-해시 재커밋'(ref Y→수동 Z→ref Y 재클릭 복귀, ux-quickwins A3)을 위해 ArtifactLookup이
 * hashWith+직접 setState로 따로 처리한다 — mergeParams는 동일-해시면 조용히 no-op이라 그 경로엔 부적합.
 */
export function mergeParams(updates: Record<string, string | null>): void {
  const next = hashWith(updates);
  if (location.hash !== next) location.hash = next;
}

/** 현재 라우트(해시) 구독. 잘못된 해시는 dashboard로 폴백(조용한 빈화면 금지). */
export function useHashRoute(): ViewKey {
  const [view, setView] = useState<ViewKey>(() => viewFromHash(location.hash));
  useEffect(() => {
    const onChange = (): void => setView(viewFromHash(location.hash));
    window.addEventListener("hashchange", onChange);
    if (location.hash === "") location.hash = `#${DEFAULT_VIEW}`;
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return view;
}

/** 현재 해시의 쿼리 파라미터(`#view?name=value`) 읽기. 드릴다운 상태(선택 run 등)를 URL에 보존 → 딥링크·뒤로가기 복원. */
export function hashParam(name: string): string | null {
  const q = location.hash.split("?")[1];
  return q === undefined ? null : new URLSearchParams(q).get(name);
}

/**
 * 현재 해시(`#view?query`)의 쿼리 파라미터에 updates를 병합한 해시 문자열을 만든다(값이 null이면 해당 키 제거).
 * 같은 뷰의 드릴다운 파라미터(run/artifact/status 등)를 서로 떨어뜨리지 않고 보존 — 각 호출부가 해시를 처음부터
 * 재구성하다 다른 파라미터를 잃어 주소창이 필터/선택과 어긋나던 것(조용한 false) 방지. 뷰는 현재 뷰를 유지한다.
 */
export function hashWith(updates: Record<string, string | null>): string {
  const [viewPart, queryPart] = location.hash.replace(/^#/, "").split("?");
  const params = new URLSearchParams(queryPart ?? "");
  for (const [key, value] of Object.entries(updates)) {
    if (value === null) params.delete(key);
    else params.set(key, value);
  }
  const qs = params.toString();
  return `#${viewPart || DEFAULT_VIEW}${qs ? `?${qs}` : ""}`;
}

/** 해시 쿼리 파라미터를 구독(hashchange마다 갱신). 뒤로가기/딥링크로 드릴다운이 복원된다. */
export function useHashParam(name: string): string | null {
  const [value, setValue] = useState<string | null>(() => hashParam(name));
  useEffect(() => {
    const onChange = (): void => setValue(hashParam(name));
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, [name]);
  return value;
}
