/**
 * Error Catalog v1 (리뷰 #13)
 * 단일 진실원천. API 응답·내부 예외·운영 알림이 모두 이 코드를 참조.
 * 각 코드는 retryable / httpStatus / exceptionClass / userMessage / operatorAction 메타를 가진다.
 */

export type ExceptionClass =
  | "business" | "system" | "challenge" | "security" | "none";

export type ErrorCode =
  // --- Run / Scenario ---
  | "RUN_NOT_FOUND"
  | "RESOURCE_NOT_FOUND"                // run 외 엔티티(scenario/workitem/human_task/artifact/site) 미존재
  | "RUN_ALREADY_TERMINAL"
  | "RUN_ABORTED"
  | "SCENARIO_VERSION_CONFLICT"        // optimistic concurrency (If-Match)
  | "POLICY_VERSION_CONFLICT"          // gateway/network policy optimistic concurrency (If-Match)
  | "IR_SCHEMA_INVALID"
  | "IR_EXPRESSION_COMPILE_ERROR"      // IREL 컴파일 실패 → 저장 거부
  | "IR_EXPRESSION_RUNTIME"            // IREL 런타임(scope missing) → system
  | "IR_NO_BRANCH_MATCHED"             // on[] 런타임 전 분기 false(무매칭) → system(재시도)
  // --- Site Access / Session / Challenge ---
  | "SITE_PROFILE_BLOCKED"             // risk=red 미승인
  | "SITE_CIRCUIT_OPEN"
  | "SESSION_LOCKED"                   // credential/session lease 경합
  | "SESSION_GENERATION_CONFLICT"
  | "CHALLENGE_UNRESOLVED"
  | "RATE_BUDGET_EXCEEDED"             // 도메인 일일 예산 초과
  // --- Browser / Lease ---
  | "BROWSER_LEASE_EXPIRED"
  | "BROWSER_CRASH"
  | "CDP_DISCONNECTED"
  // --- LLM Gateway ---
  | "LLM_BUDGET_EXCEEDED"
  | "LLM_CAPABILITY_MISMATCH"
  | "LLM_STREAM_TIMEOUT"
  | "LLM_STREAM_IDLE_TIMEOUT"
  | "LLM_MALFORMED_OUTPUT"
  | "LLM_CONTENT_FILTERED"
  | "LLM_RATE_LIMITED"                  // adapter RATE_LIMIT 재시도 소진
  | "LLM_BACKEND_UNAVAILABLE"           // adapter BACKEND_ERROR(5xx) 재시도 소진
  | "LLM_CONNECTION_FAILED"             // adapter CONNECTION_FAILED 재시도/fallback 소진
  // --- Extract / Verify ---
  | "EXTRACT_SCHEMA_INVALID"           // business
  | "VERIFY_FAILED"
  | "EMPTY_RESULT_NO_WITNESS"          // 빈 결과인데 witness 없음 → business
  // --- Secret / Security ---
  | "SECRET_ACCESS_DENIED"
  | "DOMAIN_POLICY_VIOLATION"          // 허용 도메인 이탈
  | "PROMPT_INJECTION_DETECTED"        // hidden instruction
  | "ARTIFACT_NOT_REDACTED"
  | "SHELL_COMMAND_NOT_ALLOWED"        // shell cmd_ref가 signed command registry 미등록
  | "UNAUTHENTICATED"                  // 인증 미성립(Bearer 토큰 누락/서명 무효) — authn 실패(auth-rbac.md §3)
  | "AUTHZ_FORBIDDEN"                  // 역할 권한 부족(일반 RBAC 거부 — auth-rbac.md §2)
  // --- Connector ---
  | "CONNECTOR_PERMISSION_DENIED"
  | "CONNECTOR_INCOMPATIBLE"           // runtime/ir version mismatch
  | "CONNECTOR_HOOK_FAILED"
  // --- Pipeline / Sink ---
  | "SINK_DELIVERY_FAILED"
  | "RAW_PERSIST_FAILED"
  | "CONTROL_PLANE_INTERNAL_ERROR"
  // --- Human Task ---
  | "HUMAN_TASK_EXPIRED"
  // --- Approval (건별 결재 decide) ---
  | "APPROVAL_ALREADY_DECIDED"          // (tenant, source_run, doc_ref) 이미 결재됨 → 이중결재 방지(409, 비-retryable)
  // --- Queue ---
  | "WORKITEM_CHECKOUT_CONFLICT"
  | "DEAD_LETTER";

