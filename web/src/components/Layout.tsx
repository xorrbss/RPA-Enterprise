import {
  Video, PlaySquare, LayoutDashboard, ClipboardCheck, ListChecks,
  Inbox, Route, FileCode2, Bot, ShieldCheck, DatabaseZap, Workflow,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import { VIEW_KEYS, navigate, type ViewKey } from "../router";
import { VIEW_META } from "../views/meta";
import { Freshness } from "./Freshness";
import { clearToken } from "./TokenGate";

const ICONS: Record<string, LucideIcon> = {
  Video, PlaySquare, LayoutDashboard, ClipboardCheck, ListChecks,
  Inbox, Route, FileCode2, Bot, ShieldCheck, DatabaseZap,
};

export function Layout({ view, children }: { view: ViewKey; children: ReactNode }): JSX.Element {
  const meta = VIEW_META[view];
  return (
    <div className="app">
      <nav className="sidebar" aria-label="주 메뉴">
        <div className="brand">
          <Workflow size={18} aria-hidden="true" /> RPA 운영 콘솔
        </div>
        {VIEW_KEYS.map((key) => {
          const Icon = ICONS[VIEW_META[key].icon] ?? LayoutDashboard;
          const active = key === view;
          return (
            <button
              key={key}
              type="button"
              className={`nav-item${active ? " active" : ""}`}
              aria-current={active ? "page" : undefined}
              onClick={() => navigate(key)}
            >
              <Icon size={16} aria-hidden="true" />
              <span>{VIEW_META[key].title}</span>
            </button>
          );
        })}
      </nav>
      <div className="main">
        <header className="topbar">
          <div>
            <h1>{meta.title}</h1>
            <div className="sub">{meta.subtitle}</div>
          </div>
          <span style={{ display: "inline-flex", gap: 12, alignItems: "center" }}>
            <Freshness />
            <button className="btn" type="button" onClick={clearToken}>
              로그아웃
            </button>
          </span>
        </header>
        <main className="content">{children}</main>
      </div>
    </div>
  );
}
