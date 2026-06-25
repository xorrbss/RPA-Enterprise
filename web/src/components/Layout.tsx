import {
  Video, PlaySquare, LayoutDashboard, ClipboardCheck, ListChecks,
  Inbox, Route, FileCode2, Bot, ShieldCheck, DatabaseZap, Workflow, Stamp,
  CalendarClock, Lightbulb, ScrollText, Plug, MousePointerClick, FileSearch,
  HelpCircle,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useId, useMemo, useState, type ReactNode } from "react";

import { NAV_GROUPS, navigate, type ViewKey } from "../router";
import { decodeRoles, decodeSubject, ROLE_LABELS } from "../api/permissions";
import { VIEW_META } from "../views/meta";
import { Freshness } from "./Freshness";
import { clearToken } from "./TokenGate";

const ICONS: Record<string, LucideIcon> = {
  Video, PlaySquare, LayoutDashboard, ClipboardCheck, ListChecks,
  Inbox, Route, FileCode2, Bot, ShieldCheck, DatabaseZap, Stamp, CalendarClock, Lightbulb, ScrollText, Plug, MousePointerClick, FileSearch,
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

// 현재 접속 권한 칩(신뢰감/맥락). 로그아웃은 페이지 reload이므로 mount 1회 디코드로 충분(useCan과 동일 가정).
// 테넌트 칩은 의도적으로 제외 — 프론트가 tenant_id를 검증하지 않으므로 과대표시를 피한다.
function RolesChip(): JSX.Element {
  const roles = useMemo(() => decodeRoles(localStorage.getItem("rpa.token")), []);
  if (roles.length === 0)
    return (
      <span
        className="subtle"
        title="접속 권한 정보가 없어 읽기 전용으로 동작합니다. 관리자에게 운영 권한 확인을 요청하세요."
      >
        권한 미확인 · 읽기 전용
      </span>
    );
  return (
    <span style={{ display: "inline-flex", gap: 4, alignItems: "center" }} aria-label="현재 역할">
      {roles.map((r) => (
        <span key={r} className="badge blue">{ROLE_LABELS[r] ?? r}</span>
      ))}
    </span>
  );
}

function SubjectChip(): JSX.Element {
  const subject = useMemo(() => decodeSubject(localStorage.getItem("rpa.token")), []);
  if (subject === null) {
    return <span className="subtle" title="현재 접속 계정을 확인할 수 없습니다.">계정 미확인</span>;
  }
  return (
    <span className="subject-chip" title="현재 접속 계정" aria-label={`현재 접속 계정 ${subject}`}>
      <span className="subtle">계정</span>
      <code>{subject}</code>
    </span>
  );
}

export function Layout({ view, children }: { view: ViewKey; children: ReactNode }): JSX.Element {
  const meta = VIEW_META[view];
  // '?' 도움말 토글 — title 툴팁은 터치/스크린리더에 안 닿으므로 클릭 시 본문을 화면에 펼친다.
  const [showHelp, setShowHelp] = useState(false);
  const helpId = useId();
  // 화면을 바꾸면 이전 화면의 도움말은 닫는다(맥락 불일치 방지).
  useEffect(() => setShowHelp(false), [view]);
  const helpText = meta.helpText ?? meta.subtitle;
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
            <div className="topbar-heading">
              <h1>{meta.title}</h1>
              <button
                type="button"
                className="help-button"
                aria-label={`${meta.title} 화면 도움말`}
                aria-expanded={showHelp}
                aria-controls={showHelp ? helpId : undefined}
                title={helpText}
                onClick={() => setShowHelp((v) => !v)}
              >
                <HelpCircle size={15} aria-hidden="true" />
              </button>
            </div>
            <div className="sub">{meta.subtitle}</div>
            {showHelp && (
              <div id={helpId} className="help-text" role="region" aria-label={`${meta.title} 화면 도움말`}>
                {helpText}
              </div>
            )}
          </div>
          <span style={{ display: "inline-flex", gap: 12, alignItems: "center" }}>
            <SubjectChip />
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
