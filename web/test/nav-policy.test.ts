import { describe, expect, test } from "vitest";

import {
  getVisibleNavGroups,
  getVisibleViews,
  hasAdvancedNav,
  isViewVisible,
  type NavPolicyContext,
} from "../src/navPolicy";
import type { ViewKey } from "../src/router";

const flags = { showInternalOpenGate: false };
const internalFlags = { showInternalOpenGate: true };

function ctx(roles: readonly string[], mode: "standard" | "advanced" = "standard", showInternalOpenGate = false): NavPolicyContext {
  return { roles, mode, flags: showInternalOpenGate ? internalFlags : flags };
}

function visible(roles: readonly string[], mode: "standard" | "advanced" = "standard", showInternalOpenGate = false): readonly ViewKey[] {
  return getVisibleViews(ctx(roles, mode, showInternalOpenGate));
}

describe("Phase 15 nav policy", () => {
  test("viewer standard nav is read-only and compact", () => {
    expect(visible(["viewer"])).toEqual(["myWork", "dashboard", "humanTasks", "workitems", "runTrace"]);
  });

  test("operator standard nav exposes the Phase 15 eight-item IA", () => {
    expect(getVisibleNavGroups(ctx(["operator"]))).toEqual([
      { label: "내 작업", keys: ["myWork", "dashboard", "humanTasks", "workitems"] },
      { label: "만들기", keys: ["scenarioStudio", "playground"] },
      { label: "운영", keys: ["runTrace", "automationOps", "documentIdp"] },
    ]);
  });

  test("reviewer and approver standard nav stay role-scoped", () => {
    expect(visible(["reviewer"])).toEqual([
      "myWork",
      "dashboard",
      "humanTasks",
      "workitems",
      "approvalInbox",
      "scenarioStudio",
      "playground",
      "runTrace",
    ]);
    expect(visible(["approver"])).toEqual([
      "myWork",
      "dashboard",
      "humanTasks",
      "workitems",
      "approvalInbox",
      "scenarioStudio",
      "playground",
      "runTrace",
      "auditExplorer",
    ]);
  });

  test("admin sees management and diagnostic views, except internal open gate without flag", () => {
    expect(visible(["admin"])).toEqual([
      "myWork",
      "dashboard",
      "humanTasks",
      "workitems",
      "approvalInbox",
      "scenarioStudio",
      "playground",
      "runTrace",
      "automationOps",
      "documentIdp",
      "coePipeline",
      "connectorCatalog",
      "objectRepository",
      "irValidation",
      "auditExplorer",
      "llmGateway",
      "security",
      "idempotency",
    ]);
  });

  test("openGate requires the internal flag even for admin", () => {
    expect(isViewVisible("openGate", ctx(["admin"]))).toBe(false);
    expect(isViewVisible("openGate", ctx(["admin"], "standard", true))).toBe(true);
  });

  test("standard operator hides internal, admin, and demoted advanced screens", () => {
    const views = visible(["operator"]);
    for (const hidden of [
      "coePipeline",
      "connectorCatalog",
      "objectRepository",
      "irValidation",
      "security",
      "llmGateway",
      "idempotency",
      "openGate",
      "auditExplorer",
      "approvalInbox",
    ] as const) {
      expect(views).not.toContain(hidden);
    }
  });

  test("advanced operator adds allowed expert tools without exposing Product-open", () => {
    expect(hasAdvancedNav({ roles: ["operator"], flags })).toBe(true);
    const views = visible(["operator"], "advanced");
    expect(views).toEqual([
      "myWork",
      "dashboard",
      "humanTasks",
      "workitems",
      "scenarioStudio",
      "playground",
      "runTrace",
      "automationOps",
      "documentIdp",
      "coePipeline",
      "connectorCatalog",
      "objectRepository",
      "irValidation",
      "auditExplorer",
      "idempotency",
    ]);
    expect(views).not.toContain("openGate");
  });

  test("empty or unknown roles fall back to viewer-safe nav", () => {
    expect(visible([])).toEqual(visible(["viewer"]));
    expect(visible(["legacy-role"])).toEqual(visible(["viewer"]));
  });
});
