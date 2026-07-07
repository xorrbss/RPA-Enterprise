import {
  ApiError,
  type GatewayPolicyUpdate,
} from "../../api/types";
import { errorLabel } from "../badges";

export function parsePolicyJson(
  capabilities: string,
  budget: string,
  fallback: string,
):
  | {
      kind: "ok";
      body: Pick<
        GatewayPolicyUpdate,
        "capabilities" | "budget" | "fallback_config"
      >;
    }
  | { kind: "error"; message: string } {
  try {
    const caps = JSON.parse(capabilities) as unknown;
    const bud = JSON.parse(budget) as unknown;
    const fb = JSON.parse(fallback) as unknown;
    if (!isObject(caps) || !isObject(bud) || !(isObject(fb) || fb === null)) {
      return {
        kind: "error",
        message:
          "기능/예산 설정은 객체 형태, 대체 모델 설정은 객체 또는 null이어야 합니다.",
      };
    }
    return {
      kind: "ok",
      body: { capabilities: caps, budget: bud, fallback_config: fb },
    };
  } catch {
    return {
      kind: "error",
      message: "상세 설정 형식이 올바르지 않습니다(기능/예산/대체 모델 설정 확인).",
    };
  }
}

function parseNonNegative(
  value: string,
  label: string,
): number | { error: string } {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0)
    return { error: `${label}은 0 이상의 숫자여야 합니다.` };
  return n;
}

export function applyStructuredPolicy(
  body: Pick<
    GatewayPolicyUpdate,
    "capabilities" | "budget" | "fallback_config"
  >,
  fields: {
    jsonMode: boolean;
    vision: boolean;
    maxContextTokens: string;
    maxInputTokens: string;
    maxOutputTokens: string;
    maxCost: string;
    fallbackModel: string;
  },
):
  | {
      kind: "ok";
      body: Pick<
        GatewayPolicyUpdate,
        "capabilities" | "budget" | "fallback_config"
      >;
    }
  | { kind: "error"; message: string } {
  const maxContextTokens = parseNonNegative(
    fields.maxContextTokens,
    "컨텍스트 한도",
  );
  const maxInputTokens = parseNonNegative(
    fields.maxInputTokens,
    "입력 토큰 한도",
  );
  const maxOutputTokens = parseNonNegative(
    fields.maxOutputTokens,
    "출력 토큰 한도",
  );
  const maxCost = parseNonNegative(fields.maxCost, "비용 한도");
  if (typeof maxContextTokens !== "number")
    return { kind: "error", message: maxContextTokens.error };
  if (typeof maxInputTokens !== "number")
    return { kind: "error", message: maxInputTokens.error };
  if (typeof maxOutputTokens !== "number")
    return { kind: "error", message: maxOutputTokens.error };
  if (typeof maxCost !== "number")
    return { kind: "error", message: maxCost.error };
  const fallbackName = fields.fallbackModel.trim();
  const fallback_config =
    fallbackName.length > 0
      ? { ...(body.fallback_config ?? {}), model: fallbackName }
      : (body.fallback_config ?? null);
  return {
    kind: "ok",
    body: {
      capabilities: {
        ...body.capabilities,
        maxContextTokens,
        jsonMode: fields.jsonMode,
        vision: fields.vision,
      },
      budget: { ...body.budget, maxInputTokens, maxOutputTokens, maxCost },
      fallback_config,
    },
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function errorText(err: unknown): string {
  if (err instanceof ApiError && err.code === "LLM_CAPABILITY_MISMATCH") {
    return "예산(토큰)이 모델 컨텍스트 한도를 초과합니다.";
  }
  return errorLabel(err);
}
