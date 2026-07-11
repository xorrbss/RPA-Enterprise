import { describe, expect, test } from "vitest";

import { errorLabel, errorCodeLabel, errorOperatorActionLabel } from "../src/components/badges";
import { ApiError } from "../src/api/types";

const SURFACE_ERROR_CODES = [
  "AI_GOVERNANCE_POLICY_BLOCKED",
  "RUN_NOT_FOUND",
  "RESOURCE_NOT_FOUND",
  "RUN_ALREADY_TERMINAL",
  "RUN_ABORTED",
  "SCENARIO_VERSION_CONFLICT",
  "POLICY_VERSION_CONFLICT",
  "IR_SCHEMA_INVALID",
  "IR_EXPRESSION_COMPILE_ERROR",
  "IR_EXPRESSION_RUNTIME",
  "IR_NO_BRANCH_MATCHED",
  "SITE_PROFILE_BLOCKED",
  "SITE_CIRCUIT_OPEN",
  "SESSION_LOCKED",
  "SESSION_GENERATION_CONFLICT",
  "SESSION_REGISTRATION_REQUIRED",
  "CHALLENGE_UNRESOLVED",
  "RATE_BUDGET_EXCEEDED",
  "BROWSER_LEASE_EXPIRED",
  "BROWSER_CRASH",
  "CDP_DISCONNECTED",
  "NAVIGATION_TIMEOUT",
  "LLM_BUDGET_EXCEEDED",
  "LLM_CAPABILITY_MISMATCH",
  "LLM_STREAM_TIMEOUT",
  "LLM_STREAM_IDLE_TIMEOUT",
  "LLM_MALFORMED_OUTPUT",
  "LLM_CONTENT_FILTERED",
  "LLM_RATE_LIMITED",
  "LLM_BACKEND_UNAVAILABLE",
  "LLM_CONNECTION_FAILED",
  "EXTRACT_SCHEMA_INVALID",
  "VERIFY_FAILED",
  "EMPTY_RESULT_NO_WITNESS",
  "SECRET_ACCESS_DENIED",
  "DOMAIN_POLICY_VIOLATION",
  "PROMPT_INJECTION_DETECTED",
  "ARTIFACT_NOT_REDACTED",
  "SHELL_COMMAND_NOT_ALLOWED",
  "UNAUTHENTICATED",
  "AUTHZ_FORBIDDEN",
  "CONNECTOR_PERMISSION_DENIED",
  "CONNECTOR_INCOMPATIBLE",
  "CONNECTOR_HOOK_FAILED",
  "SINK_DELIVERY_FAILED",
  "RAW_PERSIST_FAILED",
  "CONTROL_PLANE_INTERNAL_ERROR",
  "HUMAN_TASK_EXPIRED",
  "APPROVAL_ALREADY_DECIDED",
  "WORKITEM_CHECKOUT_CONFLICT",
  "DEAD_LETTER",
] as const;

