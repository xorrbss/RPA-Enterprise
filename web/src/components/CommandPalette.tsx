import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useQuery } from "@tanstack/react-query";

import type { ApiClient } from "../api/client";
import { useApiClient } from "../api/context";
import { VIEW_KEYS, navigate, type ViewKey } from "../router";
import { VIEW_META } from "../views/meta";
import type { ConcurrencyPolicy, HumanTaskItem, RunItem, ScenarioItem } from "../api/types";

const LOOKUP_LIMIT = 50;
const SEARCH_STALE_MS = 30_000;
const MIN_ENTITY_QUERY_LENGTH = 2;
const GROUP_LIMIT = 6;

interface PaletteItem {
  readonly id: string;
  readonly group: string;
  readonly label: string;
  readonly hint: string;
  readonly run: () => void;
}

interface QuickActionSpec {
  readonly id: string;
  readonly label: string;
  readonly hint: string;
  readonly view: ViewKey;
  readonly params?: Record<string, string>;
  readonly keywords: readonly string[];
}

const QUICK_ACTIONS: readonly QuickActionSpec[] = [
  {
    id: "failed-system-runs",
    label: "시스템 실패 실행 보기",
    hint: "실행 기록을 시스템 실패 상태로 필터",
    view: "runTrace",
    params: { status: "failed_system" },
    keywords: ["failed", "failure", "error", "system failure", "failed runs", "실패", "장애", "시스템", "실행", "run"],
  },
  {
    id: "failed-business-runs",
    label: "업무 실패 실행 보기",
    hint: "실행 기록을 업무 실패 상태로 필터",
    view: "runTrace",
    params: { status: "failed_business" },
    keywords: ["failed", "failure", "business failure", "failed runs", "실패", "업무", "실행", "run"],
  },
  {
    id: "queued-runs",
    label: "대기 실행 보기",
    hint: "실행 기록을 대기 상태로 필터",
    view: "runTrace",
    params: { status: "queued" },
    keywords: ["queued", "queue", "waiting", "pending", "대기", "큐", "실행", "run"],
  },
  {
    id: "human-task-inbox",
    label: "사람확인 인박스 열기",
    hint: "사람 확인 업무 목록으로 이동",
    view: "humanTasks",
    keywords: ["human task", "human tasks", "inbox", "review", "approval", "사람확인", "사람 확인", "인박스", "검토", "승인"],
  },
  {
    id: "credential-management",
    label: "Credential 관리 열기",
    hint: "보안 화면의 Credential 관리 영역으로 이동",
    view: "security",
    params: { focus: "credentials" },
    keywords: ["credential", "credentials", "secret", "secrets", "password", "자격증명", "비밀", "시크릿", "계정", "보안"],
  },
  {
    id: "worker-pool-management",
    label: "Worker Pool 관리 열기",
    hint: "보안 화면의 Worker Pool 관리 영역으로 이동",
    view: "security",
    params: { focus: "worker-pools" },
    keywords: ["worker pool", "worker pools", "pool", "workers", "bot pool", "워커", "풀", "작업자", "봇풀", "보안"],
  },
  {
    id: "automation-report",
    label: "Automation report 열기",
    hint: "대시보드의 자동화 성과 리포트로 이동",
    view: "dashboard",
    params: { focus: "automation-report" },
    keywords: ["automation report", "performance report", "report", "metrics", "성과", "리포트", "보고서", "자동화"],
  },
];

// 팔레트 검색용 엔티티는 최근/로드된 범위만 가져와 클라이언트에서 필터링한다.
async function listPaletteScenarios(api: ApiClient): Promise<readonly ScenarioItem[]> {
  return (await api.listScenarios({ limit: LOOKUP_LIMIT })).items;
}

function includesQuery(q: string, values: readonly (string | number | null | undefined)[]): boolean {
  return values.some((value) => value !== null && value !== undefined && String(value).toLowerCase().includes(q));
}

function shortRef(id: string): string {
  return id.length <= 12 ? id : id.slice(0, 8);
}

function runLabel(run: RunItem): string {
  return `실행 ${shortRef(run.run_id)}`;
}

function humanTaskLabel(task: HumanTaskItem): string {
  return `사람 확인 ${shortRef(task.human_task_id)}`;
}

function credentialLabel(policy: ConcurrencyPolicy): string {
  return policy.label?.trim() !== "" && policy.label !== undefined && policy.label !== null
    ? policy.label
    : policy.credential_ref;
}

