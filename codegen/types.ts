/**
 * codegen/types.ts — D1 codegen 산출물 (계약 → TS 인터페이스)
 *
 * 출처(권위) 스키마와 1:1 매핑. 추측 없이 아래 파일에서만 파생:
 *   - schema/ir.schema.json            → IRScenario / IRNode / IRAction / ... (IR v1)
 *   - schema/verify.schema.json        → VerifyDSL / VerifyCriterion / ...      (Verify DSL v1)
 *   - schema/event-envelope.schema.json → EventEnvelope / EventType            (Event Envelope v1)
 *
 * 충돌 회피 원칙:
 *   core-types.ts 는 런타임 실행 결과 계약(VerifyResult/StepResult/PageState 등)을 정의한다.
 *   본 파일은 "선언형 IR/스키마"의 정적 형상이다(저장 시 ajv 검증 대상). 의미가 겹치는 곳은
 *   core-types 의 기존 정의를 재-export 하여 단일 진실원천을 유지한다:
 *     - 액션 종류    : IRActionType  (= ir.schema action enum 과 동일 10종)
 *     - side_effect.kind : SideEffectKind (= sideEffect.kind enum 과 동일 7종)
 *   Verify DSL 의 결과형(VerifyResult)과 구분하기 위해, Verify "정의" 타입은 VerifyDSL 로 명명한다.
 *
 * "조용한 false/unknown 금지": 스키마의 enum/const 는 전부 좁은 union 으로 옮긴다(open string 금지).
 * 미정의 값이 들어오면 ajv 검증 경계에서 거부되며, 타입 차원에서도 union 이 강제한다.
 *
 * strict 모드 컴파일 가정: tsconfig strict. any 미사용(스키마 미지정 자리는 unknown).
 */

import type { IRActionType, SideEffectKind } from "../ts/core-types";

// core-types 의 정의를 그대로 재-export (중복 정의 금지).
export type { IRActionType, SideEffectKind } from "../ts/core-types";

/* ========================================================================
 * IR v1  (schema/ir.schema.json — "RPA Scenario IR v1")
 * ====================================================================== */

/** 루트 객체. required: meta, start, nodes. additionalProperties:false. */
export interface IRScenario {
  meta: IRMeta;
  /** 실행 파라미터 JSON Schema. IREL params.* 타입 추론 근거. (freeform JSON Schema) */
  params_schema?: Record<string, unknown>;
  /** Assets 스토어 참조 키(값 아님) */
  assets?: string[];
  /** 시작 노드 id */
  start: string;
  /** 노드 맵. minProperties:1. 키는 노드 id. */
  nodes: Record<string, IRNode>;
}

/** required: name, version. (additionalProperties 미지정 → 추가 허용이지만 계약 표면만 노출) */
export interface IRMeta {
  name: string;
  /** integer, minimum 1 */
  version: number;
  /** const "1.x" */
  ir_version?: "1.x";
}

/**
 * IR 노드. additionalProperties:false.
 * 흐름 제어 키(next / on / loop / fallback_chain / terminal) 중 "정확히 하나"만 존재해야 한다
 * (ir.schema.json oneOf, FIX #11). TS 차원에서 이를 강제하기 위해 공통 필드 + 흐름키 union 으로 구성한다.
 */
export type IRNode = IRNodeBase & IRNodeFlow;

/** 흐름 제어를 제외한 모든 노드 필드(전부 optional — 스키마상 required 아님). */
export interface IRNodeBase {
  /** 상태 패턴. 생략 시 직전 PageState 계승. */
  where?: IRWhere;
  what?: IRAction[];
  verify?: VerifyDSL;
  policy?: IRNodePolicy;
  side_effect?: IRSideEffect;
}

/** 흐름 제어 키: 정확히 하나(ir.schema oneOf). */
export type IRNodeFlow =
  | { next: IRTarget; on?: never; loop?: never; fallback_chain?: never; terminal?: never }
  | { on: IROnBranch[]; next?: never; loop?: never; fallback_chain?: never; terminal?: never }
  | { loop: IRLoop; next?: never; on?: never; fallback_chain?: never; terminal?: never }
  | { fallback_chain: IRFallbackTier[]; next?: never; on?: never; loop?: never; terminal?: never }
  | { terminal: IRTerminal; next?: never; on?: never; loop?: never; fallback_chain?: never };

