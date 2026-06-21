/**
 * 자연어 generation 결정형 MVP 플래너 + IR-building + prompt/instruction-analysis (scenario-generations.ts 분해).
 *
 * deterministicMvpScenarioPlanner(prompt+hints→contract-valid draft IR + blockers) + run-time IR 변환
 * (prepareGenerationRunIr·ensureStartUrlNavigation·finalizeDraftIrEvidence) + 추출/페이지네이션 instruction
 * 빌더 + prompt 분석(부작용·페이지네이션 의도 판정). route/persist orchestration(planAndCompileScenario·
 * finalizePlannerEvidence 등)은 scenario-generations.ts에 잔류하며 본 모듈의 export(7)를 호출한다(단방향).
 * 동작 무변경 이동 — 새 추상화 0.
 */
import { createHash } from "node:crypto";

import { isRecord } from "./command";
import { ApiResponseError } from "./errors";
import {
  DEFAULT_PAGINATION_MAX_PAGES,
  MAX_AUTO_PAGINATION_PAGES,
  recordingPolicy,
  type RecordingPolicy,
} from "./scenario-generation-policy";
import type { ApiServerDeps } from "./server";
import type {
  EvidencePolicy,
  GenerationCapabilities,
  GenerationPlan,
  GenerationRequest,
  ScenarioPlanner,
  ScenarioPlannerId,
} from "./scenario-generation-types";
import { extractFirstHttpUrl, hostOfHttpUrl, isHttpUrl } from "./scenario-generation-url";

import {
  extractNode,
  extractionFieldPlan,
  extractionInstruction,
  paginatedExtractionInstruction,
} from "./scenario-generation-extraction";

export interface PaginationPlan {
  enabled: boolean;
  maxPages?: number;
  blocker?: string;
}

const deterministicMvpScenarioPlanner: ScenarioPlanner = {
  id: "deterministic_mvp",
  plan: buildDeterministicMvpGenerationPlan,
};

export function finalizeDraftIrEvidence(
  draftIr: Record<string, unknown>,
  evidence: EvidencePolicy,
  recording: RecordingPolicy,
): Record<string, unknown> {
  const meta = isRecord(draftIr.meta) ? draftIr.meta : {};
  const next: Record<string, unknown> = {
    ...draftIr,
    meta: { ...meta, evidence },
  };
  if (isRecord(draftIr.nodes)) {
    next.nodes = Object.fromEntries(
      Object.entries(draftIr.nodes).map(([nodeId, node]) => [nodeId, finalizeNodeRecordingPolicy(node, recording)]),
    );
  }
  return next;
}

function finalizeNodeRecordingPolicy(node: unknown, recording: RecordingPolicy): unknown {
  if (!isRecord(node) || !Array.isArray(node.what)) return node;
  const policy = isRecord(node.policy) ? node.policy : {};
  return { ...node, policy: { ...policy, recording } };
}

/**
 * navigate(open_start_url) 결정형 verify — 현재 URL 이 start_url 과 동일 host(서브도메인·www·http↔https 허용)에
 * 머무는지 검사한다. off-host 리다이렉트(로그인 벽·에러·차단·도메인 파킹)를 조용한 false 대신 loud fail_business 로
 * 전환하고(생성 시나리오를 P0b self-heal 에 연결: navigate 는 read-only — 일시적 적재 실패는 재navigate 로 자가복구),
 * host 파싱 불가 시 verify 를 방출하지 않는다(없는 근거로 잘못된 false 를 만들지 않는다).
 */
export function startUrlLandingVerify(startUrl: string): Record<string, unknown> | undefined {
  const host = hostOfHttpUrl(startUrl);
  if (host === null || host.length === 0) return undefined;
  const baseHost = host.replace(/^www\./, "");
  const escaped = baseHost.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = `^https?://(?:[^/]*\\.)?${escaped}(?:[:/?#]|$)`;
  return { criteria: [{ type: "url_matches", pattern }] };
}

