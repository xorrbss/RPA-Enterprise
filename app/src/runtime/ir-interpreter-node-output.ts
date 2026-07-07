/**
 * ir-interpreter.ts 에서 추출(CLAUDE.md #7) — 노드 출력 투영(NodeOutput/projectNodeOutput/httpResponseFromStep) +
 * StepStatus↔terminal 매핑 + act.value_from_node 해소 + InterpreterError. 동작 무변경, leaf — 인터프리터가 역import.
 */
import type { HttpResponseSnapshot, StepResult, StepStatus } from "../../../ts/core-types";

/** 표준 노드 출력 필드(IREL node.<id>.*). 미투영 필드는 부재 → 참조 시 IREL_RUNTIME_MISSING(loud). */
export interface NodeOutput {
  // status 는 실행 노드(StepResult 투영)에만 부착. @human_task 해소 출력은 StepStatus 가 없어 status 부재(decision/correction 만, ir-expression §2).
  readonly status?: StepStatus;
  readonly row_count?: number;
  readonly extracted_ref?: string;
  readonly http_status?: number;
  readonly http_ok?: boolean;
  readonly http_body?: unknown;
  // tier: fallback_chain 노드가 채택한 티어(T0..T3). fallback 노드 출력에만 부착(ir-expression §2). 비-fallback은 부재(loud).
  readonly tier?: string;
  // @human_task 해소 출력(resume nodeScope 시드): decision(닫힌 enum)·correction(business_form 교정값). reserved-handlers.md.
  readonly decision?: string;
  readonly correction?: Record<string, unknown>;
}

/** StepResult → 표준 노드 출력 투영(ir-expression §2). status는 항상; row_count/extracted_ref는 extract 액션만. */
export function projectNodeOutput(res: StepResult): NodeOutput {
  if (res.action === "api_call") {
    const http = httpResponseFromStep(res);
    return {
      status: res.status,
      ...(http !== undefined ? {
        http_status: http.status,
        http_ok: http.ok,
        ...(http.body !== undefined ? { http_body: http.body } : {}),
      } : {}),
    };
  }
  if (res.action !== "extract") return { status: res.status };
  const rowCount = res.output !== null && typeof res.output === "object" ? (res.output as { rowCount?: unknown }).rowCount : undefined;
  const ref = res.artifacts[0];
  return {
    status: res.status,
    ...(typeof rowCount === "number" ? { row_count: rowCount } : {}),
    ...(typeof ref === "string" ? { extracted_ref: ref } : {}),
  };
}

export function httpResponseFromStep(res: StepResult): HttpResponseSnapshot | undefined {
  if (res.action !== "api_call" || res.output === undefined || typeof res.output !== "object" || res.output === null) return undefined;
  const output = res.output as Partial<HttpResponseSnapshot>;
  if (typeof output.status !== "number" || typeof output.ok !== "boolean" || typeof output.contentType !== "string" || typeof output.finalUrl !== "string" || typeof output.bodyTruncated !== "boolean") return undefined;
  return {
    status: output.status,
    ok: output.ok,
    contentType: output.contentType,
    finalUrl: output.finalUrl,
    redirected: output.redirected === true,
    ...(typeof output.redirectLocation === "string" ? { redirectLocation: output.redirectLocation } : {}),
    ...(Object.prototype.hasOwnProperty.call(output, "body") ? { body: output.body } : {}),
    bodyTruncated: output.bodyTruncated,
  };
}


export class InterpreterError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "InterpreterError";
  }
}

// 실패 status → terminal 매핑. 처리 못 하는 status(suspended/challenge/uncertain 등)는 null → 호출부가 표면화.
// failed_security 는 fail_system 합류 금지 — R10(즉시 중단+알림)이 R8(failed_system)과 다른 종결이다
//   (state-machine.md R10, runtime-contract EXECUTOR_OUTCOME_MAPPING_CONTRACT.securityFailure).
export function failureTerminal(status: StepStatus): string | null {
  if (status === "failed_business") return "fail_business";
  if (status === "failed_security") return "fail_security";
  if (status === "failed_system") return "fail_system";
  return null;
}

/**
 * act.value_from_node = {node, key} 를 dispatch 직전 소유 노드의 correction[key](사람이 검토·편집한 값)로 해소해 a.value 로
 * 고정한다. nodeScope 는 런타임(traverse)에서만 존재하므로 compiledScenarioFrom(정적·params-only)이 아닌 여기서 해소한다.
 * 미해소(노드 미방문/correction 부재/키 부재/비-문자열)면 loud throw — LLM/캐시 값으로 무음 fill 하지 않는다("조용한 false 금지").
 * value_from_node 가 없거나 act 가 아니면 원본 그대로 반환(투명).
 */
export function resolveActionValueFromNode(action: unknown, nodeScope: Record<string, NodeOutput>): unknown {
  if (typeof action !== "object" || action === null) return action;
  const a = action as { type?: unknown; valueFromNode?: unknown };
  if (a.type !== "act" || a.valueFromNode === undefined) return action;
  const vfn = a.valueFromNode as { node?: unknown; key?: unknown };
  if (typeof vfn.node !== "string" || typeof vfn.key !== "string") {
    throw new InterpreterError("IR_SCHEMA_INVALID", `interpreter: value_from_node 는 {node,key} 문자열 필요`);
  }
  const owner = nodeScope[vfn.node];
  const correction = owner?.correction;
  const v = correction !== undefined ? correction[vfn.key] : undefined;
  if (typeof v !== "string") {
    throw new InterpreterError(
      "IR_SCHEMA_INVALID",
      `interpreter: value_from_node {${vfn.node}.${vfn.key}} 미해소 — 소유 노드 correction 에 문자열 값 없음(사람 검토값 부재; 조용한 fill 금지)`,
    );
  }
  return { ...(action as object), value: v };
}

/** terminal 문자열 → StepStatus(fallback 노드 출력의 status 도출 — 채택 티어 entry_node 출력 부재 시). */
export function terminalToStatus(terminal: string): StepStatus {
  if (terminal === "fail_business") return "failed_business";
  if (terminal === "fail_security") return "failed_security";
  if (terminal === "fail_system") return "failed_system";
  return "success";
}

// 실패 terminal 집합(failureTerminal 산출 + 표준 vocab fail_*). 생략 advance_when 기본 전환 판정(§4: StepResult.status=failed_*).
// startsWith("fail") 대신 정확 매칭 — "failover_*" 류 비-실패 terminal 오분류 방지(break-it).
const FAILURE_TERMINALS = new Set(["fail_business", "fail_system", "fail_security"]);

/** fallback advance 기본(§4): 티어 결과가 실패 terminal 이면 다음 티어로 전환. */
export function isFailureTerminal(terminal: string): boolean {
  return FAILURE_TERMINALS.has(terminal);
}