// 전역 커맨드 팔레트(Ctrl/⌘+K) — 화면 이동 + 최근 실행/업무/담당자/Credential/자동화 검색. 입력 포커스 유지 + ↑↓ 하이라이트
// (aria-activedescendant), Enter 실행, Esc·배경 클릭 닫기. 열기 직전 포커스를 닫을 때 복원한다(접근성).
export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }): JSX.Element | null {
  const api = useApiClient();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  const q = query.trim().toLowerCase();
  const lookupEnabled = open && q.length >= MIN_ENTITY_QUERY_LENGTH;

  const runs = useQuery({
    queryKey: ["palette-runs"],
    queryFn: async () => (await api.listRuns({ limit: LOOKUP_LIMIT })).items,
    enabled: lookupEnabled,
    staleTime: SEARCH_STALE_MS,
  });

  const humanTasks = useQuery({
    queryKey: ["palette-human-tasks"],
    queryFn: async () => (await api.listHumanTasks({ limit: LOOKUP_LIMIT })).items,
    enabled: lookupEnabled,
    staleTime: SEARCH_STALE_MS,
  });

  const principals = useQuery({
    queryKey: ["palette-principals"],
    queryFn: async () => (await api.listPrincipals({ limit: LOOKUP_LIMIT })).items,
    enabled: lookupEnabled,
    staleTime: SEARCH_STALE_MS,
  });

  const scenarios = useQuery({
    queryKey: ["palette-scenarios"],
    queryFn: () => listPaletteScenarios(api),
    enabled: lookupEnabled,
    staleTime: SEARCH_STALE_MS,
  });

  const credentials = useQuery({
    queryKey: ["palette-credentials"],
    queryFn: async () => (await api.listConcurrencyPolicies()).items,
    enabled: lookupEnabled,
    staleTime: SEARCH_STALE_MS,
  });

  useEffect(() => {
    if (!open) return;
    restoreRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setQuery("");
    setActive(0);
    const timer = setTimeout(() => inputRef.current?.focus(), 0);
    return () => {
      clearTimeout(timer);
      restoreRef.current?.focus();
    };
  }, [open]);

  const items = useMemo<readonly PaletteItem[]>(() => {
    const quickActions: PaletteItem[] = QUICK_ACTIONS.filter((action) =>
      q === "" || includesQuery(q, [action.label, action.hint, ...action.keywords]),
    ).map((action) => ({
      id: `quick:${action.id}`,
      group: "빠른 작업",
      label: action.label,
      hint: action.hint,
      run: () => {
        navigate(action.view, action.params);
        onClose();
      },
    }));
    const views: PaletteItem[] = VIEW_KEYS.filter(
      (k) => q === "" || VIEW_META[k].title.toLowerCase().includes(q) || VIEW_META[k].subtitle.toLowerCase().includes(q),
    ).map((k) => ({
      id: `view:${k}`,
      group: "화면",
      label: VIEW_META[k].title,
      hint: VIEW_META[k].subtitle,
      run: () => {
        navigate(k);
        onClose();
      },
    }));
    const runItems: PaletteItem[] =
      q.length < MIN_ENTITY_QUERY_LENGTH
        ? []
        : (runs.data ?? [])
            .filter((r) => includesQuery(q, [r.run_id, r.status, r.current_node, r.failure_reason?.code, r.failure_reason?.message]))
            .slice(0, GROUP_LIMIT)
            .map((r) => ({
              id: `run:${r.run_id}`,
              group: "실행",
              label: runLabel(r),
              hint: `${r.status}${r.as_of !== null ? ` · ${r.as_of.slice(0, 10)}` : ""}`,
              run: () => {
                navigate("runTrace", { run: r.run_id });
                onClose();
              },
            }));
    const humanTaskItems: PaletteItem[] =
      q.length < MIN_ENTITY_QUERY_LENGTH
        ? []
        : (humanTasks.data ?? [])
            .filter((t) => includesQuery(q, [t.human_task_id, t.kind, t.state, t.assignee, t.run_id]))
            .slice(0, GROUP_LIMIT)
            .map((t) => ({
              id: `human-task:${t.human_task_id}`,
              group: "사람 확인",
              label: humanTaskLabel(t),
              hint: `${t.kind} · ${t.state}${t.assignee !== null ? ` · ${t.assignee}` : ""}`,
              run: () => {
                navigate("humanTasks", { ht: t.human_task_id });
                onClose();
              },
            }));
    const principalItems: PaletteItem[] =
      q.length < MIN_ENTITY_QUERY_LENGTH
        ? []
        : (principals.data ?? [])
            .filter((p) => includesQuery(q, [p.principal_id, p.sub, p.display_name, p.email]))
            .slice(0, GROUP_LIMIT)
            .map((p) => ({
              id: `principal:${p.principal_id}`,
              group: "담당자",
              label: p.display_name,
              hint: p.email ?? p.sub,
              run: () => {
                navigate("security", { principal: p.principal_id });
                onClose();
              },
            }));
    const scenarioItems: PaletteItem[] =
      q.length < MIN_ENTITY_QUERY_LENGTH
        ? []
        : (scenarios.data ?? [])
            .filter((s) => includesQuery(q, [s.scenario_id, s.name, s.version]))
            .slice(0, GROUP_LIMIT)
            .map((s) => ({
              id: `scenario:${s.scenario_id}`,
              group: "자동화",
              label: s.name,
              hint: `테스트 실행으로 이동 · 변경 ${s.version}`,
              run: () => {
                navigate("playground", { scenario: s.scenario_id });
                onClose();
              },
            }));
    const credentialItems: PaletteItem[] =
      q.length < MIN_ENTITY_QUERY_LENGTH
        ? []
        : (credentials.data ?? [])
            .filter((c) =>
              includesQuery(q, [
                c.credential_ref,
                c.label,
                c.site_profile_id,
                c.site_name,
                c.owner_sub,
                c.registered_by,
                c.status,
              ]),
            )
            .slice(0, GROUP_LIMIT)
            .map((c) => ({
              id: `credential:${c.site_profile_id}:${c.credential_ref}`,
              group: "Credential",
              label: credentialLabel(c),
              hint: c.site_name ?? c.site_profile_id,
              run: () => {
                navigate("security", { credential: c.credential_ref, credential_site: c.site_profile_id });
                onClose();
              },
            }));
    return [...quickActions, ...views, ...runItems, ...humanTaskItems, ...principalItems, ...scenarioItems, ...credentialItems];
  }, [q, runs.data, humanTasks.data, principals.data, scenarios.data, credentials.data, onClose]);

  useEffect(() => {
    setActive((a) => (items.length === 0 ? 0 : Math.max(0, Math.min(a, items.length - 1))));
  }, [items.length]);

  if (!open) return null;

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((a) => (items.length === 0 ? 0 : Math.min(a + 1, items.length - 1)));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      items[active]?.run();
    }
  }

  const isSearching =
    lookupEnabled &&
    (runs.isFetching || humanTasks.isFetching || principals.isFetching || scenarios.isFetching || credentials.isFetching);
  const hasLookupError =
    lookupEnabled && (runs.isError || humanTasks.isError || principals.isError || scenarios.isError || credentials.isError);
  const emptyMessage = isSearching
    ? "검색 중…"
    : hasLookupError
      ? "일부 결과를 불러오지 못했습니다."
    : q.length > 0 && q.length < MIN_ENTITY_QUERY_LENGTH
      ? "조금 더 입력해 주세요."
      : "불러온 결과에서 찾지 못했습니다.";

  return (
    <div
      className="palette-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="palette" role="dialog" aria-modal="true" aria-label="전역 검색 및 화면 이동" onKeyDown={onKeyDown}>
        <input
          ref={inputRef}
          className="palette-input"
          type="text"
          role="combobox"
          aria-expanded={true}
          aria-autocomplete="list"
          aria-controls="palette-list"
          aria-activedescendant={items[active] !== undefined ? `palette-opt-${active}` : undefined}
          placeholder="화면 이동 또는 자동화 이름 검색…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
        />
        <ul className="palette-list" id="palette-list" role="listbox" aria-label="검색 결과">
          {items.length === 0 ? (
            <li className="palette-empty">{emptyMessage}</li>
          ) : (
            items.map((item, i) => (
              <li
                key={item.id}
                id={`palette-opt-${i}`}
                role="option"
                aria-selected={i === active}
                className={`palette-item${i === active ? " active" : ""}`}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  item.run();
                }}
              >
                <span className="palette-item-label">{item.label}</span>
                <span className="palette-item-hint subtle">
                  {item.group} · {item.hint}
                </span>
              </li>
            ))
          )}
        </ul>
      </div>
    </div>
  );
}