function buildDeterministicMvpGenerationPlan(request: GenerationRequest, capabilities: GenerationCapabilities): GenerationPlan {
  const promptHash = createHash("sha256").update(request.prompt).digest("hex");
  const startUrl = request.startUrl ?? extractFirstHttpUrl(request.prompt);
  const params = { ...request.params };
  if (startUrl !== undefined) {
    params.start_url = startUrl;
  }
  const target = request.target;
  const evidence = request.evidence;
  const recording = recordingPolicy(evidence);
  const pagination = paginationPlan(request.prompt, params);
  const extractionFields = extractionFieldPlan(request.prompt);
  const blockers: string[] = [];
  if (request.mode === "save_and_run") {
    if (target === undefined) blockers.push("target_required_for_auto_run");
    if (startUrl === undefined) blockers.push("start_url_required_for_auto_run");
  }
  if (looksLikeSideEffectPrompt(request.prompt, { allowPaginationControls: pagination.enabled })) {
    blockers.push("side_effect_prompt_requires_review");
  }
  if (evidence.video !== "never" && !capabilities.videoRecording) {
    blockers.push("video_recording_port_not_configured");
  }
  if (pagination.blocker !== undefined) {
    blockers.push(pagination.blocker);
  }

  const nodes: Record<string, unknown> = {};
  const observeNode = {
    what: [{ action: "observe", instruction: request.prompt }],
    next: "extract_results",
    policy: { recording },
    side_effect: { kind: "read_only" },
  };
  if (startUrl !== undefined) {
    const landingVerify = startUrlLandingVerify(startUrl);
    nodes.open_start_url = {
      what: [{ action: "navigate", url_ref: "start_url" }],
      next: pagination.enabled ? "paginate_pages" : "understand_request",
      policy: { recording },
      side_effect: { kind: "read_only" },
      ...(landingVerify !== undefined ? { verify: landingVerify } : {}),
    };
    if (!pagination.enabled) {
      nodes.understand_request = observeNode;
    }
  } else {
    if (!pagination.enabled) {
      nodes.understand_request = observeNode;
    }
  }
  if (pagination.enabled) {
    nodes.paginate_pages = paginateLoopNode(pagination, recording);
    nodes.extract_current_page = extractNode({
      instruction: paginatedExtractionInstruction(request.prompt, extractionFields),
      next: "advance_page",
      recording,
      schemaRef: "generated/paginated_result@1",
      fields: extractionFields,
    });
    nodes.advance_page = {
      what: [{ action: "act", instruction: advancePageInstruction(request.prompt) }],
      next: "paginate_pages",
      policy: { recording },
      side_effect: { kind: "read_only" },
    };
  } else {
    nodes.extract_results = extractNode({
      instruction: extractionInstruction(request.prompt, extractionFields),
      next: "done",
      recording,
      schemaRef: "generated/default_result@1",
      fields: extractionFields,
    });
  }
  nodes.done = { terminal: "success" };

  const draftIr: Record<string, unknown> = {
    meta: {
      name: request.name ?? `prompt-${promptHash.slice(0, 12)}`,
      version: 1,
      ir_version: "1.x",
      studio_mode: "easy",
      evidence,
    },
    params_schema: paramsSchema({
      hasStartUrl: startUrl !== undefined,
      pagination: pagination.enabled,
      startUrl,
      maxPages: pagination.maxPages,
    }),
    ...(target !== undefined ? { target } : {}),
    start: startUrl !== undefined ? "open_start_url" : pagination.enabled ? "paginate_pages" : "understand_request",
    nodes,
  };

  return {
    planner: "deterministic_mvp",
    request: { ...request, ...(startUrl !== undefined ? { startUrl } : {}), params },
    promptHash,
    draftIr,
    blockers,
  };
}

export function scenarioPlannerFor(deps: ApiServerDeps, requested: ScenarioPlannerId | undefined): ScenarioPlanner {
  if (requested === undefined || requested === "deterministic_mvp") {
    return deterministicMvpScenarioPlanner;
  }
  if (deps.scenarioGenerationPlanner?.id === requested) {
    return deps.scenarioGenerationPlanner;
  }
  throw new ApiResponseError("RESOURCE_NOT_FOUND", { reason: "scenario_planner_not_configured", planner: requested });
}

