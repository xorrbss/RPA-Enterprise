import { render, screen, within } from "@testing-library/react";

import { StudioValidationStages } from "../src/components/StudioValidationStages";
import { VisualFlowCanvas } from "../src/components/VisualFlowCanvas";

describe("Studio product surfaces", () => {
  test("validation stages keep not_run separate from pass", () => {
    render(
      <StudioValidationStages
        stages={[
          {
            stage: "well_formed",
            status: "pass",
            reason_code: "canonical_ir_compile_passed",
            detail: "Canonical IR compile passed.",
          },
          {
            stage: "runnable",
            status: "not_run",
            reason_code: "runtime_readiness_not_run",
            detail: "Selector probes have not run.",
          },
        ]}
      />,
    );

    expect(screen.getByText("구조 검증")).toBeInTheDocument();
    expect(screen.getByText("실행 가능성")).toBeInTheDocument();
    expect(screen.getByText("통과")).toBeInTheDocument();
    expect(screen.getAllByText("미실행").length).toBeGreaterThanOrEqual(1);
  });

  test("visual canvas renders canonical IR as Studio nodes", () => {
    render(
      <VisualFlowCanvas
        ir={{
          meta: { name: "Invoice review", version: 1, studio_mode: "visual" },
          start: "open",
          nodes: {
            open: {
              what: [{ action: "navigate", url_ref: "entry_url" }],
              next: "review",
            },
            review: {
              next: {
                handler: "@human_task",
                input: { kind: "approval", assignee_role: "finance" },
                return_node: "call_api",
              },
            },
            call_api: {
              what: [{
                action: "api_call",
                url_ref: "ops_notification_url",
                args: { method: "POST", auth: { type: "secret_ref_bearer" } },
              }],
              terminal: "success",
            },
          },
        }}
      />,
    );

    expect(screen.getByText("Invoice review")).toBeInTheDocument();
    expect(screen.getAllByText("Navigate").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Human Task").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("API Call").length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText(/Bearer raw/)).toBeNull();
    expect(within(screen.getByLabelText("흐름 연결")).getByText("open")).toBeInTheDocument();
  });
});
