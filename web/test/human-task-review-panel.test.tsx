import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, test } from "vitest";

import { HumanTaskReviewPanel } from "../src/components/HumanTaskReviewPanel";
import type { HumanTaskItem } from "../src/api/types";
import { fakeClient } from "./fake-client";

function jwt(roles: readonly string[]): string {
  const payload = btoa(JSON.stringify({ sub: "reviewer-a", tenant_id: "tenant-a", roles }))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `header.${payload}.sig`;
}

function task(overrides: Partial<HumanTaskItem>): HumanTaskItem {
  return {
    human_task_id: "ht-1",
    state: "in_progress",
    kind: "validation",
    assignee: "reviewer-a",
    timeout: null,
    on_timeout: "retry",
    run_id: null,
    payload: { invoice_id: "INV-1" },
    result_schema: null,
    artifact_refs: [],
    result: null,
    ...overrides,
  };
}

describe("HumanTaskReviewPanel", () => {
  beforeEach(() => {
    localStorage.setItem("rpa.token", jwt(["reviewer"]));
  });

  test("resets decision and correction state when the selected task changes", async () => {
    const first = task({
      human_task_id: "ht-first",
      result: {
        decision: "reject",
        corrections: { total: "1000" },
        reason: "bad extraction",
        confidence: 0.42,
        notes: "check source",
      },
    });
    const second = task({ human_task_id: "ht-second", result: null });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const api = fakeClient();
    const view = render(
      <QueryClientProvider client={qc}>
        <HumanTaskReviewPanel api={api} task={first} />
      </QueryClientProvider>,
    );

    expect(await screen.findByRole("combobox")).toHaveValue("reject");
    expect(screen.getByDisplayValue("total")).toBeInTheDocument();
    expect(screen.getByDisplayValue("1000")).toBeInTheDocument();

    view.rerender(
      <QueryClientProvider client={qc}>
        <HumanTaskReviewPanel api={api} task={second} />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(screen.getByRole("combobox")).toHaveValue("approve"));
    expect(screen.queryByDisplayValue("total")).toBeNull();
    expect(screen.queryByDisplayValue("1000")).toBeNull();
  });
});