function paramsSchema(options: { hasStartUrl: boolean; pagination: boolean; startUrl?: string; maxPages?: number }): Record<string, unknown> {
  const required: string[] = [];
  if (options.hasStartUrl) required.push("start_url");
  if (options.pagination) required.push("max_pages");
  return {
    type: "object",
    additionalProperties: true,
    properties: {
      as_of: { type: "string" },
      ...(options.hasStartUrl
        ? {
            start_url: {
              type: "string",
              format: "uri",
              ...(options.startUrl !== undefined ? { default: options.startUrl } : {}),
            },
          }
        : {}),
      ...(options.pagination
        ? {
            max_pages: {
              type: "integer",
              minimum: 1,
              maximum: MAX_AUTO_PAGINATION_PAGES,
              default: options.maxPages ?? DEFAULT_PAGINATION_MAX_PAGES,
            },
          }
        : {}),
    },
    ...(required.length > 0 ? { required } : {}),
  };
}

export function prepareGenerationRunIr(
  baseIr: Record<string, unknown>,
  input: {
    target?: NonNullable<GenerationRequest["target"]>;
    startUrl?: string;
    evidence: EvidencePolicy;
    recording: RecordingPolicy;
  },
): Record<string, unknown> {
  let next = finalizeDraftIrEvidence(baseIr, input.evidence, input.recording);
  if (input.target !== undefined) {
    next = { ...next, target: input.target };
  }
  if (input.startUrl !== undefined) {
    next = ensureStartUrlNavigation(next, input.recording, input.startUrl);
  }
  return next;
}

function ensureStartUrlNavigation(ir: Record<string, unknown>, recording: RecordingPolicy, startUrl?: string): Record<string, unknown> {
  const nodes = isRecord(ir.nodes) ? { ...ir.nodes } : {};
  const currentStart = typeof ir.start === "string" ? ir.start : undefined;
  const openStart = nodes.open_start_url;
  if (!isStartUrlNavigationNode(openStart)) {
    const landingVerify = startUrl !== undefined ? startUrlLandingVerify(startUrl) : undefined;
    nodes.open_start_url = {
      what: [{ action: "navigate", url_ref: "start_url" }],
      next: startAfterOpenStart(nodes, currentStart),
      policy: { recording },
      side_effect: { kind: "read_only" },
      ...(landingVerify !== undefined ? { verify: landingVerify } : {}),
    };
  } else {
    nodes.open_start_url = finalizeNodeRecordingPolicy(openStart, recording);
  }

  return {
    ...ir,
    params_schema: ensureStartUrlParamSchema(ir.params_schema, startUrl),
    start: "open_start_url",
    nodes,
  };
}

function isStartUrlNavigationNode(value: unknown): boolean {
  if (!isRecord(value) || !Array.isArray(value.what)) return false;
  return value.what.some((step) => isRecord(step) && step.action === "navigate" && step.url_ref === "start_url");
}

function startAfterOpenStart(nodes: Record<string, unknown>, currentStart: string | undefined): string {
  if (currentStart !== undefined && currentStart !== "open_start_url") return currentStart;
  if (isRecord(nodes.paginate_pages)) return "paginate_pages";
  if (isRecord(nodes.understand_request)) return "understand_request";
  const first = Object.keys(nodes).find((nodeId) => nodeId !== "open_start_url" && nodeId !== "done");
  return first ?? "done";
}

function ensureStartUrlParamSchema(value: unknown, startUrl?: string): Record<string, unknown> {
  const schema = isRecord(value) ? value : { type: "object", additionalProperties: true };
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const existingStartUrl = isRecord(properties.start_url) ? properties.start_url : {};
  const required = Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === "string") : [];
  return {
    ...schema,
    type: "object",
    additionalProperties: schema.additionalProperties ?? true,
    properties: {
      ...properties,
      start_url: {
        ...existingStartUrl,
        type: "string",
        format: "uri",
        ...(startUrl !== undefined ? { default: startUrl } : {}),
      },
    },
    required: uniqueStrings([...required, "start_url"]),
  };
}

export function startUrlFromParams(params: Record<string, unknown>): string | undefined {
  return typeof params.start_url === "string" && isHttpUrl(params.start_url) ? params.start_url : undefined;
}

