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
  // E1(§2.3): 기본(standard) 모드 = 만들기 콘솔 — 전 역할 create/humanTasks/runTrace/dashboard,
  // operator+ workitems·automationOps·documentIdp. scenarioStudio/adoptionEvidence/auditExplorer는 고급으로 강등.
  test("viewer standard nav is read-only and compact", () => {
    expect(visible(["viewer"])).toEqual(["myWork", "humanTasks", "create", "runTrace", "dashboard"]);
  });

  test("operator standard nav exposes the lifecycle IA (내 업무→자동화→현황)", () => {
    expect(getVisibleNavGroups(ctx(["operator"]))).toEqual([
      { label: "내 업무", keys: ["myWork", "humanTasks", "workitems"] },
      { label: "자동화", keys: ["create", "runTrace", "automationOps", "documentIdp"] },
      { label: "현황", keys: ["dashboard"] },
    ]);
  });

  test("reviewer and approver standard nav stay role-scoped", () => {
    // 결재 인박스 메뉴는 은퇴 — 결재 목록은 '사람 확인'의 소스 탭으로 흡수(별도 뷰키 없음).
    expect(visible(["reviewer"])).toEqual(["myWork", "humanTasks", "create", "runTrace", "dashboard"]);
    expect(visible(["approver"])).toEqual(["myWork", "humanTasks", "create", "runTrace", "dashboard"]);
  });

  test("admin sees management and diagnostic views, except internal open gate without flag", () => {
    expect(visible(["admin"])).toEqual([
      "myWork",
      "humanTasks",
      "workitems",
      "create",
      "runTrace",
      "automationOps",
      "documentIdp",
      "dashboard",
      "coePipeline",
      "connectorCatalog",
      "objectRepository",
      "llmGateway",
      "security",
    ]);
  });

  test("openGate requires the internal flag even for admin", () => {
    expect(isViewVisible("openGate", ctx(["admin"]))).toBe(false);
    expect(isViewVisible("openGate", ctx(["admin"], "standard", true))).toBe(true);
  });

  test("standard operator hides internal, admin, and demoted advanced screens", () => {
    const views = visible(["operator"]);
    for (const hidden of [
      "scenarioStudio",
      "adoptionEvidence",
      "auditExplorer",
      "coePipeline",
      "connectorCatalog",
      "objectRepository",
      "security",
      "llmGateway",
      "openGate",
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
      "humanTasks",
      "workitems",
      "create",
      "scenarioStudio",
      "runTrace",
      "automationOps",
      "documentIdp",
      "dashboard",
      "adoptionEvidence",
      "coePipeline",
      "connectorCatalog",
      "objectRepository",
      "auditExplorer",
    ]);
    expect(views).not.toContain("openGate");
  });

  test("empty or unknown roles fall back to viewer-safe nav", () => {
    expect(visible([])).toEqual(visible(["viewer"]));
    expect(visible(["legacy-role"])).toEqual(visible(["viewer"]));
  });
});
