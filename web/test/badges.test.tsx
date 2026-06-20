import { describe, expect, test } from "vitest";
import { render } from "@testing-library/react";

import { StatusBadge, statusLabel, kindLabel, terminalLabel } from "../src/components/badges";
import { RUN_STATES, WORKITEM_STATES, HUMANTASK_STATES, HUMANTASK_KINDS, SITE_RISKS } from "../src/views/filters";

// RQ-012: StatusBadge가 raw enum 대신 비기술 한국어 라벨을 렌더하는가(색 tone은 별도 검증).
describe("StatusBadge 한국어 라벨", () => {
  test.each([
    ["running", "실행 중", "blue"],
    ["completed", "완료", "green"],
    ["cancelled", "취소됨", "muted"],
    ["failed_system", "시스템 실패", "red"],
    ["failed_business", "업무 실패", "red"],
    ["abandoned", "포기", "red"],
    ["escalated", "상위 이관", "amber"],
    ["resolved", "해소됨", "green"],
    ["red", "높음", "red"],
    ["approved", "승인됨", "green"],
    ["half_open", "점검 중", "amber"],
  ])("status=%s → 라벨 %s + tone %s", (status, label, toneClass) => {
    const { container } = render(<StatusBadge status={status} />);
    const el = container.querySelector("span.badge");
    expect(el?.textContent).toBe(label);
    expect(el?.className).toContain(toneClass);
  });

  test("미매핑 값은 raw로 폴백(조용한 공백 금지)", () => {
    const { container } = render(<StatusBadge status="totally_unknown" />);
    const el = container.querySelector("span.badge");
    expect(el?.textContent).toBe("totally_unknown");
  });

  // RQ-026: "open"이 도메인별로 다른 tone — HumanTask open(열림)=중립(blue), circuit open=경보(red).
  // 이전엔 RED·BLUE 양쪽에 "open"이 있어 RED 우선 → HumanTask 열림이 실패색으로 오인 렌더.
  test("HumanTask open(열림) → blue (실패색 아님)", () => {
    const { container } = render(<StatusBadge status="open" />);
    const el = container.querySelector("span.badge");
    expect(el?.textContent).toBe("열림");
    expect(el?.className).toContain("blue");
    expect(el?.className).not.toContain("red");
  });

  test("circuit open → red (kind=circuit 경보)", () => {
    const { container } = render(<StatusBadge status="open" kind="circuit" />);
    const el = container.querySelector("span.badge");
    expect(el?.textContent).toBe("열림");
    expect(el?.className).toContain("red");
  });

  // 완전성 가드: StatusBadge로 흐르는 닫힌 enum은 전부 라벨이 있어야 한다(향후 enum 추가 시 실패).
  test.each([
    ...RUN_STATES,
    ...WORKITEM_STATES,
    ...HUMANTASK_STATES,
    ...SITE_RISKS,
  ])("enum %s 라벨 존재(raw로 새지 않음)", (status) => {
    const { container } = render(<StatusBadge status={status} />);
    const text = container.querySelector("span.badge")?.textContent ?? "";
    expect(text).not.toBe(status); // 한국어 라벨로 치환됨
    expect(/[가-힣]/.test(text)).toBe(true);
  });
});

// 필터 드롭다운이 raw enum 대신 쓰는 공용 접근자(StatusBadge와 동일 STATUS_LABELS 출처) — 라벨 배선 가드.
describe("statusLabel / kindLabel — 필터 드롭다운 한국어 라벨", () => {
  test.each([
    ["queued", "대기"],
    ["failed_system", "시스템 실패"],
    ["abandoned", "포기"],
    ["green", "낮음"],
    ["red", "높음"],
  ])("statusLabel(%s) → %s", (s, label) => {
    expect(statusLabel(s)).toBe(label);
  });

  test("statusLabel 미매핑 값은 raw로 폴백(조용한 공백 금지)", () => {
    expect(statusLabel("totally_unknown")).toBe("totally_unknown");
  });

  // 완전성: 상태/위험도 필터 enum 전부 한국어로 치환(raw로 새지 않음).
  test.each([...RUN_STATES, ...WORKITEM_STATES, ...HUMANTASK_STATES, ...SITE_RISKS])(
    "statusLabel 필터 enum %s 라벨 존재",
    (v) => {
      expect(statusLabel(v)).not.toBe(v);
      expect(/[가-힣]/.test(statusLabel(v))).toBe(true);
    },
  );

  // 완전성: 사람 확인 '종류' 필터 enum은 kindLabel이 담당 — 전부 한국어.
  test.each([...HUMANTASK_KINDS])("kindLabel 필터 enum %s 라벨 존재", (k) => {
    expect(kindLabel(k)).not.toBe(k);
    expect(/[가-힣]/.test(kindLabel(k))).toBe(true);
  });
});

// R3: IR terminal 라벨 단일 출처(StepBuilder raw enum 노출·Playground 지역맵 드리프트 제거).
// 출처: schema/ir.schema.json terminal.enum(4값). error-label/StatusBadge 완전성-가드 패턴 복제.
describe("terminalLabel — IR terminal 한국어 라벨", () => {
  test.each([
    ["success", "성공"],
    ["success_empty", "성공(데이터 없음)"],
    ["fail_business", "업무 실패"],
    ["fail_system", "시스템 실패"],
  ])("terminal=%s → %s", (t, label) => {
    expect(terminalLabel(t)).toBe(label);
  });

  test("미매핑 값은 raw로 폴백(조용한 공백 금지)", () => {
    expect(terminalLabel("weird")).toBe("weird");
  });

  // 완전성/드리프트 가드: StepBuilder TERMINALS(빌더 생성-목록 SSoT)의 손-미러.
  // web tsconfig가 계약 ts/json import 불가하므로 filters enum 미러와 동일 정당성 — enum 확장 시 실패=계약-web 드리프트 차단.
  const TERMINALS = ["success", "success_empty", "fail_business", "fail_system"] as const;
  test.each(TERMINALS)("TERMINALS %s 라벨 존재(raw로 새지 않음)", (t) => {
    const label = terminalLabel(t);
    expect(label).not.toBe(t); // 한국어 라벨로 치환됨
    expect(/[가-힣]/.test(label)).toBe(true);
  });
});
