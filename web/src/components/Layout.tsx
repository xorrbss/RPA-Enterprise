import {
  Video, PlaySquare, LayoutDashboard, ClipboardCheck, ListChecks,
  Inbox, Route, FileCode2, Bot, ShieldCheck, DatabaseZap, Workflow,
  CalendarClock, Lightbulb, ScrollText, Plug, MousePointerClick, FileSearch,
  HelpCircle, Menu, UserCircle, X,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";

import { navigate, type ViewKey } from "../router";
import { useRoles } from "../api/permissions";
import {
  getInternalNavFlags,
  getVisibleNavGroups,
  hasAdvancedNav,
  readStoredNavMode,
  writeStoredNavMode,
  type NavMode,
  type NavPolicyFlags,
  type VisibleNavGroup,
} from "../navPolicy";
import { VIEW_META } from "../views/meta";
import { CommandPalette } from "./CommandPalette";
import { Freshness } from "./Freshness";
import { OffboardingBanner } from "./OffboardingBanner";
import { GlobalCreateMenu, LogoutButton, RolesChip, SearchButton, SubjectChip, TopbarContextBadge } from "./layout/TopbarActions";
import { TopbarAlertBell } from "./layout/TopbarAlertBell";
import { usePopoverDismiss } from "./layout/usePopoverDismiss";

const ICONS: Record<string, LucideIcon> = {
  Video, PlaySquare, LayoutDashboard, ClipboardCheck, ListChecks,
  Inbox, Route, FileCode2, Bot, ShieldCheck, DatabaseZap, CalendarClock, Lightbulb, ScrollText, Plug, MousePointerClick, FileSearch,
};

const MOBILE_NAV_QUERY = "(max-width: 900px)";

function mediaQueryMatches(query: string): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia(query).matches;
}

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => mediaQueryMatches(query));
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const queryList = window.matchMedia(query);
    const onChange = (): void => setMatches(queryList.matches);
    onChange();
    if (typeof queryList.addEventListener === "function") {
      queryList.addEventListener("change", onChange);
      return () => queryList.removeEventListener("change", onChange);
    }
    queryList.addListener(onChange);
    return () => queryList.removeListener(onChange);
  }, [query]);
  return matches;
}

function getFocusable(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'))
    .filter((el) => !el.hasAttribute("disabled") && el.tabIndex !== -1);
}

function NavItem({ viewKey, active, onNavigate }: { viewKey: ViewKey; active: boolean; onNavigate?: () => void }): JSX.Element {
  const Icon = ICONS[VIEW_META[viewKey].icon] ?? LayoutDashboard;
  return (
    <button
      type="button"
      className={`nav-item${active ? " active" : ""}`}
      aria-current={active ? "page" : undefined}
      onClick={() => {
        navigate(viewKey);
        onNavigate?.();
      }}
    >
      <Icon size={16} aria-hidden="true" />
      <span>{VIEW_META[viewKey].title}</span>
    </button>
  );
}

function NavGroups({ groups, activeView, onNavigate }: { groups: readonly VisibleNavGroup[]; activeView: ViewKey; onNavigate?: () => void }): JSX.Element {
  return (
    <>
      {groups.map((group) => (
        <div key={group.label} className="nav-group" role="group" aria-label={group.label}>
          <div className="nav-group-label" aria-hidden="true">{group.label}</div>
          {group.keys.map((key) => (
            <NavItem key={key} viewKey={key} active={key === activeView} onNavigate={onNavigate} />
          ))}
        </div>
      ))}
    </>
  );
}

