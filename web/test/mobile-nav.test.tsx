import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

function installMatchMedia(matches: boolean): void {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
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

  test("drawer opens with role-filtered nav", () => {
    renderApp();
    const menu = screen.getByRole("button", { name: "메뉴" });
    fireEvent.click(menu);

    const dialog = screen.getByRole("dialog", { name: "주 메뉴" });
    expect(menu).toHaveAttribute("aria-expanded", "true");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(within(dialog).getByRole("navigation", { name: "모바일 주 메뉴" })).toBeInTheDocument();
    expect(drawerNavItemCount(dialog)).toBe(8);
    expect(within(dialog).queryByRole("button", { name: "Product-open 점검" })).toBeNull();
    expect(within(dialog).queryByRole("button", { name: "보안/개인정보" })).toBeNull();
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