export interface ErrorMeta {
  retryable: boolean;
  httpStatus: number;
  exceptionClass: ExceptionClass;
  userMessage: string;       // 외부 노출(민감정보 없음)
  operatorAction: string;    // 운영자 가이드(내부)
}

export const ERROR_CATALOG: Record<ErrorCode, ErrorMeta> = {
  RUN_NOT_FOUND:               { retryable: false, httpStatus: 404, exceptionClass: "none",     userMessage: "실행을 찾을 수 없습니다.", operatorAction: "run_id 확인" },
  RESOURCE_NOT_FOUND:          { retryable: false, httpStatus: 404, exceptionClass: "none",     userMessage: "대상을 찾을 수 없습니다.", operatorAction: "리소스 id/종류 확인(api-surface.md)" },
  RUN_ALREADY_TERMINAL:        { retryable: false, httpStatus: 409, exceptionClass: "none",     userMessage: "이미 종료된 실행입니다.", operatorAction: "상태 확인 후 새 실행" },
  // [FIX] 어휘 통일: API 명령=abort → Run 상태=cancelled → 이벤트=run.cancelled.
  //   RUN_ABORTED는 "이미 중단(취소)된 run에 대한 작업 거부" 의미. UI 문구는 "취소됨"으로 통일 권고.
  RUN_ABORTED:                 { retryable: false, httpStatus: 409, exceptionClass: "none",     userMessage: "실행이 중단되었습니다.", operatorAction: "-" },
  SCENARIO_VERSION_CONFLICT:   { retryable: false, httpStatus: 412, exceptionClass: "none",     userMessage: "버전 충돌. 최신본을 다시 불러오세요.", operatorAction: "If-Match 재시도" },
  POLICY_VERSION_CONFLICT:     { retryable: false, httpStatus: 412, exceptionClass: "none",     userMessage: "정책 버전 충돌. 최신 정책을 다시 불러오세요.", operatorAction: "gateway_policies.version If-Match 재시도" },
  IR_SCHEMA_INVALID:           { retryable: false, httpStatus: 422, exceptionClass: "business", userMessage: "시나리오 정의 오류.", operatorAction: "IR 스키마 검증 로그 확인" },
  IR_EXPRESSION_COMPILE_ERROR: { retryable: false, httpStatus: 422, exceptionClass: "business", userMessage: "조건식 오류.", operatorAction: "IREL 컴파일 에러 위치 확인" },
  IR_EXPRESSION_RUNTIME:       { retryable: true,  httpStatus: 500, exceptionClass: "system",   userMessage: "일시 오류.", operatorAction: "선행 노드 skip 여부 확인" },
  IR_NO_BRANCH_MATCHED:        { retryable: true,  httpStatus: 500, exceptionClass: "system",   userMessage: "일시 오류.", operatorAction: "on[] 분기 조건/PageState flags 확인(무매칭 — IREL_RUNTIME_MISSING과 동일 원칙)" },

  SITE_PROFILE_BLOCKED:        { retryable: false, httpStatus: 403, exceptionClass: "security", userMessage: "해당 사이트는 승인이 필요합니다.", operatorAction: "site risk=red 승인 워크플로우" },
  SITE_CIRCUIT_OPEN:           { retryable: true,  httpStatus: 503, exceptionClass: "system",   userMessage: "일시적으로 수집이 중단되었습니다.", operatorAction: "차단율 대시보드 확인, 윈도우 재개" },
  SESSION_LOCKED:              { retryable: true,  httpStatus: 409, exceptionClass: "system",   userMessage: "잠시 후 재시도됩니다.", operatorAction: "credential 동시 실행 상한 확인" },
  SESSION_GENERATION_CONFLICT: { retryable: true,  httpStatus: 409, exceptionClass: "system",   userMessage: "세션 갱신 충돌.", operatorAction: "세션 재조회" },
  CHALLENGE_UNRESOLVED:        { retryable: false, httpStatus: 422, exceptionClass: "challenge",userMessage: "추가 인증이 필요합니다.", operatorAction: "Human Task 인박스 처리" },
  RATE_BUDGET_EXCEEDED:        { retryable: true,  httpStatus: 429, exceptionClass: "system",   userMessage: "요청 한도 초과. 다음 윈도우에 처리됩니다.", operatorAction: "일일 예산/윈도우 조정" },

  BROWSER_LEASE_EXPIRED:       { retryable: true,  httpStatus: 500, exceptionClass: "system",   userMessage: "재시도됩니다.", operatorAction: "lease sweeper 동작 확인" },
  BROWSER_CRASH:               { retryable: true,  httpStatus: 500, exceptionClass: "system",   userMessage: "재시도됩니다.", operatorAction: "브라우저 메모리/재생성 확인" },
  CDP_DISCONNECTED:            { retryable: true,  httpStatus: 500, exceptionClass: "system",   userMessage: "재시도됩니다.", operatorAction: "CDP 엔드포인트 상태 확인" },

  LLM_BUDGET_EXCEEDED:         { retryable: false, httpStatus: 402, exceptionClass: "system",   userMessage: "처리 한도 초과.", operatorAction: "token budget 상향 또는 시나리오 점검" },
  LLM_CAPABILITY_MISMATCH:     { retryable: false, httpStatus: 422, exceptionClass: "system",   userMessage: "모델 미지원 작업.", operatorAction: "model policy/capabilities 확인" },
  LLM_STREAM_TIMEOUT:          { retryable: false, httpStatus: 504, exceptionClass: "system",   userMessage: "응답 지연.", operatorAction: "모델 백엔드 상태 확인" },
  LLM_STREAM_IDLE_TIMEOUT:     { retryable: true,  httpStatus: 504, exceptionClass: "system",   userMessage: "재시도됩니다.", operatorAction: "fallback model 동작 확인" },
  LLM_MALFORMED_OUTPUT:        { retryable: true,  httpStatus: 502, exceptionClass: "system",   userMessage: "재시도됩니다.", operatorAction: "prompt/schema 점검(반복 시)" },
  LLM_CONTENT_FILTERED:        { retryable: false, httpStatus: 422, exceptionClass: "business", userMessage: "처리할 수 없는 콘텐츠.", operatorAction: "입력 검토" },
  // [FIX] adapter retry 분류(llm-gateway-adapter.md §4)의 terminal 매핑. 재시도 소진 시 surfacing.
  LLM_RATE_LIMITED:            { retryable: true,  httpStatus: 429, exceptionClass: "system",   userMessage: "잠시 후 재시도됩니다.", operatorAction: "모델 rate limit — 백오프/동시성/예산 확인" },
  LLM_BACKEND_UNAVAILABLE:     { retryable: true,  httpStatus: 502, exceptionClass: "system",   userMessage: "재시도됩니다.", operatorAction: "모델 백엔드 5xx — 상태/대체 모델 확인" },
  LLM_CONNECTION_FAILED:       { retryable: true,  httpStatus: 502, exceptionClass: "system",   userMessage: "재시도됩니다.", operatorAction: "백엔드 연결 실패 — 엔드포인트/네트워크 확인" },

  EXTRACT_SCHEMA_INVALID:      { retryable: false, httpStatus: 422, exceptionClass: "business", userMessage: "데이터 형식 오류.", operatorAction: "출력 스키마/페이지 변경 확인" },
  VERIFY_FAILED:               { retryable: true,  httpStatus: 500, exceptionClass: "system",   userMessage: "재시도됩니다.", operatorAction: "verify 기준/취약 스텝 확인" },
  EMPTY_RESULT_NO_WITNESS:     { retryable: false, httpStatus: 422, exceptionClass: "business", userMessage: "결과 확인 불가.", operatorAction: "empty_result_allowed witness 추가" },

  SECRET_ACCESS_DENIED:        { retryable: false, httpStatus: 403, exceptionClass: "security", userMessage: "권한이 없습니다.", operatorAction: "RBAC/Vault 정책 확인" },
  DOMAIN_POLICY_VIOLATION:     { retryable: false, httpStatus: 403, exceptionClass: "security", userMessage: "허용되지 않은 이동.", operatorAction: "allowed domains 점검(침해 의심)" },
  PROMPT_INJECTION_DETECTED:   { retryable: false, httpStatus: 422, exceptionClass: "security", userMessage: "비정상 콘텐츠 감지.", operatorAction: "페이지 출처/공격 가능성 검토" },
  ARTIFACT_NOT_REDACTED:       { retryable: false, httpStatus: 409, exceptionClass: "security", userMessage: "준비 중입니다.", operatorAction: "redaction job 상태 확인" },
  SHELL_COMMAND_NOT_ALLOWED:   { retryable: false, httpStatus: 403, exceptionClass: "security", userMessage: "허용되지 않은 명령입니다.", operatorAction: "signed command registry 등록 확인(security-contracts.md §shell)" },
  // [FIX] authn/authz 분리: 인증 미성립(토큰 누락/서명 무효)은 401, 인증됐으나 권한 부족은 403(AUTHZ_FORBIDDEN).
  //   userMessage는 자원 존재/종류 비노출 위해 최소화. api-surface §0.1·auth-rbac §3/§5와 정합.
  UNAUTHENTICATED:             { retryable: false, httpStatus: 401, exceptionClass: "security", userMessage: "인증이 필요합니다.", operatorAction: "유효한 Bearer JWT 제시(auth-rbac.md §3) — 토큰 누락/서명 무효" },
  AUTHZ_FORBIDDEN:             { retryable: false, httpStatus: 403, exceptionClass: "security", userMessage: "권한이 없습니다.", operatorAction: "역할/권한 매트릭스 확인(auth-rbac.md §2)" },

  CONNECTOR_PERMISSION_DENIED: { retryable: false, httpStatus: 403, exceptionClass: "security", userMessage: "커넥터 권한 위반.", operatorAction: "manifest permissions 확인" },
  CONNECTOR_INCOMPATIBLE:      { retryable: false, httpStatus: 409, exceptionClass: "system",   userMessage: "버전 비호환.", operatorAction: "runtime/IR 버전 호환 확인" },
  CONNECTOR_HOOK_FAILED:       { retryable: false, httpStatus: 500, exceptionClass: "system",   userMessage: "커넥터 설치 오류.", operatorAction: "hook 로그 + rollback 확인" },

  SINK_DELIVERY_FAILED:        { retryable: true,  httpStatus: 502, exceptionClass: "system",   userMessage: "전달 재시도 중.", operatorAction: "Sink DLQ replay" },
  RAW_PERSIST_FAILED:          { retryable: true,  httpStatus: 500, exceptionClass: "system",   userMessage: "재시도됩니다.", operatorAction: "스토리지 상태 확인" },
  CONTROL_PLANE_INTERNAL_ERROR: { retryable: false, httpStatus: 500, exceptionClass: "system",   userMessage: "내부 오류가 발생했습니다.", operatorAction: "control-plane error log와 correlation_id 확인" },

  HUMAN_TASK_EXPIRED:          { retryable: false, httpStatus: 410, exceptionClass: "business", userMessage: "처리 기한 만료.", operatorAction: "재처리 또는 escalate" },

  APPROVAL_ALREADY_DECIDED:    { retryable: false, httpStatus: 409, exceptionClass: "none",     userMessage: "이미 처리된 결재입니다.", operatorAction: "결재 상태 확인(이중결재 방지)" },

  WORKITEM_CHECKOUT_CONFLICT:  { retryable: true,  httpStatus: 409, exceptionClass: "system",   userMessage: "재시도됩니다.", operatorAction: "unique_reference 중복 확인" },
  // [note] DEAD_LETTER는 HTTP 에러 응답이 아니라 상태 통지(이벤트/operatorAction)용 코드 — httpStatus 200은 "API 오류 아님"을 뜻한다. ApiError로 반환하지 않는다.
  DEAD_LETTER:                 { retryable: false, httpStatus: 200, exceptionClass: "system",   userMessage: "수동 재처리 대기.", operatorAction: "DLQ replay API" },
};

/** API 공통 에러 응답 */
export interface ApiError {
  code: ErrorCode;
  message: string;        // userMessage 또는 상세
  details?: unknown;
  correlation_id: string;
}
