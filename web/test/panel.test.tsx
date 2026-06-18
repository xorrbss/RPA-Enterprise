import { describe, expect, test } from "vitest";
import { render, screen } from "@testing-library/react";

import { Panel } from "../src/components/Panel";

// F2 — 중복 Panel을 단일 컴포넌트로 추출. props를 그대로 통과시키는지(값 생성 없음)만 단위 검증.
// OpenGate/Idempotency의 통합 회귀는 기존 smoke.test가 커버하므로 여기선 중복 단언하지 않는다.
describe("Panel 컴포넌트(F2 추출)", () => {
  test("title은 heading, subtitle 보조 텍스트, children 본문을 렌더", () => {
    render(
      <Panel title="제목" subtitle="부제">
        <p>본문</p>
      </Panel>,
    );
    expect(screen.getByRole("heading", { name: "제목" })).toBeInTheDocument();
    expect(screen.getByText("부제")).toBeInTheDocument();
    expect(screen.getByText("본문")).toBeInTheDocument();
  });

  test("subtitle 미지정 시 보조 스팬을 렌더하지 않음(조용한 빈 노드 금지)", () => {
    const { container } = render(
      <Panel title="제목">
        <p>본문</p>
      </Panel>,
    );
    const head = container.querySelector(".panel-head");
    expect(head).not.toBeNull();
    // 헤더에는 h2만 — 빈 보조 스팬이 생기지 않음.
    expect(head!.querySelectorAll("span")).toHaveLength(0);
  });

  test("right 슬롯 지정 시 헤더에 렌더(Placeholder '준비 중' 배지 경로 보호)", () => {
    render(
      <Panel title="제목" right={<span className="badge muted">준비 중</span>}>
        <p>본문</p>
      </Panel>,
    );
    expect(screen.getByText("준비 중")).toBeInTheDocument();
  });
});