export function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function paginateLoopNode(pagination: PaginationPlan, recording: RecordingPolicy): Record<string, unknown> {
  const maxPages = pagination.maxPages ?? DEFAULT_PAGINATION_MAX_PAGES;
  return {
    loop: {
      body_target: "extract_current_page",
      exit_target: "done",
      until: "loop.page_count >= params.max_pages",
      max_iterations: maxPages,
    },
    policy: { recording },
    side_effect: { kind: "read_only" },
  };
}

function advancePageInstruction(prompt: string): string {
  return [
    "현재 페이지의 다음 페이지, next, 더보기, load more 버튼이나 링크가 있으면 한 번만 클릭한다.",
    "다음 페이지 컨트롤이 없거나 비활성화되어 있으면 아무 입력도 하지 않고 성공으로 끝낸다.",
    "데이터를 수정하거나 제출하거나 삭제하는 컨트롤은 클릭하지 않는다.",
    `사용자 요청: ${prompt}`,
  ].join("\n");
}

export function paginationPlan(prompt: string, params: Record<string, unknown>): PaginationPlan {
  if (!looksLikePaginationPrompt(prompt)) return { enabled: false };
  const explicitParam = params.max_pages;
  const explicitPrompt = explicitParam === undefined ? promptMaxPages(prompt) : undefined;
  const requested = explicitParam ?? explicitPrompt ?? DEFAULT_PAGINATION_MAX_PAGES;
  if (typeof requested !== "number" || !Number.isInteger(requested) || requested < 1) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_max_pages", min: 1, max: MAX_AUTO_PAGINATION_PAGES });
  }
  if (requested > MAX_AUTO_PAGINATION_PAGES) {
    params.max_pages = MAX_AUTO_PAGINATION_PAGES;
    return { enabled: true, maxPages: MAX_AUTO_PAGINATION_PAGES, blocker: "pagination_page_limit_exceeded" };
  }
  params.max_pages = requested;
  return { enabled: true, maxPages: requested };
}

function looksLikePaginationPrompt(prompt: string): boolean {
  return /(?:모든\s*페이지|전체\s*페이지|여러\s*페이지|다음\s*페이지|페이지마다|페이지네이션|더\s*보기|더보기|끝까지\s*(?:페이지|목록|결과)|(?:페이지|목록|결과)\s*끝까지|all\s+pages|every\s+page|next\s+page|pagination|load\s+more)/i.test(prompt);
}

function promptMaxPages(prompt: string): number | undefined {
  const patterns = [
    /(?:최대|처음|상위|앞)\s*(\d{1,3})\s*페이지/i,
    /(\d{1,3})\s*페이지(?:까지|만|분량|이내)/i,
    /(?:max|first|up to)\s*(\d{1,3})\s*pages?/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(prompt);
    if (match?.[1] !== undefined) return Number(match[1]);
  }
  return undefined;
}

export function looksLikeSideEffectPrompt(prompt: string, options: { allowPaginationControls?: boolean } = {}): boolean {
  const text = options.allowPaginationControls ? stripBenignPaginationControls(prompt) : prompt;
  return /(클릭|입력|제출|등록|삭제|수정|업로드|다운로드|승인|반려|결재|보내|전송|구매|예약|click|type|submit|delete|update|upload|approve|reject|purchase|send)/i.test(text);
}

function stripBenignPaginationControls(prompt: string): string {
  return prompt
    .replace(/\bclick\s+(?:the\s+)?(?:next(?:\s+page)?|load\s+more|more)(?:\s+(?:button|link))?\b/gi, " ")
    .replace(/\b(?:next(?:\s+page)?|load\s+more|more)\s+(?:button|link)\s+click\b/gi, " ")
    .replace(/(?:다음\s*(?:페이지)?|더보기)\s*(?:버튼|링크)?(?:을|를)?\s*(?:클릭|눌러|선택)/g, " ")
    .replace(/(?:클릭|눌러|선택)\s*(?:해서|하여)?\s*(?:다음\s*(?:페이지)?|더보기)/g, " ");
}
