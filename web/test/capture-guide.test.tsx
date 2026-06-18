import { describe, expect, test } from "vitest";
import { render, screen } from "@testing-library/react";

import { CaptureGuide } from "../src/components/CaptureGuide";
import type { SiteItem } from "../src/api/types";

// P3.3 — 운영자-로컬 캡처 안내 모달. 핵심 불변: **토큰을 화면/명령에 임베드하지 않는다**(플레이스홀더만);
// 명령은 실 플래그(--api/--site)를 정확히 안내; 정보 전용(확인 버튼 없음, 닫기만).
const site = {
  site_profile_id: "70000000-0000-0000-0000-000000000abc",
  name: "하이웍스",
  login_capable: true,
} as unknown as SiteItem;

describe("CaptureGuide (P3.3 운영자-로컬 캡처 안내)", () => {
  test("명령은 --api/--site 실 플래그 + 토큰 env 플레이스홀더를 안내", () => {
    const { container } = render(<CaptureGuide site={site} onClose={() => {}} />);
    const text = container.textContent ?? "";
    expect(text).toContain("--site 70000000-0000-0000-0000-000000000abc");
    expect(text).toContain("--api");
    expect(text).toContain("RPA_OPERATOR_TOKEN=<본인 운영자 토큰>");
  });

  test("보안 불변: 실 토큰(JWT)을 임베드하지 않는다 — 플레이스홀더만, 경고 노출", () => {
    const { container } = render(<CaptureGuide site={site} onClose={() => {}} />);
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/eyJ[A-Za-z0-9_-]/); // JWT(base64 헤더) 미포함
    expect(text).toContain("토큰을 직접 적지 마세요");
  });

  test("정보 전용 모달 — 제목에 사이트명, 닫기만(확인 버튼 없음)", () => {
    render(<CaptureGuide site={site} onClose={() => {}} />);
    expect(screen.getByRole("heading", { name: /하이웍스/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "닫기" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "확인" })).toBeNull();
  });
});