/**
 * 분기 목록 항목(노드 on[]). priority 내림차순 평가, 첫 true 채택.
 * 동률 priority 는 컴파일 거부(비결정 방지). required: when, target, priority. additionalProperties:false.
 */
export interface IROnBranch {
  /** IREL 불린식. 예: flags.blocked */
  when: string;
  target: IRTarget;
  /** integer. 높을수록 우선. 동률 금지(컴파일 검증). */
  priority: number;
}

/** required: until, max_iterations. additionalProperties:false. */
export interface IRLoop {
  /** IREL 불린식. 컴파일 타임 타입체크. */
  until: string;
  /** integer, minimum 1, maximum 10000. 무한루프 가드 필수. */
  max_iterations: number;
}

/** 종료 노드 종류(terminal). 다른 흐름 키와 함께 쓸 수 없음. */
export type IRTerminal = "success" | "success_empty" | "fail_business" | "fail_system";

/**
 * 노드 id 또는 예약 핸들러(@challenge / @human_task / @end_no_data).
 * pattern: ^(@challenge|@human_task|@end_no_data|[a-zA-Z_][a-zA-Z0-9_]*)$
 * (TS 는 정규식 제약을 표현하지 못하므로 string 별칭으로 둔다 — 검증은 ajv 경계.)
 */
export type IRTarget = string;

/** 상태 패턴. additionalProperties:false. (전부 optional) */
export interface IRWhere {
  url?: string;
  page_intent?: string;
  selectors?: string[];
  /** enum, default "AND" */
  logic?: "AND" | "OR" | "NOT";
  /** integer. 다중 매칭 시 우선순위(높을수록 우선). */
  priority?: number;
}

/**
 * 액션. required: action. additionalProperties:TRUE → 알 수 없는 추가 키 허용(index signature).
 * action==="shell" 이면 cmd_ref 필수(allOf if/then) — 타입에서는 식별 union 으로 강제한다.
 */
export type IRAction = IRShellAction | IRNonShellAction;

/** action !== "shell" 인 액션. (cmd_ref 는 shell 전용이므로 비-shell 에서는 의미 없음/미사용) */
export interface IRNonShellAction extends IRActionFields {
  action: Exclude<IRActionType, "shell">;
}

/** action === "shell". cmd_ref 필수(signed command registry 키). */
export interface IRShellAction extends IRActionFields {
  action: "shell";
  /** shell 전용 — signed command registry 키. 미등록 시 거부. (shell 에서 required) */
  cmd_ref: string;
}

/** 액션 공통 필드 + additionalProperties:true 표현용 index signature. */
export interface IRActionFields {
  instruction?: string;
  /** extract 출력 스키마 */
  schema_ref?: string;
  /** Assets/credential 참조 */
  vars?: string[];
  url_ref?: string;
  /** shell 전용 — signed command registry 키. 미등록 시 거부. */
  cmd_ref?: string;
  /** default false */
  sensitive?: boolean;
  /** additionalProperties:true — 스키마에 명시되지 않은 추가 키 허용. */
  [key: string]: unknown;
}

/** 노드 정책. additionalProperties:false. (전부 optional) */
export interface IRNodePolicy {
  /** integer, minimum 1000 */
  timeout_ms?: number;
  /** integer, minimum 0, default 2 */
  max_self_heal?: number;
  /** default false */
  requires_approval?: boolean;
  /** default "masked_on_failure" */
  recording?: "always" | "masked_on_failure" | "never";
}

/**
 * side_effect. required: kind. additionalProperties:false.
 * kind !== "read_only" 이면 idempotency_key 필수(allOf if/then) — 식별 union 으로 강제.
 */
export type IRSideEffect = IRReadOnlySideEffect | IRMutatingSideEffect;

/** kind === "read_only": idempotency_key 불요. */
export interface IRReadOnlySideEffect {
  kind: Extract<SideEffectKind, "read_only">;
  idempotent?: boolean;
  idempotency_key?: string;
}

/** kind !== "read_only": idempotency_key 필수(코드/스키마 검증). */
export interface IRMutatingSideEffect {
  kind: Exclude<SideEffectKind, "read_only">;
  idempotent?: boolean;
  /** 비-read_only면 필수. */
  idempotency_key: string;
}

/** fallback_chain[] 항목. required: tier, entry_node. additionalProperties:false. */
export interface IRFallbackTier {
  tier: "T0" | "T1" | "T2" | "T3";
  /** 이 티어의 진입 노드 id */
  entry_node: string;
  /** IREL 불린식. true면 다음 티어로 전환. */
  advance_when?: string;
}

