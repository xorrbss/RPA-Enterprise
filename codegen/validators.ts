/**
 * codegen/validators.ts — D1 codegen 산출물 (경계 JSON Schema 검증)
 *
 * 계약 SSoT(schema/*.json)를 Ajv(2020)로 컴파일해 경계 검증 함수를 제공한다.
 * 사용처: impl-contracts-bundle.md §C "runtime schema validation (경계)" —
 *   들어오는 모든 payload(API body / DB row / queue job)는 경계에서 ajv 검증.
 *   타입 단언만으로 신뢰 금지.
 *
 * 변환 원칙(계약→코드, 새 계약 생성 금지):
 *  - 스키마 3개를 import("../schema/*.json")로 로드(별도 정의/재기술 없음).
 *  - ir.schema.json의 "verify": { "$ref": "verify.schema.json" } 상대 참조를
 *    addSchema(verify)로 먼저 등록해 해소($id 기준 상대 해석).
 *  - format "uuid"/"date-time"(event-envelope)을 명시 등록 — 미등록 시 ajv가
 *    format을 조용히 통과시키므로("조용한 false/unknown 금지"), 외부 의존(ajv-formats)을
 *    추가하지 않고 계약이 실제로 쓰는 두 포맷만 결정적으로 검증한다.
 *
 * tsconfig: strict + "resolveJsonModule": true + "esModuleInterop": true 가정.
 */

import Ajv2020, { ErrorObject, ValidateFunction } from "ajv/dist/2020";

import irSchema from "../schema/ir.schema.json";
import verifySchema from "../schema/verify.schema.json";
import eventEnvelopeSchema from "../schema/event-envelope.schema.json";
import {
  EVENT_PAYLOAD_SCHEMA_REFS,
  EVENT_PAYLOAD_SCHEMAS,
} from "./event-payload-registry";
import type { EventType } from "./types";

/** 경계 검증 결과. 실패 시 ajv 에러 배열 동봉(소비자가 IR_SCHEMA_INVALID 등으로 매핑). */
export interface ValidationResult {
  readonly valid: boolean;
  /** ajv가 채운 검증 에러. valid=true면 null. */
  readonly errors: readonly ErrorObject[] | null;
}

/**
 * 단일 공유 Ajv 인스턴스.
 * - strict: true — 스키마 자체의 미정의 키워드/구조를 빌드 타임에 거부(조용한 무시 금지).
 * - allErrors: true — 경계 진단을 위해 첫 에러에서 멈추지 않음.
 * - strictRequired: false — ir.schema.json은 "정확히 하나의 흐름 키"를
 *   oneOf + not/anyOf/required 관용구(node oneOf)로 강제한다. 이 not 하위스키마는
 *   properties 없이 required 만 가지므로 Ajv의 strictRequired 린트가
 *   "required property not defined in properties"로 컴파일을 거부한다.
 *   이는 표준 2020-12로는 유효한 계약이며 Ajv의 선택적 린트일 뿐이다.
 *   계약 수정 금지 원칙에 따라 데이터 검증은 그대로 두고 이 린트만 끈다.
 *   (검증 동작 무영향: 2개·0개 흐름 키 모두 정상 거부됨 — 런타임 확인 완료)
 * - $id 기반 cross-$ref(ir→verify) 해소를 위해 세 스키마를 모두 같은 인스턴스에 등록.
 */
const ajv = new Ajv2020({
  strict: true,
  strictRequired: false,
  allErrors: true,
  // event-envelope payload는 freeform object(스키마 ref 레지스트리에서 별도 검증),
  // additionalProperties:false 와 무관한 빈 object 스키마를 그대로 허용.
});

// --- format 등록 (event-envelope.schema.json이 사용하는 두 포맷만) ---

// RFC 4122 UUID. event_id/tenant_id/run_id/workitem_id/correlation_id/causation_id.
const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;
ajv.addFormat("uuid", {
  type: "string",
  validate: (s: string): boolean => UUID_RE.test(s),
});

// RFC 3339 date-time(occurred_at). Date.parse 기반 결정적 판정.
ajv.addFormat("date-time", {
  type: "string",
  validate: (s: string): boolean =>
    /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/.test(
      s,
    ) && !Number.isNaN(Date.parse(s)),
});

// Verify DSL url_matches.pattern. Invalid regex must fail at validation time.
ajv.addFormat("regex", {
  type: "string",
  validate: (s: string): boolean => {
    try {
      new RegExp(s);
      return true;
    } catch {
      return false;
    }
  },
});

