import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Building2,
  CalendarClock,
  ChevronDown,
  LayoutTemplate,
  LogOut,
  PlaySquare,
  Plus,
  Search,
  ShieldCheck,
  Video,
  type LucideIcon,
} from "lucide-react";

import { navigate, type ViewKey } from "../../router";
import { useApiClient } from "../../api/context";
import { decodeSubject, ROLE_LABELS, rolesCan } from "../../api/permissions";
import type { ProductionReadiness } from "../../api/types";
import { clearToken } from "../TokenGate";
import { usePopoverDismiss } from "./usePopoverDismiss";

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

// neutral = 컨텍스트 정상 확인(readiness 판정은 알림 벨·클릭 목적지에서) — 상시 색 경고를 topbar에 두지 않는다(T1).
type ContextTone = "neutral" | "amber" | "red";

interface TopbarContextState {
  readonly tone: ContextTone;
  readonly tenantLabel: string;
  readonly environmentLabel: string;
  readonly statusLabel: string;
  readonly title: string;
  readonly ariaLabel: string;
}

export function TopbarContextBadge(): JSX.Element {
  const api = useApiClient();
  const query = useQuery({
    queryKey: ["production-readiness"],
    queryFn: () => api.getProductionReadiness(),
    refetchInterval: 15_000,
  });
  const context = topbarContextState(query.data, query.data === undefined && query.isFetching, query.isError);
  return (
    <button
      type="button"
      className={`topbar-context-badge${context.tone === "neutral" ? "" : ` ${context.tone}`}`}
      aria-label={context.ariaLabel}
      title={context.title}
      onClick={() => navigate("automationOps", { section: "readiness" })}
    >
      <Building2 size={14} aria-hidden="true" />
      <span className="topbar-context-copy">
        <span className="topbar-context-part">
          <span className="subtle">tenant</span>
          <strong>{context.tenantLabel}</strong>
        </span>
        <span className="topbar-context-separator" aria-hidden="true">/</span>
        <span className="topbar-context-part">
          <span className="subtle">env</span>
          <strong>{context.environmentLabel}</strong>
        </span>
      </span>
      {context.statusLabel !== "" && <span className={`badge ${context.tone}`}>{context.statusLabel}</span>}
    </button>
  );
}

function topbarContextState(readiness: ProductionReadiness | undefined, isLoading: boolean, isError: boolean): TopbarContextState {
  if (isError) {
    return unknownTopbarContext("컨텍스트 미확인", "red");
  }
  if (readiness === undefined) {
    return unknownTopbarContext(isLoading ? "확인 중" : "컨텍스트 미확인", isLoading ? "amber" : "red");
  }
  const tenant = readiness.environment.tenant_id.trim();
  const environment = readiness.environment.target.trim();
  if (tenant.length === 0 || environment.length === 0) {
    return unknownTopbarContext("컨텍스트 불완전", "red");
  }
  // 컨텍스트가 확인되면 중립 표시만 한다 — readiness 차단/경고 신호는 상단바 알림 벨(TopbarAlertBell)이 담당(T1).
  // "차단" 칩이 env 옆에 상시 노출되면 환경 전체가 차단된 것으로 오독된다(감사 P0-2).
  const environmentLabel = environmentDisplayLabel(environment);
  return {
    tone: "neutral",
    tenantLabel: tenant,
    environmentLabel,
    statusLabel: "",
    title: `tenant=${tenant}, environment=${environment}. 운영 전환 준비 상태는 클릭해 확인합니다.`,
    ariaLabel: `tenant/environment 컨텍스트: tenant ${tenant}, environment ${environmentLabel}. 운영 전환 준비 상태 열기`,
  };
}

function unknownTopbarContext(statusLabel: string, tone: ContextTone): TopbarContextState {
  return {
    tone,
    tenantLabel: "미확인",
    environmentLabel: "미확인",
    statusLabel,
    title: "tenant/environment 컨텍스트를 확인할 수 없습니다. 준비 완료로 표시하지 않습니다.",
    ariaLabel: `tenant/environment 컨텍스트 ${statusLabel}. 운영 전환 준비 상태 열기`,
  };
}

function environmentDisplayLabel(environment: string): string {
  if (environment === "controlled_prod") return "통제 운영";
  return environment;
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
      view: "create",
      params: { creator: "ai" },
    });
    items.push({
      key: "template",
      label: "템플릿에서 시작",
      description: "검증된 업무 템플릿을 골라 자동화 초안 생성",
      icon: LayoutTemplate,
      view: "create",
      params: { start: "template" },
    });
  }
  if (can("run.create")) {
    items.push({
      key: "test",
      label: "테스트 실행",
      description: "저장된 자동화의 계획을 확인하고 시험 실행",
      icon: PlaySquare,
      view: "create",
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
  // "증빙 확인"(조회 액션)은 생성 메뉴에서 제외 — 커맨드 팔레트 quick action("도입 증빙 열기")이 담당한다(T1).
  // 조회 전용 항목이 있으면 viewer(run.read+artifact.read 보유)에게도 "+ 새로 만들기"가 노출되는 게이팅 불일치가 생긴다.
  return items;
}

export function GlobalCreateMenu({ roles }: { roles: readonly string[] }): JSX.Element | null {
  const items = useMemo(() => createMenuItems(roles), [roles]);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuId = useId();
  const close = useCallback(() => setOpen(false), []);
  // 닫힘 규약(mousedown 바깥/Escape/포커스 복원)은 usePopoverDismiss 공유(F4 — TopbarAlertBell 과 동일).
  const { onKeyDown } = usePopoverDismiss({ open, onClose: close, rootRef, triggerRef });
  useEffect(() => setOpen(false), [roles]);
  if (items.length === 0) return null;
  return (
    <span ref={rootRef} className="create-menu" onKeyDown={onKeyDown}>
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
