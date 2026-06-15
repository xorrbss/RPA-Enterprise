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
  const key = hash.replace(/^#/, "");
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