/* ========================================================================
 * Verify DSL v1  (schema/verify.schema.json — "Verify DSL v1")
 * ====================================================================== */

/**
 * Verify 정의(노드 verify 필드의 형상). required: criteria. additionalProperties:false.
 * NOTE: core-types.ts 의 VerifyResult(실행 결과)와 구분하기 위해 VerifyDSL 로 명명.
 */
export interface VerifyDSL {
  /** minItems:1 */
  criteria: VerifyCriterion[];
  vlm_fallback?: VerifyVlmFallback;
  /** default "human_task" */
  on_uncertain?: "human_task" | "self_heal" | "retry_same" | "abort_security";
  /** default "self_heal" */
  on_fail?: "self_heal" | "retry_same" | "human_task" | "challenge_resolution" | "abort_security";
}

/** vlm_fallback. required: prompt. */
export interface VerifyVlmFallback {
  prompt: string;
  /** IREL식. 기본 'criteria_uncertain' */
  when?: string;
}

/** 판정 기준(oneOf 10종). type 으로 식별되는 discriminated union. */
export type VerifyCriterion =
  | VerifyUrlMatches
  | VerifyElementVisible
  | VerifyElementAbsent
  | VerifyTextIncludes
  | VerifyExtractSchemaValid
  | VerifyMinRows
  | VerifyHttpStatus
  | VerifyValueMatch
  | VerifyEmptyResultAllowed
  | VerifyReceiptCaptured;

/** 모든 criterion 공통 — type 식별자 union(편의용). */
export type VerifyCriterionType = VerifyCriterion["type"];

export interface VerifyUrlMatches {
  type: "url_matches";
  pattern: string;
  required?: boolean;
}

export interface VerifyElementVisible {
  type: "element_visible";
  target: VerifyElementTarget;
  /** integer */
  timeout_ms?: number;
  required?: boolean;
}

export interface VerifyElementAbsent {
  type: "element_absent";
  target: VerifyElementTarget;
  required?: boolean;
}

export interface VerifyTextIncludes {
  type: "text_includes";
  texts: string[];
  required?: boolean;
}

export interface VerifyExtractSchemaValid {
  type: "extract_schema_valid";
  schema_ref: string;
  required?: boolean;
}

export interface VerifyMinRows {
  type: "min_rows";
  /** integer, minimum 1. 0 금지 — 빈결과는 empty_result_allowed로만. */
  n: number;
  required?: boolean;
}

export interface VerifyHttpStatus {
  type: "http_status";
  /** integer[] */
  codes: number[];
  required?: boolean;
}

export interface VerifyValueMatch {
  type: "value_match";
  /** dot-path(ident('.'ident)*), 인덱싱 금지 — ir-static-validation.md §3 */
  path: string;
  /** equals: 스키마상 타입 미지정(임의 JSON 값). */
  equals: unknown;
  required?: boolean;
}

export interface VerifyEmptyResultAllowed {
  type: "empty_result_allowed";
  /** IREL 불린식 witness. 예: flags.no_review_message_visible */
  when: string;
}

export interface VerifyReceiptCaptured {
  type: "receipt_captured";
  /** side_effect 비-read_only 노드 후 증빙 캡처 검증 */
  required?: boolean;
}

/**
 * elementTarget. additionalProperties:false.
 * oneOf: { selector } | { role, name }. 빈 target 거부.
 */
export type VerifyElementTarget =
  | { selector: string; role?: never; name?: never }
  | { role: string; name: string; selector?: never };

/* ========================================================================
 * Event Envelope v1  (schema/event-envelope.schema.json — "Event Envelope v1")
 * ====================================================================== */

/**
 * 전 내부 이벤트 공통 봉투. additionalProperties:false.
 * required: event_id, event_type, event_version, tenant_id, correlation_id,
 *           occurred_at, idempotency_key, payload_schema_ref, payload.
 * ordering_key 는 의도적으로 optional(run 없는 이벤트 — worker.heartbeat / site.circuit_* 등).
 */
