import { describe, expect, test } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";

import { SlideOver } from "../src/components/SlideOver";

// 비모달 사이드 드로어 포커스 관리: 열 때 패널 진입·Escape 닫기·닫을 때 트리거로 복원.
// 트랩은 검증하지 않는다(의도적 부재 — 비모달이라 Tab은 패널 밖으로 나갈 수 있어야 함).
function Harness(): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        열기
      </button>
      {open && (
        <SlideOver title="상세 — abc12345" onClose={() => setOpen(false)}>
          <button type="button">내부 동작</button>
        </SlideOver>
      )}
    </>
  );
}

describe("SlideOver 비모달 드로어 a11y 포커스", () => {
  test("열 때 패널로 포커스 진입", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "열기" }));
    const region = screen.getByRole("region", { name: "상세" });
    expect(document.activeElement).toBe(region); // 열기 시 패널이 포커스를 받음(SR이 영역 라벨 읽음)
  });

  test("Escape로 닫힘", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "열기" }));
    const region = screen.getByRole("region", { name: "상세" });
    fireEvent.keyDown(region, { key: "Escape" });
    expect(screen.queryByRole("region", { name: "상세" })).toBeNull();
  });

  test("닫을 때 트리거 버튼으로 포커스 복원", () => {
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "열기" });
    trigger.focus(); // 실제 클릭 포커스를 모사(직전 포커스 = 트리거)
    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole("region", { name: "상세" }), { key: "Escape" });
    expect(document.activeElement).toBe(trigger); // 언마운트 시 트리거로 복원
  });

  test("'닫기' 버튼 클릭으로도 닫힘(기존 동작 보존)", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "열기" }));
    fireEvent.click(screen.getByRole("button", { name: "닫기" }));
    expect(screen.queryByRole("region", { name: "상세" })).toBeNull();
  });
});
