/**
 * 자연어 generation 요청/쿼리 파서 (scenario-generations.ts 분해 — 동작 무변경 이동).
 *
 * (1) list/query 파라미터 파서(limit·cursor·status·run_id·params_context) (2) 요청 body 파서
 * (parseGenerationRequest/RunRequest·parseTarget·parseEvidencePolicy·parseGenerationBlockers·cloneJsonRecord)
 * + 내부 헬퍼(parseScenarioPlannerId·isStrictIsoDateTime). 공유 UUID_RE/ISO_8601_RE 보유. 무효 입력은
 * ApiResponseError(IR_SCHEMA_INVALID, 조용한 false 금지). 의존: isRecord(./command)·ApiResponseError(./errors)·
 * isHttpUrl(url leaf)·generation 타입(./scenario-generation-types). UUID_RE는 본 모듈 소유, 원본이 import.
 */
import { isRecord } from "./command";
import { ApiResponseError } from "./errors";
import { isHttpUrl } from "./scenario-generation-url";
import type {
  EvidencePolicy,
  GenerationRequest,
  GenerationRunRequest,
  GenerationStatus,
  ScenarioPlannerId,
} from "./scenario-generation-types";

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseParamsContext(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

export function parseListLimit(value: string | undefined): number {
  if (value === undefined) return 20;
  if (!/^\d+$/.test(value)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_limit" });
  }
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 100) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_limit", min: 1, max: 100 });
  }
  return n;
}

export function parseListCursor(value: string | undefined): { createdAt: string; id: string } | undefined {
  if (value === undefined || value.length === 0) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (
      isRecord(parsed) &&
      typeof parsed.created_at === "string" &&
      Number.isFinite(Date.parse(parsed.created_at)) &&
      typeof parsed.id === "string" &&
      UUID_RE.test(parsed.id)
    ) {
      return { createdAt: parsed.created_at, id: parsed.id };
    }
  } catch {
    // fall through to uniform API error
  }
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_cursor" });
}

export function parseGenerationStatusFilter(value: string | undefined): GenerationStatus | undefined {
  if (value === undefined || value.length === 0) return undefined;
  if (value === "drafted" || value === "saved" || value === "run_queued" || value === "blocked" || value === "failed") {
    return value;
  }
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_generation_status" });
}

export function parseRunIdFilter(value: string | undefined): string | undefined {
  if (value === undefined || value.length === 0) return undefined;
  if (UUID_RE.test(value)) return value;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_run_id" });
}

// ===== generation 요청 body 파서(scenario-generations.ts 분해 — 동작 무변경 이동) =====
const ISO_8601_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

export function parseGenerationRequest(body: unknown, defaultEvidence: EvidencePolicy): GenerationRequest {
  if (!isRecord(body)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "request_body_object_required" });
  }
  const allowed = new Set(["prompt", "name", "mode", "planner", "start_url", "target", "params", "model", "evidence"]);
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "unknown_field", field: key });
    }
  }
  if (typeof body.prompt !== "string" || body.prompt.trim().length === 0) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "prompt_required" });
  }
  if (body.prompt.length > 20000) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "prompt_too_long", max: 20000 });
  }
  if (body.name !== undefined && (typeof body.name !== "string" || body.name.trim().length === 0)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_generation_name" });
  }
  const mode = body.mode === undefined ? "save_and_run" : body.mode;
  if (mode !== "draft_only" && mode !== "save" && mode !== "save_and_run") {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_generation_mode" });
  }
  const planner = parseScenarioPlannerId(body.planner);
  const params = body.params === undefined ? {} : body.params;
  if (!isRecord(params)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "params_object_required" });
  }
  if (params.as_of !== undefined && (typeof params.as_of !== "string" || !isStrictIsoDateTime(params.as_of))) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_as_of" });
  }
  let startUrl: string | undefined;
  if (body.start_url !== undefined) {
    if (typeof body.start_url !== "string" || !isHttpUrl(body.start_url)) {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_start_url" });
    }
    startUrl = body.start_url;
  }
  let model: string | null | undefined;
  if (body.model !== undefined && body.model !== null) {
    if (typeof body.model !== "string" || body.model.length === 0) {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_model" });
    }
    model = body.model;
  } else if (body.model === null) {
    model = null;
  }

  return {
    prompt: body.prompt.trim(),
    ...(typeof body.name === "string" && body.name.trim().length > 0 ? { name: body.name.trim() } : {}),
    mode,
    ...(planner !== undefined ? { planner } : {}),
    ...(startUrl !== undefined ? { startUrl } : {}),
    target: parseTarget(body.target),
    params: params as Record<string, unknown>,
    ...(model !== undefined ? { model } : {}),
    evidence: parseEvidencePolicy(body.evidence, defaultEvidence),
  };
}