export interface EventEnvelope {
  /** uuid */
  event_id: string;
  event_type: EventType;
  /** integer, minimum 1 */
  event_version: number;
  /** uuid */
  tenant_id: string;
  /** uuid */
  run_id?: string;
  /** uuid */
  workitem_id?: string;
  step_id?: string;
  /** uuid */
  correlation_id: string;
  /** uuid — 이 이벤트를 유발한 이벤트 id */
  causation_id?: string;
  /** 기본 run_id. run 없는 이벤트는 생략 가능(그래서 required 아님). */
  ordering_key?: string;
  /** date-time */
  occurred_at: string;
  /** 예: run:step:attempt:verify — 소비자 중복 무시 */
  idempotency_key: string;
  /**
   * 이 event_type 의 payload 검증용 등록 스키마 참조(예: 'events/run.completed@1').
   * event_type↔payload_schema_ref 매핑은 별도 payload 레지스트리(D1)에서 고정.
   */
  payload_schema_ref: string;
  /** event_type별 본문. payload_schema_ref 로 ajv 검증. (object) */
  payload: Record<string, unknown>;
}

/**
 * event_type 레지스트리(enum 31종). event-envelope.schema.json $defs.eventType 와 1:1.
 * run.cancelled(emit) — run.aborted 아님. 어휘 체인: abort → cancelled → run.cancelled.
 */
export type EventType =
  // Run lifecycle
  | "run.created"
  | "run.started"
  | "run.suspended"
  | "run.resume_requested"
  | "run.resumed"
  | "run.cancelled"
  | "run.completed"
  | "run.failed_business"
  | "run.failed_system"
  // Step
  | "step.started"
  | "step.completed"
  | "step.verify.failed"
  // LLM stream
  | "llm.stream.started"
  | "llm.stream.completed"
  | "llm.stream.aborted"
  // Challenge
  | "challenge.detected"
  | "challenge.resolved"
  // Human task
  | "human_task.created"
  | "human_task.resolved"
  | "human_task.expired"
  | "human_task.escalated"
  // Workitem
  | "workitem.completed"
  | "workitem.dead_lettered"
  // Pipeline / Sink
  | "pipeline.stage.completed"
  | "sink.delivered"
  | "sink.dead_lettered"
  // Site circuit
  | "site.circuit_opened"
  | "site.circuit_closed"
  // Worker
  | "worker.heartbeat"
  | "worker.circuit_opened"
  | "worker.circuit_closed";

/** 런타임 멤버십 검사용 동결 배열(EventType 와 동기). */
export const EVENT_TYPES: readonly EventType[] = [
  "run.created",
  "run.started",
  "run.suspended",
  "run.resume_requested",
  "run.resumed",
  "run.cancelled",
  "run.completed",
  "run.failed_business",
  "run.failed_system",
  "step.started",
  "step.completed",
  "step.verify.failed",
  "llm.stream.started",
  "llm.stream.completed",
  "llm.stream.aborted",
  "challenge.detected",
  "challenge.resolved",
  "human_task.created",
  "human_task.resolved",
  "human_task.expired",
  "human_task.escalated",
  "workitem.completed",
  "workitem.dead_lettered",
  "pipeline.stage.completed",
  "sink.delivered",
  "sink.dead_lettered",
  "site.circuit_opened",
  "site.circuit_closed",
  "worker.heartbeat",
  "worker.circuit_opened",
  "worker.circuit_closed",
] as const;

/* ========================================================================
 * IR Static Validation Report  (ir-static-validation.md §3)
 *   IR 저장/승격 시 그래프 정적검증(V1–V11) 산출. errors 비면 거부, warnings(V5/V7)는
 *   draft 저장 허용·prod 승격 차단. 구조 위반→IR_SCHEMA_INVALID, 표현식→IR_EXPRESSION_COMPILE_ERROR.
 * ====================================================================== */

/** 그래프 정적검증 규칙 식별자(ir-static-validation.md §1). */
export type IRValidationRule =
  | "V1" | "V2" | "V3" | "V4" | "V5" | "V6" | "V7" | "V8" | "V9" | "V10" | "V11";

export interface ValidationIssue {
  rule: IRValidationRule;
  /** §1 표의 reason 태그(예: target_not_found / unreachable_node / duplicate_priority). */
  reason: string;
  code: "IR_SCHEMA_INVALID" | "IR_EXPRESSION_COMPILE_ERROR";
  /** 위반 위치 노드 id(있으면). */
  nodeId?: string;
  /** 사람이 읽는 설명(민감정보 없음). */
  detail: string;
}

export interface ValidationReport {
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}
