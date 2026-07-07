/**
 * ir-interpreter.ts 에서 추출(CLAUDE.md #7) — @human_task input 파싱(parseHumanTaskInput + payload from_param 해소).
 * 동작 무변경, leaf — 인터프리터가 역import.
 */
import {
  HUMAN_TASK_MAX_TIMEOUT_MS,
  HUMAN_TASK_MIN_TIMEOUT_MS,
  parseHumanTaskTimeoutMs,
} from "./human-task-timeout-policy";
import { InterpreterError } from "./ir-interpreter-node-output";

/**
 * @human_task input(reserved-handlers) → 타입 검증된 산출. 미정/오류는 조용히 흘리지 않고 IR_SCHEMA_INVALID 로 표면화.
 * kind 미지정→exception 기본(R5), on_timeout 미지정→fail 기본(reserved-handlers/DDL). assignee_role 은 필수(미할당 task 금지).
 * payload·timeout(둘 다 optional)은 v1 의도적 미투영(은폐 아님, 명시 deferral): payload 는 inline 저장 부재(read 측 v1
 * 미포함, payload_ref 만) · timeout→expires_at 은 human_task timeout 스위퍼(H4/H8)가 미구현이라 발화 소비자 없음
 * (challenge 경로도 expires_at 미설정 동일). 스위퍼 증분에서 timeout 파싱+expires_at+payload_ref 를 함께 배선.
 */
/**
 * @human_task payload 의 한 **VALUE**를 해소한다 — {from_param:"key"} 리프면 run params 값으로 치환(리뷰어가 **하나의
 * 사람-확인 인박스**에서 이 run 의 실제 데이터를 보고 business_form 필드가 payload[field.key]로 pre-fill 되게,
 * HumanTaskReviewPanel.initialFormValues). url_ref/value_ref(params 참조)와 동형이되 payload 는 중첩 레코드라 리프 마커로
 * 리터럴과 구분한다. 미해소(키 부재/비-스칼라)는 loud throw("조용한 false 금지"). 마커가 아니면 그대로/재귀. 호출부는 루트
 * 레코드의 각 VALUE 에만 적용해(루트 자체는 표시용 레코드로 보존) 루트가 마커로 collapse 되지 않게 한다(PAYLOAD-02).
 */
function resolvePayloadParams(value: unknown, params: Record<string, unknown> | undefined, nodeId: string): unknown {
  if (Array.isArray(value)) return value.map((v) => resolvePayloadParams(v, params, nodeId));
  if (value !== null && typeof value === "object") {
    const rec = value as Record<string, unknown>;
    const keys = Object.keys(rec);
    if (keys.length === 1 && keys[0] === "from_param" && typeof rec.from_param === "string") {
      const pk = rec.from_param;
      const pv = params?.[pk];
      if (typeof pv !== "string" && typeof pv !== "number" && typeof pv !== "boolean") {
        throw new InterpreterError(
          "IR_SCHEMA_INVALID",
          `@human_task node '${nodeId}': payload from_param '${pk}' 미해소 — run params 에 스칼라 값 없음(리뷰어 컨텍스트 유실; 조용한 false 금지)`,
        );
      }
      return pv;
    }
    return Object.fromEntries(keys.map((k) => [k, resolvePayloadParams(rec[k], params, nodeId)]));
  }
  return value;
}

export function parseHumanTaskInput(
  nodeId: string,
  input: Record<string, unknown>,
  params: Record<string, unknown> | undefined,
): {
  humanTaskKind: "approval" | "validation" | "exception";
  assigneeRole: string;
  onTimeout: "fail" | "escalate";
  timeoutMs?: number;
  payload?: Record<string, unknown>;
  resultSchema?: Record<string, unknown>;
  artifactRefs?: readonly string[];
} {
  const kindRaw = input.kind;
  let humanTaskKind: "approval" | "validation" | "exception";
  if (kindRaw === undefined) humanTaskKind = "exception";
  else if (kindRaw === "approval" || kindRaw === "validation" || kindRaw === "exception") humanTaskKind = kindRaw;
  else
    throw new InterpreterError(
      "IR_SCHEMA_INVALID",
      `@human_task node '${nodeId}': input.kind '${String(kindRaw)}' 무효(approval|validation|exception)`,
    );
  const assigneeRole = input.assignee_role;
  if (typeof assigneeRole !== "string" || assigneeRole.trim().length === 0) {
    throw new InterpreterError("IR_SCHEMA_INVALID", `@human_task node '${nodeId}': input.assignee_role 필수(비어있지 않은 string)`);
  }
  const onTimeoutRaw = input.on_timeout;
  let onTimeout: "fail" | "escalate";
  if (onTimeoutRaw === undefined) onTimeout = "fail";
  else if (onTimeoutRaw === "fail" || onTimeoutRaw === "escalate") onTimeout = onTimeoutRaw;
  else
    throw new InterpreterError(
      "IR_SCHEMA_INVALID",
      `@human_task node '${nodeId}': input.on_timeout '${String(onTimeoutRaw)}' 무효(fail|escalate)`,
    );
  const timeoutRaw = input.timeout;
  let timeoutMs: number | undefined;
  if (timeoutRaw !== undefined) {
    if (typeof timeoutRaw !== "string") {
      throw new InterpreterError("IR_SCHEMA_INVALID", `@human_task node '${nodeId}': input.timeout must be a duration string`);
    }
    const parsed = parseHumanTaskTimeoutMs(timeoutRaw);
    if (parsed === null) {
      throw new InterpreterError(
        "IR_SCHEMA_INVALID",
        `@human_task node '${nodeId}': input.timeout '${timeoutRaw}' invalid (ms|s|m|h|d, ${HUMAN_TASK_MIN_TIMEOUT_MS}-${HUMAN_TASK_MAX_TIMEOUT_MS}ms)`,
      );
    }
    timeoutMs = parsed;
  }
  const payloadRaw = optionalRecordInput(nodeId, input.payload, "payload");
  // payload 는 항상 표시용 레코드(displayKey→value) — 루트 자체를 {from_param} 마커로 오인해 스칼라로 collapse 시키지 않도록
  //   각 VALUE 만 해소한다(루트 collapse + unsound cast 로 jsonb 에 문자열 영속되던 PAYLOAD-02 방지). 마커는 값 위치에서만 유효.
  const payload = payloadRaw !== undefined
    ? Object.fromEntries(Object.entries(payloadRaw).map(([k, v]) => [k, resolvePayloadParams(v, params, nodeId)]))
    : undefined;
  const resultSchema = optionalRecordInput(nodeId, input.result_schema, "result_schema");
  const artifactRefs = optionalStringArrayInput(nodeId, input.artifact_refs, "artifact_refs");
  return {
    humanTaskKind,
    assigneeRole,
    onTimeout,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(payload !== undefined ? { payload } : {}),
    ...(resultSchema !== undefined ? { resultSchema } : {}),
    ...(artifactRefs !== undefined ? { artifactRefs } : {}),
  };
}

function optionalRecordInput(nodeId: string, value: unknown, field: string): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new InterpreterError("IR_SCHEMA_INVALID", `@human_task node '${nodeId}': input.${field} 는 object 여야 함`);
}

function optionalStringArrayInput(nodeId: string, value: unknown, field: string): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0)) {
    return value;
  }
  throw new InterpreterError("IR_SCHEMA_INVALID", `@human_task node '${nodeId}': input.${field} 는 non-empty string[] 이어야 함`);
}