// errorLabel: raw enum 덤프 통일. 라벨은 계약 ts/error-catalog.ts ERROR_CATALOG[code].userMessage를 기본값으로 삼되,
// 영어 계약 메시지는 S9 범위에서 web 표면용 한국어로 현지화한다. web/tsconfig include가 src/test뿐이라 계약 ts 직접
// import가 불가능 → 손-미러 + 이 완전성/드리프트 테스트가 정당한 유일 패턴(badges 선례).
describe("errorLabel — 운영자 표면 라벨 + raw 폴백", () => {
  // (a) 대표 코드 라벨 = 계약 userMessage 기반 + web 표면 현지화(드리프트 가드).
  test.each([
    ["AUTHZ_FORBIDDEN", "권한이 없습니다."],
    ["SECRET_ACCESS_DENIED", "권한이 없습니다."],
    ["SCENARIO_VERSION_CONFLICT", "버전 충돌. 최신본을 다시 불러오세요."],
    ["POLICY_VERSION_CONFLICT", "정책 버전 충돌. 최신 정책을 다시 불러오세요."],
    ["RUN_NOT_FOUND", "실행을 찾을 수 없습니다."],
    ["RESOURCE_NOT_FOUND", "대상을 찾을 수 없습니다."],
    ["RUN_ALREADY_TERMINAL", "이미 종료된 실행입니다."],
    ["IR_SCHEMA_INVALID", "시나리오 정의 오류."],
    ["IR_EXPRESSION_COMPILE_ERROR", "조건식 오류."],
    ["SITE_PROFILE_BLOCKED", "해당 사이트는 승인이 필요합니다."],
    ["CHALLENGE_UNRESOLVED", "추가 인증이 필요합니다."],
    ["RATE_BUDGET_EXCEEDED", "요청 한도 초과. 다음 윈도우에 처리됩니다."],
    ["LLM_CAPABILITY_MISMATCH", "모델 미지원 작업."],
    ["AI_GOVERNANCE_POLICY_BLOCKED", "AI 운영 정책으로 요청이 차단되었습니다."],
    ["NAVIGATION_TIMEOUT", "페이지 응답이 지연되어 재시도됩니다."],
    ["DEAD_LETTER", "수동 재처리 대기."],
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

  // details.reason 우선: 같은 code(IR_SCHEMA_INVALID)가 여러 도메인에서 재사용되므로 코드 라벨만 쓰면
  // AI 증빙 폼에 "시나리오 정의 오류"가 뜨는 등 원인이 사라진다. reason이 매핑되면 코드 라벨보다 우선한다.
  test("details.reason 매핑이 있으면 코드 라벨보다 우선한다(원인 은폐 금지)", () => {
    const missingAudit = new ApiError(422, "IR_SCHEMA_INVALID", {
      code: "IR_SCHEMA_INVALID",
      details: { reason: "valid_ai_governance_audit_correlation_required" },
    });
    expect(errorLabel(missingAudit)).toBe("유효 증빙에는 감사 추적 ID가 필요합니다.");

    const notFound = new ApiError(422, "IR_SCHEMA_INVALID", {
      code: "IR_SCHEMA_INVALID",
      details: { reason: "audit_correlation_not_found" },
      correlation_id: "cid-9",
    });
    expect(errorLabel(notFound)).toBe(
      "감사 추적 ID를 감사 기록에서 찾을 수 없습니다. 감사 이력 화면의 추적 번호를 사용하세요. (추적 cid-9)",
    );
  });

  test("미매핑 reason은 코드 라벨로 폴백(조용한 공백 금지)", () => {
    const unknownReason = new ApiError(422, "IR_SCHEMA_INVALID", {
      code: "IR_SCHEMA_INVALID",
      details: { reason: "totally_unknown_reason" },
    });
    expect(errorLabel(unknownReason)).toBe("시나리오 정의 오류.");
  });

  // correlation_id는 실 응답 필드(types.ts ApiErrorBody)가 있을 때만 부가(없는 추적ID 창작 금지).
  test("correlation_id 있으면 부가, 없으면 미부가", () => {
    const withCid = new ApiError(403, "AUTHZ_FORBIDDEN", { code: "AUTHZ_FORBIDDEN", correlation_id: "abc-123" });
    expect(errorLabel(withCid)).toBe("권한이 없습니다. (추적 abc-123)");
    const noCid = new ApiError(403, "AUTHZ_FORBIDDEN", { code: "AUTHZ_FORBIDDEN" });
    expect(errorLabel(noCid)).toBe("권한이 없습니다.");
  });

  // (d) 완전성/드리프트 가드: 운영자 표면 코드 집합이 전부 매핑돼 있어 raw code로 새지 않음(badges 완전성 가드 동형).
  test.each(SURFACE_ERROR_CODES)("운영자 표면 코드 %s 라벨 존재(raw로 새지 않음)", (code) => {
    const out = errorLabel(new ApiError(400, code, null));
    expect(out).not.toBe(code); // 한국어 라벨로 치환됨
    expect(/[가-힣]/.test(out)).toBe(true);
  });
});

// errorOperatorActionLabel: 계약 operatorAction은 내부용이지만 표면화될 때 raw 영문/jargon을 그대로 노출하지 않는다.
describe("errorOperatorActionLabel — 조치 안내 한국어 라벨 + raw 폴백", () => {
  test.each([
    ["NAVIGATION_TIMEOUT", "대상 사이트 응답, 로그인 세션, 네트워크 상태를 확인하세요."],
    ["LLM_RATE_LIMITED", "모델 호출 제한입니다. 백오프, 동시성, 예산을 확인하세요."],
    ["AI_GOVERNANCE_POLICY_BLOCKED", "AI 실행 정책과 모델·프롬프트·평가·비용 근거를 확인하세요(ai_runtime_policies)."],
    ["DEAD_LETTER", "실패 보관함(DLQ) 재처리 API를 확인하세요."],
  ])("code=%s → %s", (code, label) => {
    expect(errorOperatorActionLabel(code)).toBe(label);
  });

  test.each(SURFACE_ERROR_CODES)("운영자 표면 코드 %s 조치 안내 존재(raw로 새지 않음)", (code) => {
    const out = errorOperatorActionLabel(code);
    expect(out).not.toBe(code);
    expect(/[가-힣]/.test(out)).toBe(true);
  });

  test("미매핑 코드는 raw로 폴백(조용한 공백 금지)", () => {
    expect(errorOperatorActionLabel("TOTALLY_UNKNOWN")).toBe("TOTALLY_UNKNOWN");
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

// U3-2: 종결(터미널) 문맥 라벨 — 재시도 소진 후 배너/목록에서 "재시도됩니다" 미래형이 사실과 모순되지 않게
// 과거형+조치형으로 덮어쓴다. 비-터미널 표면과 미매핑 코드는 기존 규칙 그대로.
describe("errorCodeLabel terminal — 종결 문맥 미래형 재시도 문구 교체", () => {
  test.each([
    ["LLM_BACKEND_UNAVAILABLE"],
    ["BROWSER_CRASH"],
    ["CDP_DISCONNECTED"],
    ["VERIFY_FAILED"],
  ])("terminal code=%s → 미래형 '재시도됩니다' 미노출 + 조치형", (code) => {
    const label = errorCodeLabel(code, { terminal: true });
    expect(label).not.toBe("재시도됩니다.");
    expect(label).toMatch(/실패|종료|소진/);
    expect(label).toMatch(/다시 실행|확인/);
  });

  test("terminal 미지정 코드는 기본 라벨 유지(계약 userMessage 미러)", () => {
    expect(errorCodeLabel("LLM_BACKEND_UNAVAILABLE")).toBe("재시도됩니다.");
    expect(errorCodeLabel("SITE_CIRCUIT_OPEN", { terminal: true })).toBe("일시적으로 수집이 중단되었습니다.");
    expect(errorCodeLabel("TOTALLY_UNKNOWN", { terminal: true })).toBe("TOTALLY_UNKNOWN");
  });
});
