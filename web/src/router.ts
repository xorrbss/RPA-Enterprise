import { useEffect, useState } from "react";

// 11 view key(rpa_enterprise_console.html nav 순서). 해시 라우터 — HTML 콘솔의 navigate/hashchange 미러.
export const VIEW_KEYS = [
  "scenarioStudio",
  "playground",
  "dashboard",
  "openGate",
  "workitems",
  "humanTasks",
  "runTrace",
  "irValidation",
  "llmGateway",
  "security",
  "idempotency",
] as const;

export type ViewKey = (typeof VIEW_KEYS)[number];

const DEFAULT_VIEW: ViewKey = "dashboard";

export function viewFromHash(hash: string): ViewKey {
  // `#viewKey` 또는 `#viewKey?param=...` — 뷰 키는 `?` 이전 부분(드릴다운 딥링크가 쿼리 파라미터를 붙임).
  const key = hash.replace(/^#/, "").split("?")[0] ?? "";
  return (VIEW_KEYS as readonly string[]).includes(key) ? (key as ViewKey) : DEFAULT_VIEW;
}

export function navigate(view: ViewKey): void {
  if (location.hash !== `#${view}`) location.hash = `#${view}`;
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
