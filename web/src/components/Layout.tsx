import {
  Video, PlaySquare, LayoutDashboard, ClipboardCheck, ListChecks,
  Inbox, Route, FileCode2, Bot, ShieldCheck, DatabaseZap, Workflow,
  type LucideIcon,
} from "lucide-react";
import { useMemo, type ReactNode } from "react";

import { NAV_GROUPS, navigate, type ViewKey } from "../router";
import { decodeRoles, ROLE_LABELS } from "../api/permissions";
import { VIEW_META } from "../views/meta";
import { Freshness } from "./Freshness";
import { clearToken } from "./TokenGate";

const ICONS: Record<string, LucideIcon> = {
  Video, PlaySquare, LayoutDashboard, ClipboardCheck, ListChecks,
  Inbox, Route, FileCode2, Bot, ShieldCheck, DatabaseZap,
};

function NavItem({ viewKey, active }: { viewKey: ViewKey; active: boolean }): JSX.Element {
  const Icon = ICONS[VIEW_META[viewKey].icon] ?? LayoutDashboard;
  return (
    <button
      type="button"
      className={`nav-item${active ? " active" : ""}`}
      aria-current={active ? "page" : undefined}
      onClick={() => navigate(viewKey)}
    >
      <Icon size={16} aria-hidden="true" />
      <span>{VIEW_META[viewKey].title}</span>
    </button>
  );
}

// 현재 토큰의 역할 칩(신뢰감/맥락). 로그아웃은 페이지 reload이므로 mount 1회 디코드로 충분(useCan과 동일 가정).
// 테넌트 칩은 의도적으로 제외 — JWT tenant_id를 프론트가 디코드/검증하지 않으므로 과대표시를 피한다.
function RolesChip(): JSX.Element {
  const roles = useMemo(() => decodeRoles(localStorage.getItem("rpa.token")), []);
  if (roles.length === 0) return <span className="subtle">역할 미확인</span>;
  return (
    <span style={{ display: "inline-flex", gap: 4, alignItems: "center" }} aria-label="현재 역할">
      {roles.map((r) => (
        <span key={r} className="badge blue">{ROLE_LABELS[r] ?? r}</span>
      ))}
    </span>
  );
}

export function Layout({ view, children }: { view: ViewKey; children: ReactNode }): JSX.Element {
  const meta = VIEW_META[view];
  return (
    <div className="app">
      <nav className="sidebar" aria-label="주 메뉴">
        <div className="brand">
          <Workflow size={18} aria-hidden="true" /> RPA 운영 콘솔
        </div>
        {NAV_GROUPS.map((group) => (
          <div key={group.label} className="nav-group" role="group" aria-label={group.label}>
            <div className="nav-group-label" aria-hidden="true">{group.label}</div>
            {group.keys.map((key) => (
              <NavItem key={key} viewKey={key} active={key === view} />
            ))}
          </div>
        ))}
      </nav>
      <div className="main">
        <header className="topbar">
          <div>
            <h1>{meta.title}</h1>
            <div className="sub">{meta.subtitle}</div>
          </div>
          <span style={{ display: "inline-flex", gap: 12, alignItems: "center" }}>
            <RolesChip />
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
