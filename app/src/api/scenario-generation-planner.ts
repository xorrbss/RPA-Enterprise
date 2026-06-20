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
import { extractFirstHttpUrl, isHttpUrl } from "./scenario-generation-url";

export interface PaginationPlan {
  enabled: boolean;
  maxPages?: number;
  blocker?: string;
}

interface ExtractionFieldPlan {
  readonly name: string;
  readonly description: string;
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
    nodes.open_start_url = {
      what: [{ action: "navigate", url_ref: "start_url" }],
      next: pagination.enabled ? "paginate_pages" : "understand_request",
      policy: { recording },
      side_effect: { kind: "read_only" },
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
    nodes.open_start_url = {
      what: [{ action: "navigate", url_ref: "start_url" }],
      next: startAfterOpenStart(nodes, currentStart),
      policy: { recording },
      side_effect: { kind: "read_only" },
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

function extractNode(input: {
  instruction: string;
  next: string;
  recording: RecordingPolicy;
  schemaRef: string;
  fields: readonly ExtractionFieldPlan[];
}): Record<string, unknown> {
  return {
    what: [
      {
        action: "extract",
        instruction: input.instruction,
        schema_ref: input.schemaRef,
        args: {
          schema_version: "1",
          strict: true,
          schema: generatedExtractSchema(input.fields),
        },
      },
    ],
    next: input.next,
    policy: { recording: input.recording },
    side_effect: { kind: "read_only" },
  };
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

function generatedExtractSchema(fields: readonly ExtractionFieldPlan[]): Record<string, unknown> {
  const rowProperties: Record<string, unknown> = {};
  for (const field of fields) {
    rowProperties[field.name] = {
      type: "string",
      description: field.description,
    };
  }
  return {
    type: "object",
    additionalProperties: false,
    required: ["summary", "rows"],
    properties: {
      summary: { type: "string" },
      rows: {
        type: "array",
        items: {
          type: "object",
          ...(Object.keys(rowProperties).length > 0 ? { properties: rowProperties } : {}),
          additionalProperties: true,
        },
      },
    },
  };
}

const EXTRACTION_FIELD_CANDIDATES: readonly {
  readonly name: string;
  readonly description: string;
  readonly patterns: readonly RegExp[];
}[] = [
  {
    name: "title",
    description: "화면에 표시된 제목, 타이틀, 문서명, 게시글명 또는 항목명",
    patterns: [/(?:제목|타이틀|문서명|게시글명|공지명|항목명|\btitles?\b|\bsubjects?\b)/i],
  },
  {
    name: "url",
    description: "항목 상세 페이지나 참조 대상의 링크 URL",
    patterns: [/(?:링크|주소|\blinks?\b|\burls?\b|\bhref\b)/i],
  },
  {
    name: "date",
    description: "화면에 표시된 날짜, 작성일, 등록일, 마감일 또는 기한",
    patterns: [/(?:날짜|일자|작성일|등록일|마감일|기한|\bdate\b|\bcreated\b|\bupdated\b|\bdue\b)/i],
  },
  {
    name: "author",
    description: "작성자, 기안자, 요청자, 담당자 또는 소유자",
    patterns: [/(?:작성자|기안자|요청자|담당자|소유자|\bauthor\b|\bwriter\b|\brequester\b|\bowner\b)/i],
  },
  {
    name: "status",
    description: "업무 상태, 처리 상태, 승인/반려 상태 또는 진행 단계",
    patterns: [/(?:상태|진행\s*단계|승인|반려|\bstatus\b|\bstate\b|\bprogress\b)/i],
  },
  {
    name: "amount",
    description: "금액, 가격, 합계, 총액 또는 비용을 화면 원문에 가깝게 보존한 값",
    patterns: [/(?:금액|가격|합계|총액|비용|\bamount\b|\bprice\b|\btotal\b|\bcost\b)/i],
  },
  {
    name: "rating",
    description: "별점, 평점, 점수 또는 rating 값",
    patterns: [/(?:별점|평점|점수|\brating\b|\bscore\b)/i],
  },
  {
    name: "file_name",
    description: "첨부 파일명 또는 다운로드 대상 파일명",
    patterns: [/(?:첨부\s*파일명|파일명|\bfile\s*name\b|\bfilename\b)/i],
  },
  {
    name: "order_id",
    description: "주문번호, 주문 ID 또는 주문을 식별하는 번호",
    patterns: [/(?:주문\s*번호|주문\s*ID|\border\s*(?:id|number|no\.?)\b)/i],
  },
  {
    name: "document_id",
    description: "문서번호, 결재번호, 문서 ID 또는 문서를 식별하는 번호",
    patterns: [/(?:문서\s*번호|결재\s*번호|문서\s*ID|\bdocument\s*(?:id|number|no\.?)\b)/i],
  },
  {
    name: "quantity",
    description: "수량, 개수, 건수를 화면 원문에 가깝게 보존한 값",
    patterns: [/(?:수량|개수|건수|\bquantity\b|\bqty\b|\bcount\b)/i],
  },
  {
    name: "category",
    description: "분류, 구분, 유형 또는 카테고리",
    patterns: [/(?:분류|구분|유형|카테고리|\bcategory\b)/i],
  },
  {
    name: "department",
    description: "부서, 소속 또는 담당 조직",
    patterns: [/(?:부서|소속|\bdepartment\b|\bteam\b)/i],
  },
  {
    name: "phone",
    description: "전화번호, 연락처 또는 휴대폰 번호",
    patterns: [/(?:전화\s*번호|연락처|휴대폰|\bphone\b|\btel\b)/i],
  },
  {
    name: "email",
    description: "이메일 주소 또는 메일 주소",
    patterns: [/(?:이메일|메일\s*주소|\bemail\b|\be-mail\b)/i],
  },
];

function extractionFieldPlan(prompt: string): readonly ExtractionFieldPlan[] {
  const fields: ExtractionFieldPlan[] = [];
  const seen = new Set<string>();
  for (const candidate of EXTRACTION_FIELD_CANDIDATES) {
    if (seen.has(candidate.name)) continue;
    if (candidate.patterns.some((pattern) => pattern.test(prompt))) {
      seen.add(candidate.name);
      fields.push({ name: candidate.name, description: candidate.description });
    }
  }
  return fields;
}

function extractionInstruction(prompt: string, fields: readonly ExtractionFieldPlan[]): string {
  return [
    "사용자의 자연어 요청을 기준으로 화면에서 필요한 업무 결과를 추출한다.",
    "반환 형식은 { summary: string, rows: object[] } 이다.",
    ...extractionFieldInstructions(fields),
    "화면에 결과가 없으면 rows는 빈 배열로 두고 summary에 관찰 내용을 적는다.",
    `사용자 요청: ${prompt}`,
  ].join("\n");
}

function paginatedExtractionInstruction(prompt: string, fields: readonly ExtractionFieldPlan[]): string {
  return [
    "현재 페이지에 보이는 결과만 추출한다. 이전 페이지나 다음 페이지를 상상해 합치지 않는다.",
    "반복 실행 전체의 병합은 런타임이 담당한다. 각 페이지에서는 { summary: string, rows: object[] }만 반환한다.",
    ...extractionFieldInstructions(fields),
    "페이지에 결과가 없으면 rows는 빈 배열로 둔다.",
    `사용자 요청: ${prompt}`,
  ].join("\n");
}

function extractionFieldInstructions(fields: readonly ExtractionFieldPlan[]): string[] {
  if (fields.length === 0) return [];
  const names = fields.map((field) => field.name).join(", ");
  return [
    `rows의 각 객체는 가능한 경우 다음 snake_case 필드를 포함한다: ${names}.`,
    "필드 값을 화면에서 찾을 수 없으면 추측하지 말고 해당 필드를 생략한다.",
  ];
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