// --- 스키마 등록 & 컴파일 ---
// 등록 순서 무관(Ajv는 $id로 cross-ref 해소)하지만, 의존 스키마(verify)를
// 먼저 addSchema 한 뒤 ir을 컴파일해 상대 $ref "verify.schema.json"을 해소한다.
ajv.addSchema(verifySchema, verifySchema.$id);

const irValidate: ValidateFunction = ajv.compile(irSchema);
const verifyValidate: ValidateFunction = ajv.getSchema(verifySchema.$id) as ValidateFunction;
const eventValidate: ValidateFunction = ajv.compile(eventEnvelopeSchema);
const eventPayloadValidators = Object.fromEntries(
  Object.entries(EVENT_PAYLOAD_SCHEMAS).map(([eventType, schema]) => [
    eventType,
    ajv.compile(schema),
  ]),
) as Record<EventType, ValidateFunction>;

function run(fn: ValidateFunction, data: unknown): ValidationResult {
  const valid = fn(data) as boolean;
  return { valid, errors: valid ? null : (fn.errors ?? null) };
}

function contractError(message: string, instancePath: string): ErrorObject {
  return {
    instancePath,
    schemaPath: "#/payloadRegistry",
    keyword: "payloadRegistry",
    params: {},
    message,
  };
}

function isEventEnvelope(
  data: unknown,
): data is { event_type: EventType; payload_schema_ref: string; payload: unknown } {
  if (typeof data !== "object" || data === null) return false;
  const candidate = data as Record<string, unknown>;
  return (
    typeof candidate.event_type === "string" &&
    Object.prototype.hasOwnProperty.call(EVENT_PAYLOAD_SCHEMA_REFS, candidate.event_type) &&
    typeof candidate.payload_schema_ref === "string" &&
    typeof candidate.payload === "object" &&
    candidate.payload !== null &&
    !Array.isArray(candidate.payload)
  );
}

/** 시나리오 IR(ir.schema.json) 경계 검증. 내부적으로 verify.schema.json($ref) 포함. */
export function validateIR(data: unknown): ValidationResult {
  const base = run(irValidate, data);
  if (!base.valid) return base;

  if (typeof data === "object" && data !== null && "params_schema" in data) {
    const paramsSchema = (data as { params_schema?: unknown }).params_schema;
    if (paramsSchema !== undefined) {
      const validSchema = ajv.validateSchema(paramsSchema as object);
      if (!validSchema) {
        return {
          valid: false,
          errors: ajv.errors ?? [
            contractError("params_schema must be a valid JSON Schema draft 2020-12 schema", "/params_schema"),
          ],
        };
      }
    }
  }

  return base;
}

/** Verify DSL(verify.schema.json) 경계 검증. */
export function validateVerify(data: unknown): ValidationResult {
  return run(verifyValidate, data);
}

/** Event Envelope(event-envelope.schema.json) 경계 검증. */
export function validateEvent(data: unknown): ValidationResult {
  const envelope = run(eventValidate, data);
  if (!envelope.valid) return envelope;

  if (!isEventEnvelope(data)) {
    return {
      valid: false,
      errors: [
        contractError("event_type/payload_schema_ref/payload shape mismatch", ""),
      ],
    };
  }

  const expectedRef = EVENT_PAYLOAD_SCHEMA_REFS[data.event_type];
  if (data.payload_schema_ref !== expectedRef) {
    return {
      valid: false,
      errors: [
        contractError(
          `payload_schema_ref must be ${expectedRef} for ${data.event_type}`,
          "/payload_schema_ref",
        ),
      ],
    };
  }

  const payloadValidate = eventPayloadValidators[data.event_type];
  const validPayload = payloadValidate(data.payload) as boolean;
  return {
    valid: validPayload,
    errors: validPayload ? null : (payloadValidate.errors ?? null),
  };
}

/** 진단/테스트용 원시 Ajv validators. Event는 envelope-only이므로 public boundary로 쓰지 않는다. */
export const rawValidators = {
  ir: irValidate,
  verify: verifyValidate,
  eventEnvelope: eventValidate,
} as const;

/** Public boundary validators. event는 payload registry 검증까지 포함한다. */
export const validators = {
  ir: irValidate,
  verify: verifyValidate,
  event: (data: unknown): boolean => validateEvent(data).valid,
} as const;
