import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { App } from "../src/App";
import { ApiClientProvider } from "../src/api/context";
import { fakeClient } from "./fake-client";

const originalMatchMedia = window.matchMedia;

function jwt(roles: readonly string[]): string {
  const payload = btoa(JSON.stringify({ sub: "u", tenant_id: "t", roles }))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `e30.${payload}.sig`;
}

type MediaListener = (event: MediaQueryListEvent) => void;

function installMatchMedia(matches: boolean): { setMatches: (next: boolean) => void } {
  let currentMatches = matches;
  const records: Array<{
    media: string;
    listeners: Set<MediaListener>;
    onchange: MediaListener | null;
  }> = [];
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: vi.fn().mockImplementation((query: string) => {
      const record: {
        media: string;
        listeners: Set<MediaListener>;
        onchange: MediaListener | null;
      } = { media: query, listeners: new Set<MediaListener>(), onchange: null };
      records.push(record);
      return {
        get matches() {
          return currentMatches;
        },
        media: query,
        get onchange() {
          return record.onchange;
        },
        set onchange(listener: MediaListener | null) {
          record.onchange = listener;
        },
        addEventListener: vi.fn((type: string, listener: MediaListener) => {
          if (type === "change") record.listeners.add(listener);
        }),
        removeEventListener: vi.fn((type: string, listener: MediaListener) => {
          if (type === "change") record.listeners.delete(listener);
        }),
        addListener: vi.fn((listener: MediaListener) => record.listeners.add(listener)),
        removeListener: vi.fn((listener: MediaListener) => record.listeners.delete(listener)),
        dispatchEvent: vi.fn(() => true),
      } as unknown as MediaQueryList;
    }),
  });
  return {
    setMatches(next: boolean): void {
      currentMatches = next;
      for (const record of records) {
        const event = { matches: next, media: record.media } as MediaQueryListEvent;
        record.onchange?.(event);
        for (const listener of record.listeners) listener(event);
      }
    },
  };
}

function renderApp(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ApiClientProvider client={fakeClient()}>
        <App />
      </ApiClientProvider>
    </QueryClientProvider>,
  );
}

function drawerNavItemCount(dialog: HTMLElement): number {
  return dialog.querySelectorAll(".nav-item").length;
}

const OPERATOR_STANDARD_NAV_ITEM_COUNT = 10;

describe("mobile drawer navigation", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    installMatchMedia(true);
    location.hash = "";
    localStorage.removeItem("rpa.nav.mode");
    localStorage.setItem("rpa.token", jwt(["operator"]));
  });

  afterEach(() => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: originalMatchMedia,
    });
    vi.unstubAllEnvs();
  });

  test("mobile renders a menu trigger instead of an expanded sidebar", () => {
    renderApp();
    const menu = screen.getByRole("button", { name: "메뉴" });
    expect(menu).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("navigation", { name: "주 메뉴" })).toBeNull();
    expect(document.querySelector(".sidebar")).toHaveAttribute("aria-hidden", "true");
    expect(screen.queryByRole("dialog", { name: "주 메뉴" })).toBeNull();
  });

  test("mobile folds account and role controls into an account menu", () => {
    renderApp();

    expect(screen.queryByLabelText("현재 접속 계정 u")).toBeNull();
    expect(screen.queryByText("운영자")).toBeNull();
    const account = screen.getByRole("button", { name: "계정 메뉴" });
    expect(account).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(account);

    expect(account).toHaveAttribute("aria-expanded", "true");
    const panel = screen.getByRole("region", { name: "계정 및 역할" });
    expect(within(panel).getByLabelText("현재 접속 계정 u")).toBeInTheDocument();
    expect(within(panel).getByText("운영자")).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "로그아웃" })).toBeInTheDocument();

    fireEvent.keyDown(account.parentElement as HTMLElement, { key: "Escape" });
    expect(screen.queryByRole("region", { name: "계정 및 역할" })).toBeNull();
    expect(account).toHaveAttribute("aria-expanded", "false");
  });

  test("opening drawer closes the account menu", () => {
    renderApp();

    fireEvent.click(screen.getByRole("button", { name: "계정 메뉴" }));
    expect(screen.getByRole("region", { name: "계정 및 역할" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "메뉴" }));

    expect(screen.queryByRole("region", { name: "계정 및 역할" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "주 메뉴" })).toBeInTheDocument();
  });

  test("drawer opens with role-filtered nav", () => {
    renderApp();
    const menu = screen.getByRole("button", { name: "메뉴" });
    fireEvent.click(menu);

    const dialog = screen.getByRole("dialog", { name: "주 메뉴" });
    expect(menu).toHaveAttribute("aria-expanded", "true");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(within(dialog).getByRole("navigation", { name: "모바일 주 메뉴" })).toBeInTheDocument();
    expect(drawerNavItemCount(dialog)).toBe(OPERATOR_STANDARD_NAV_ITEM_COUNT);
    expect(within(dialog).getByRole("button", { name: "도입 증빙" })).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Product-open 점검" })).toBeNull();
    expect(within(dialog).queryByRole("button", { name: "보안/개인정보" })).toBeNull();
  });

  test("drawer closes when viewport leaves mobile navigation", async () => {
    const media = installMatchMedia(true);
    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "메뉴" }));
    expect(screen.getByRole("dialog", { name: "주 메뉴" })).toBeInTheDocument();

    act(() => media.setMatches(false));

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "주 메뉴" })).toBeNull());
    expect(screen.getByRole("navigation", { name: "주 메뉴" })).toBeInTheDocument();
  });

  test("hidden direct URL renders the view but stays out of the mobile drawer", () => {
    location.hash = "#idempotency";
    renderApp();
    expect(screen.getByRole("heading", { level: 1, name: "중복 방지" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "메뉴" }));
    const dialog = screen.getByRole("dialog", { name: "주 메뉴" });

    expect(within(dialog).queryByRole("button", { name: "중복 방지" })).toBeNull();
    expect(drawerNavItemCount(dialog)).toBe(OPERATOR_STANDARD_NAV_ITEM_COUNT);
    expect(within(dialog).getByRole("button", { name: "도입 증빙" })).toBeInTheDocument();
  });

  test("Escape closes drawer and restores focus", async () => {
    renderApp();
    const menu = screen.getByRole("button", { name: "메뉴" });
    menu.focus();
    fireEvent.click(menu);
    const dialog = screen.getByRole("dialog", { name: "주 메뉴" });

    fireEvent.keyDown(dialog, { key: "Escape" });

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "주 메뉴" })).toBeNull());
    expect(menu).toHaveFocus();
    expect(menu).toHaveAttribute("aria-expanded", "false");
  });

  test("backdrop click closes drawer", async () => {
    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "메뉴" }));
    const dialog = screen.getByRole("dialog", { name: "주 메뉴" });
    const backdrop = dialog.parentElement;
    expect(backdrop).not.toBeNull();

    fireEvent.mouseDown(backdrop as HTMLElement);

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "주 메뉴" })).toBeNull());
  });

  test("selecting a drawer menu item closes drawer and navigates", async () => {
    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "메뉴" }));
    const dialog = screen.getByRole("dialog", { name: "주 메뉴" });
    fireEvent.click(within(dialog).getByRole("button", { name: "실행 기록" }));

    await waitFor(() => expect(location.hash).toBe("#runTrace"));
    expect(screen.queryByRole("dialog", { name: "주 메뉴" })).toBeNull();
  });
});
