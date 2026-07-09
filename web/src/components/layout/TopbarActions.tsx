import { useEffect, useId, useMemo, useRef, useState } from "react";
import { CalendarClock, ChevronDown, ClipboardCheck, LayoutTemplate, LogOut, PlaySquare, Plus, Search, ShieldCheck, Video, type LucideIcon } from "lucide-react";

import { navigate, type ViewKey } from "../../router";
import { decodeSubject, ROLE_LABELS, rolesCan } from "../../api/permissions";
import { clearToken } from "../TokenGate";

export function RolesChip({ roles }: { roles: readonly string[] }): JSX.Element {
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
    <span className="roles-chip" aria-label="현재 역할">
      {roles.map((r) => (
        <span key={r} className="badge blue">{ROLE_LABELS[r] ?? r}</span>
      ))}
    </span>
  );
}

function compactSubjectLabel(subject: string): string {
  const normalized = subject.trim();
  if (normalized.length <= 18) return normalized;
  const separatorIndex = Math.max(normalized.lastIndexOf("|"), normalized.lastIndexOf(":"), normalized.lastIndexOf("/"));
  if (separatorIndex >= 0 && separatorIndex < normalized.length - 1) {
    const localPart = normalized.slice(separatorIndex + 1);
    if (localPart.length <= 18) return localPart;
    return `${localPart.slice(0, 8)}...${localPart.slice(-6)}`;
  }
  return `...${normalized.slice(-12)}`;
}

export function SubjectChip(): JSX.Element {
  const subject = useMemo(() => decodeSubject(localStorage.getItem("rpa.token")), []);
  if (subject === null) {
    return <span className="subtle" title="현재 접속 계정을 확인할 수 없습니다.">계정 미확인</span>;
  }
  const displaySubject = compactSubjectLabel(subject);
  return (
    <span className="subject-chip" title={`현재 접속 계정 ${subject}`} aria-label={`현재 접속 계정 ${subject}`}>
      <span className="subtle">계정</span>
      <code>{displaySubject}</code>
    </span>
  );
}

export function SearchButton({ onClick }: { onClick: () => void }): JSX.Element {
  return (
    <button
      className="btn palette-trigger"
      type="button"
      aria-label="전역 검색"
      aria-keyshortcuts="Control+K Meta+K"
      title="전역 검색·화면 이동 (Ctrl/⌘+K)"
      onClick={onClick}
    >
      <Search size={14} aria-hidden="true" /> <span className="topbar-action-text">검색</span>
    </button>
  );
}

interface GlobalCreateItem {
  readonly key: string;
  readonly label: string;
  readonly description: string;
  readonly icon: LucideIcon;
  readonly view: ViewKey;
  readonly params?: Record<string, string>;
}

function createMenuItems(roles: readonly string[]): readonly GlobalCreateItem[] {
  const can = (action: string): boolean => rolesCan(roles, action);
  const items: GlobalCreateItem[] = [];
  if (can("scenario.create")) {
    items.push({
      key: "scenario",
      label: "자동화 만들기",
      description: "말로 설명하거나 브라우저 녹화로 시작",
      icon: Video,
      view: "scenarioStudio",
    });
    items.push({
      key: "template",
      label: "템플릿에서 시작",
      description: "검증된 업무 템플릿을 골라 자동화 초안 생성",
      icon: LayoutTemplate,
      view: "connectorCatalog",
      params: { focus: "templates" },
    });
  }
  if (can("run.create")) {
    items.push({
      key: "test",
      label: "테스트 실행",
      description: "저장된 자동화의 계획을 확인하고 시험 실행",
      icon: PlaySquare,
      view: "scenarioStudio",
      params: { focus: "test" },
    });
  }
  if (can("trigger.manage")) {
    items.push({
      key: "schedule",
      label: "운영 예약",
      description: "검증된 자동화를 일정·트리거에 연결",
      icon: CalendarClock,
      view: "automationOps",
      params: { section: "schedule" },
    });
  }
  if (can("session.capture") || can("site.create") || can("site.update")) {
    items.push({
      key: "site-session",
      label: "사이트/세션 등록",
      description: "로그인이 필요한 사이트 실행 준비",
      icon: ShieldCheck,
      view: "security",
      params: { section: "sites" },
    });
  }
  if (can("run.read") && can("artifact.read")) {
    items.push({
      key: "evidence",
      label: "증빙 확인",
      description: "파일럿 준비도와 실행·감사 증빙 패킷 확인",
      icon: ClipboardCheck,
      view: "adoptionEvidence",
    });
  }
  return items;
}

export function GlobalCreateMenu({ roles }: { roles: readonly string[] }): JSX.Element | null {
  const items = useMemo(() => createMenuItems(roles), [roles]);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuId = useId();
  useEffect(() => setOpen(false), [roles]);
  useEffect(() => {
    if (!open) return;
    const onMouseDown = (event: MouseEvent): void => {
      const target = event.target;
      if (!(target instanceof Node) || rootRef.current?.contains(target) === true) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [open]);
  if (items.length === 0) return null;
  return (
    <span
      ref={rootRef}
      className="create-menu"
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !open) return;
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
        triggerRef.current?.focus();
      }}
    >
      <button
        ref={triggerRef}
        className="btn create-menu-button"
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((current) => !current)}
      >
        <Plus size={14} aria-hidden="true" />
        <span className="topbar-action-text">새로 만들기</span>
        <ChevronDown className="create-menu-chevron" size={13} aria-hidden="true" />
      </button>
      {open && (
        <div id={menuId} className="create-menu-popover" role="menu" aria-label="새로 만들기">
          {items.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.key}
                className="create-menu-item"
                type="button"
                role="menuitem"
                onClick={() => {
                  navigate(item.view, item.params);
                  setOpen(false);
                }}
              >
                <Icon size={16} aria-hidden="true" />
                <span>
                  <strong>{item.label}</strong>
                  <small>{item.description}</small>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </span>
  );
}

export function LogoutButton({ className = "btn" }: { className?: string }): JSX.Element {
  return (
    <button className={className} type="button" aria-label="로그아웃" title="로그아웃" onClick={clearToken}>
      <LogOut size={14} aria-hidden="true" /> <span className="topbar-action-text">로그아웃</span>
    </button>
  );
}
