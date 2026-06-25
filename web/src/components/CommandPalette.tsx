import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useQuery } from "@tanstack/react-query";

import type { ApiClient } from "../api/client";
import { useApiClient } from "../api/context";
import { VIEW_KEYS, navigate } from "../router";
import { VIEW_META } from "../views/meta";
import type { ScenarioItem } from "../api/types";

interface PaletteItem {
  readonly id: string;
  readonly group: string;
  readonly label: string;
  readonly hint: string;
  readonly run: () => void;
}

// 팔레트 검색용 시나리오 — 최신순 최대 500(클라 필터, Orchestration picker 와 동형). 500 초과 테넌트는 일부만 매칭될 수 있다.
async function listPaletteScenarios(api: ApiClient): Promise<readonly ScenarioItem[]> {
  let cursor: string | undefined;
  const items: ScenarioItem[] = [];
  for (let page = 0; page < 10; page += 1) {
    const result = await api.listScenarios({ limit: 50, ...(cursor !== undefined ? { cursor } : {}) });
    items.push(...result.items);
    if (result.next_cursor === null) break;
    cursor = result.next_cursor;
  }
  return items;
}

// 전역 커맨드 팔레트(Ctrl/⌘+K) — 18개 화면 이동 + 자동화 이름 검색. 입력 포커스 유지 + ↑↓ 하이라이트
// (aria-activedescendant), Enter 실행, Esc·배경 클릭 닫기. 열기 직전 포커스를 닫을 때 복원한다(접근성).
export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }): JSX.Element | null {
  const api = useApiClient();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  const scenarios = useQuery({
    queryKey: ["palette-scenarios"],
    queryFn: () => listPaletteScenarios(api),
    enabled: open,
    staleTime: 30_000,
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
    const q = query.trim().toLowerCase();
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
    const scenarioItems: PaletteItem[] =
      q === ""
        ? []
        : (scenarios.data ?? [])
            .filter((s) => s.name.toLowerCase().includes(q))
            .slice(0, 8)
            .map((s) => ({
              id: `scenario:${s.scenario_id}`,
              group: "자동화",
              label: s.name,
              hint: `자동화 만들기로 이동 · 변경 ${s.version}`,
              run: () => {
                navigate("scenarioStudio");
                onClose();
              },
            }));
    return [...views, ...scenarioItems];
  }, [query, scenarios.data, onClose]);

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
      setActive((a) => Math.min(a + 1, items.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      items[active]?.run();
    }
  }

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
            <li className="palette-empty">{scenarios.isFetching ? "검색 중…" : "일치하는 항목이 없습니다."}</li>
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
