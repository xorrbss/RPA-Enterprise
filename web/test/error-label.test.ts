import { describe, expect, test } from "vitest";

import { errorLabel, errorCodeLabel } from "../src/components/badges";
import { ApiError } from "../src/api/types";

// errorLabel: 8곳 raw enum 덤프 통일. 라벨은 계약 ts/error-catalog.ts ERROR_CATALOG[code].userMessage를 글자 그대로
// 미러(badges.test의 StatusBadge 라벨 완전성 가드와 동형). web/tsconfig include가 src/test뿐이라 계약 ts 직접 import가
// 불가능 → 손-미러 + 이 완전성/드리프트 테스트가 정당한 유일 패턴(badges 선례).
describe("errorLabel — 계약 userMessage 미러 + raw 폴백", () => {
  // (a) 대표 코드 라벨 = 계약 verbatim(드리프트 가드).
  test.each([
    ["AUTHZ_FORBIDDEN", "권한이 없습니다."],
    ["SECRET_ACCESS_DENIED", "권한이 없습니다."],
    ["SCENARIO_VERSION_CONFLICT", "버전 충돌. 최신본을 다시 불러오세요."],
    ["POLICY_VERSION_CONFLICT", "정책 버전 충돌. 최신 정책을 다시 불러오세요."],
    ["RUN_NOT_FOUND", "실행을 찾을 수 없습니다."],
    ["RESOURCE_NOT_FOUND", "대상을 찾을 수 없습니다."],
    ["RUN_ALREADY_TERMINAL", "이미 종료된 실행입니다."],
    ["IR_SCHEMA_INVALID", "자동화 정의 오류."],
    ["IR_EXPRESSION_COMPILE_ERROR", "조건식 오류."],
    ["SITE_PROFILE_BLOCKED", "해당 사이트는 승인이 필요합니다."],
    ["CHALLENGE_UNRESOLVED", "추가 인증이 필요합니다."],
    ["RATE_BUDGET_EXCEEDED", "요청 한도 초과. 다음 윈도우에 처리됩니다."],
    ["LLM_CAPABILITY_MISMATCH", "모델 미지원 작업."],
  ])("code=%s → 계약 userMessage '%s'", (code, label) => {
    expect(errorLabel(new ApiError(400, code, null))).toBe(label);
  });

  // (b) 미매핑 코드 → raw code 폴백(조용한 공백 금지 가드).
  test("미매핑 ApiError 코드는 raw code로 폴백(빈칸/추정 금지)", () => {
    expect(errorLabel(new ApiError(418, "TOTALLY_UNKNOWN", null))).toBe("TOTALLY_UNKNOWN");
  });

  // (c) 비-ApiError 처리: fetch 실패(TypeError)는 비기술 한국어, 일반 Error는 message, 그 외는 '요청 실패'.
  test("TypeError → 네트워크 안내, 일반 Error → message, 비-Error → '요청 실패'", () => {
    expect(errorLabel(new TypeError("Failed to fetch"))).toBe("네트워크 연결을 확인해 주세요.");
    expect(errorLabel(new Error("x"))).toBe("x");
    expect(errorLabel("문자열")).toBe("요청 실패");
    expect(errorLabel(undefined)).toBe("요청 실패");
    expect(errorLabel(null)).toBe("요청 실패");
  });

  // correlation_id는 실 응답 필드(types.ts ApiErrorBody)가 있을 때만 부가(없는 추적ID 창작 금지).
  test("correlation_id 있으면 부가, 없으면 미부가", () => {
    const withCid = new ApiError(403, "AUTHZ_FORBIDDEN", { code: "AUTHZ_FORBIDDEN", correlation_id: "abc-123" });
    expect(errorLabel(withCid)).toBe("권한이 없습니다. (추적 abc-123)");
    const noCid = new ApiError(403, "AUTHZ_FORBIDDEN", { code: "AUTHZ_FORBIDDEN" });
    expect(errorLabel(noCid)).toBe("권한이 없습니다.");
  });

  // (d) 완전성/드리프트 가드: 운영자 표면 4xx 코드 집합이 전부 매핑돼 있어 raw code로 새지 않음(badges 완전성 가드 동형).
  const SURFACE_4XX = [
    "RUN_NOT_FOUND", "RESOURCE_NOT_FOUND", "RUN_ALREADY_TERMINAL", "RUN_ABORTED",
    "SCENARIO_VERSION_CONFLICT", "POLICY_VERSION_CONFLICT", "IR_SCHEMA_INVALID", "IR_EXPRESSION_COMPILE_ERROR",
    "SITE_PROFILE_BLOCKED", "SESSION_LOCKED", "CHALLENGE_UNRESOLVED", "RATE_BUDGET_EXCEEDED",
    "AUTHZ_FORBIDDEN", "UNAUTHENTICATED", "SECRET_ACCESS_DENIED", "LLM_CAPABILITY_MISMATCH", "HUMAN_TASK_EXPIRED",
  ] as const;
  test.each(SURFACE_4XX)("운영자 표면 코드 %s 라벨 존재(raw로 새지 않음)", (code) => {
    const out = errorLabel(new ApiError(400, code, null));
    expect(out).not.toBe(code); // 한국어 라벨로 치환됨
    expect(/[가-힣]/.test(out)).toBe(true);
  });
});

// errorCodeLabel: bare 에러 코드 문자열(failure_reason.code / exception.code 배지) → 한국어.
// errorLabel ApiError 분기와 동일 ERROR_LABELS 출처·동일 raw 폴백 규칙(실행 기록·단계 트레이스·대시보드 배지 배선).
describe("errorCodeLabel — bare 코드 문자열 라벨 + raw 폴백", () => {
  test.each([
    ["LLM_BUDGET_EXCEEDED", "처리 한도 초과."],
    ["SITE_CIRCUIT_OPEN", "일시적으로 수집이 중단되었습니다."],
    ["AUTHZ_FORBIDDEN", "권한이 없습니다."],
  ])("code=%s → %s", (code, label) => {
    expect(errorCodeLabel(code)).toBe(label);
  });

  test("미매핑 코드는 raw로 폴백(조용한 공백 금지)", () => {
    expect(errorCodeLabel("TOTALLY_UNKNOWN")).toBe("TOTALLY_UNKNOWN");
  });
});