function NavModeControl({
  mode,
  onChange,
}: {
  mode: NavMode;
  onChange: (mode: NavMode) => void;
}): JSX.Element {
  return (
    <div className="nav-mode" role="group" aria-label="메뉴 표시 모드">
      <span className="nav-mode-label">메뉴 모드</span>
      <div className="nav-mode-options">
        <button
          type="button"
          className={`nav-mode-option${mode === "standard" ? " active" : ""}`}
          aria-pressed={mode === "standard"}
          onClick={() => onChange("standard")}
        >
          기본
        </button>
        <button
          type="button"
          className={`nav-mode-option${mode === "advanced" ? " active" : ""}`}
          aria-pressed={mode === "advanced"}
          onClick={() => onChange("advanced")}
        >
          고급
        </button>
      </div>
    </div>
  );
}

export function Layout({ view, children }: { view: ViewKey; children: ReactNode }): JSX.Element {
  const meta = VIEW_META[view];
  // A3-1 잔여: 버튼/섹션(useCan)과 동일하게 nav 가시성도 서버 효과 역할(토큰∪수동부여)을 따른다 —
  // 토큰만 읽으면 수동 부여받은 역할의 메뉴가 안 보인다(딥링크·버튼은 되는데 메뉴만 없는 발견성 결함).
  const roles = useRoles();
  const flags = useMemo<NavPolicyFlags>(() => getInternalNavFlags(), []);
  const [navMode, setNavMode] = useState<NavMode>(() => readStoredNavMode());
  const advancedAvailable = useMemo(() => hasAdvancedNav({ roles, flags }), [roles, flags]);
  const visibleNavGroups = useMemo(
    () => getVisibleNavGroups({ roles, mode: navMode, flags }),
    [roles, navMode, flags],
  );
  // '?' 도움말 토글 — title 툴팁은 터치/스크린리더에 안 닿으므로 클릭 시 본문을 화면에 펼친다.
  const [showHelp, setShowHelp] = useState(false);
  const helpId = useId();
  const drawerId = useId();
  const drawerTitleId = useId();
  const accountMenuId = useId();
  // 화면을 바꾸면 이전 화면의 도움말은 닫는다(맥락 불일치 방지).
  useEffect(() => setShowHelp(false), [view]);
  const helpText = meta.helpText ?? meta.subtitle;
  const [paletteOpen, setPaletteOpen] = useState(false);
  const isMobileNav = useMediaQuery(MOBILE_NAV_QUERY);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const drawerRef = useRef<HTMLDivElement>(null);
  const mobileMenuButtonRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const accountRootRef = useRef<HTMLSpanElement>(null);
  const accountTriggerRef = useRef<HTMLButtonElement>(null);
  // 계정 팝오버 닫힘 규약(mousedown 바깥 닫기 + Escape 닫기 + 트리거 포커스 복원)은 벨·생성 메뉴와 동일하게
  // usePopoverDismiss 공유. 화면 전환/데스크톱 전환 시 닫기는 아래 setAccountOpen(false) 효과가 그대로 담당.
  const closeAccount = useCallback(() => setAccountOpen(false), []);
  const { onKeyDown: onAccountKeyDown } = usePopoverDismiss({
    open: accountOpen,
    onClose: closeAccount,
    rootRef: accountRootRef,
    triggerRef: accountTriggerRef,
  });
  useEffect(() => {
    if (!advancedAvailable && navMode !== "standard") {
      setNavMode("standard");
      writeStoredNavMode("standard");
    }
  }, [advancedAvailable, navMode]);
  // 전역 단축키 Ctrl/⌘+K → 커맨드 팔레트(어느 화면에서나 검색·이동 진입점).
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen(true);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    setDrawerOpen(false);
    setAccountOpen(false);
  }, [view]);

  useEffect(() => {
    if (!isMobileNav) {
      setDrawerOpen(false);
      setAccountOpen(false);
    }
  }, [isMobileNav]);

  useEffect(() => {
    if (!drawerOpen) return;
    const timer = setTimeout(() => {
      const drawer = drawerRef.current;
      if (drawer === null) return;
      const focusables = getFocusable(drawer);
      (focusables[0] ?? drawer).focus();
    }, 0);
    return () => {
      clearTimeout(timer);
      restoreFocusRef.current?.focus();
    };
  }, [drawerOpen]);

  function changeNavMode(mode: NavMode): void {
    setNavMode(mode);
    writeStoredNavMode(mode);
  }

  function openDrawer(): void {
    restoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : mobileMenuButtonRef.current;
    setAccountOpen(false);
    setDrawerOpen(true);
  }

  function closeDrawer(): void {
    setDrawerOpen(false);
  }

  function onDrawerKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    if (event.key === "Escape") {
      event.preventDefault();
      closeDrawer();
      return;
    }
    if (event.key !== "Tab") return;
    const focusables = getFocusable(event.currentTarget);
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (first === undefined || last === undefined) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <div className="app">
      <nav className="sidebar" aria-label="주 메뉴" aria-hidden={isMobileNav ? "true" : undefined}>
        <div className="brand">
          <Workflow size={18} aria-hidden="true" /> RPA 운영 콘솔
        </div>
        <NavGroups groups={visibleNavGroups} activeView={view} />
        {advancedAvailable && <NavModeControl mode={navMode} onChange={changeNavMode} />}
      </nav>
      <div className="main">
        <header className="topbar">
          {isMobileNav && (
            <button
              ref={mobileMenuButtonRef}
              type="button"
              className="btn mobile-menu-button"
              aria-expanded={drawerOpen}
              aria-controls={drawerId}
              onClick={openDrawer}
            >
              <Menu size={16} aria-hidden="true" />
              메뉴
            </button>
          )}
          <div className="topbar-main">
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
          {/* T1: 데스크톱·모바일 동일 구성 — 계정·역할·로그아웃은 팝오버로 이동해 상단바를 행동(알림·만들기·검색) 중심으로 유지. */}
          <span className="topbar-actions">
            <TopbarContextBadge />
            <TopbarAlertBell />
            <Freshness />
            <GlobalCreateMenu roles={roles} />
            <SearchButton onClick={() => setPaletteOpen(true)} />
            <span ref={accountRootRef} className="account-menu" onKeyDown={onAccountKeyDown}>
              <button
                ref={accountTriggerRef}
                className="btn icon-btn account-menu-button mobile-account-button"
                type="button"
                aria-label="계정 메뉴"
                aria-haspopup="menu"
                aria-expanded={accountOpen}
                aria-controls={accountOpen ? accountMenuId : undefined}
                onClick={() => setAccountOpen((current) => !current)}
              >
                <UserCircle size={16} aria-hidden="true" />
              </button>
              {accountOpen && (
                <div id={accountMenuId} className="account-menu-popover" role="region" aria-label="계정 및 역할">
                  <SubjectChip />
                  <RolesChip roles={roles} />
                  <LogoutButton className="btn account-menu-logout" />
                </div>
              )}
            </span>
          </span>
        </header>
        <OffboardingBanner />
        <main className="content">{children}</main>
      </div>
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} roles={roles} navMode={navMode} flags={flags} />
      {drawerOpen && (
        <div
          className="nav-drawer-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeDrawer();
          }}
        >
          <div
            id={drawerId}
            ref={drawerRef}
            className="nav-drawer"
            role="dialog"
            aria-modal="true"
            aria-label="주 메뉴"
            tabIndex={-1}
            onKeyDown={onDrawerKeyDown}
          >
            <div className="nav-drawer-head">
              <div id={drawerTitleId} className="brand">
                <Workflow size={18} aria-hidden="true" /> RPA 운영 콘솔
              </div>
              <button className="btn icon-btn" type="button" aria-label="메뉴 닫기" onClick={closeDrawer}>
                <X size={16} aria-hidden="true" />
              </button>
            </div>
            <nav className="nav-drawer-nav" aria-label="모바일 주 메뉴">
              <NavGroups groups={visibleNavGroups} activeView={view} onNavigate={closeDrawer} />
            </nav>
            {advancedAvailable && <NavModeControl mode={navMode} onChange={changeNavMode} />}
          </div>
        </div>
      )}
    </div>
  );
}