export function parseGenerationRunRequest(body: unknown): GenerationRunRequest {
  const requestBody = body === undefined || body === null ? {} : body;
  if (!isRecord(requestBody)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "request_body_object_required" });
  }
  const allowed = new Set(["target", "start_url", "params", "model", "evidence"]);
  for (const key of Object.keys(requestBody)) {
    if (!allowed.has(key)) {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "unknown_field", field: key });
    }
  }

  const params = requestBody.params === undefined ? {} : requestBody.params;
  if (!isRecord(params)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "params_object_required" });
  }
  if (params.as_of !== undefined && (typeof params.as_of !== "string" || !isStrictIsoDateTime(params.as_of))) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_as_of" });
  }

  let startUrl: string | undefined;
  if (requestBody.start_url !== undefined) {
    if (typeof requestBody.start_url !== "string" || !isHttpUrl(requestBody.start_url)) {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_start_url" });
    }
    startUrl = requestBody.start_url;
  }
  if (params.start_url !== undefined) {
    if (typeof params.start_url !== "string" || !isHttpUrl(params.start_url)) {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_start_url" });
    }
    if (startUrl !== undefined && params.start_url !== startUrl) {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "start_url_param_mismatch" });
    }
    startUrl = params.start_url;
  }

  let model: string | null | undefined;
  if (requestBody.model !== undefined && requestBody.model !== null) {
    if (typeof requestBody.model !== "string" || requestBody.model.length === 0) {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_model" });
    }
    model = requestBody.model;
  } else if (requestBody.model === null) {
    model = null;
  }

  return {
    target: parseTarget(requestBody.target),
    ...(startUrl !== undefined ? { startUrl } : {}),
    params: params as Record<string, unknown>,
    paramsProvided: requestBody.params !== undefined,
    ...(model !== undefined ? { model } : {}),
    ...(requestBody.evidence !== undefined ? { evidence: parseEvidencePolicy(requestBody.evidence) } : {}),
  };
}

export function parseTarget(value: unknown): GenerationRequest["target"] {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "target_object_required" });
  }
  const site = value.site_profile_id;
  const identity = value.browser_identity_id;
  const network = value.network_policy_id;
  if (typeof site !== "string" || !UUID_RE.test(site)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_site_profile_id" });
  }
  if (typeof identity !== "string" || !UUID_RE.test(identity)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_browser_identity_id" });
  }
  if (typeof network !== "string" || !UUID_RE.test(network)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_network_policy_id" });
  }
  return { site_profile_id: site, browser_identity_id: identity, network_policy_id: network };
}

export function parseEvidencePolicy(value: unknown, defaultEvidence: EvidencePolicy = { screenshot: "failure", video: "never" }): EvidencePolicy {
  if (value === undefined || value === null) {
    return defaultEvidence;
  }
  if (!isRecord(value)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "evidence_object_required" });
  }
  for (const key of Object.keys(value)) {
    if (key !== "screenshot" && key !== "video") {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "unknown_evidence_field", field: key });
    }
  }
  const screenshot = value.screenshot ?? defaultEvidence.screenshot;
  const video = value.video ?? defaultEvidence.video;
  if (screenshot !== "never" && screenshot !== "failure" && screenshot !== "each_step") {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_evidence_screenshot" });
  }
  if (video !== "never" && video !== "failure" && video !== "always") {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_evidence_video" });
  }
  return { screenshot, video };
}

function parseScenarioPlannerId(value: unknown): ScenarioPlannerId | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === "deterministic_mvp" || value === "llm_v1") return value;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_scenario_planner" });
}

export function parseGenerationBlockers(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "generation_blockers_invalid" });
  }
  const blockers: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.length === 0) {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "generation_blocker_invalid" });
    }
    blockers.push(item);
  }
  return blockers;
}

export function cloneJsonRecord(value: unknown, reason: string): Record<string, unknown> {
  const cloned = JSON.parse(JSON.stringify(value)) as unknown;
  if (!isRecord(cloned)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason });
  }
  return cloned;
}

function isStrictIsoDateTime(value: string): boolean {
  const m = ISO_8601_RE.exec(value);
  if (m === null) return false;
  const d = new Date(value);
  return Number.isFinite(d.getTime());
}
