import { describe, expect, test } from "vitest";
import { render } from "@testing-library/react";

import { SiteCircuitNotice } from "../src/components/SiteCircuitNotice";

// 사이트 서킷 차단 안내: 차단 항목이 있을 때만 노출하고, 운영자어 가이드(자동 재개·강제 재개 콘솔 미제공)를 담는다.
describe("SiteCircuitNotice", () => {
  test("openCount 0 → 미표시(null, 조용한 빈 배너 금지)", () => {
    const { container } = render(<SiteCircuitNotice openCount={0} />);
    expect(container.querySelector("[role='status']")).toBeNull();
  });

  test("openCount>0 → 안내 표시(건수·자동 재개·강제 재개 콘솔 미제공)", () => {
    const { container } = render(<SiteCircuitNotice openCount={2} />);
    const el = container.querySelector("[role='status']");
    expect(el).not.toBeNull();
    expect(el?.textContent).toContain("2곳");
    expect(el?.textContent).toContain("자동으로 재개");
    expect(el?.textContent).toMatch(/강제 재개는 운영 정책/);
  });
});
