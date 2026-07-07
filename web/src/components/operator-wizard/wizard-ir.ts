// 운영자용 '쉬운 만들기' — IR/flags/동작 같은 기술 용어 없이 평이한 질문 몇 개로 유효 IR을 생성한다.
// 템플릿이 흐름(navigate→observe→extract→종료)을 고정하고, 운영자는 페이지 주소/데이터 이름만 채운다.
// navigate.url_ref 는 리터럴 URL이 아니라 run params 의 '키'다(런타임 site-resolution: 키-only, 리터럴 흡수 금지).
// 따라서 고정 키(entry_url)를 url_ref 로 쓰고, 입력 URL은 params_schema[entry_url].default 로 실어 실행 대화상자가
// 그 값으로 입력을 prefill하게 한다. 페이지 주소는 default 로 쓸 절대 URL(http/https)인지 검증한다.
// ※ 산출 IR은 '구조'다 — 실제로 그 페이지에서 데이터를 가져오려면 실행기 연결 + 사이트별 추출 설정이 필요하다.

export type Kind = "list" | "once";
export type TemplateKey = "list_collect" | "approval_branch" | "approval_decide" | "attachment_download" | "form_entry" | "login_lookup";
export interface OperatorWizardInitial {
  readonly name: string;
  readonly pageUrl: string;
  readonly dataName: string;
  readonly kind: Kind;
  readonly instruction: string;
  readonly maxPages?: number;
  readonly nextInstruction?: string;
  readonly noNextFlag?: string;
  // 승인 후 분기(@human_task) 라운드트립 — template="approval_branch" 면 승인 분기 양식 복원.
  readonly template?: TemplateKey;
  readonly assigneeRole?: string;
}

export interface PaginationOptions {
  readonly maxPages?: number;
  readonly nextInstruction?: string;
  readonly noNextFlag?: string;
}

export const TEMPLATES: Readonly<Record<TemplateKey, { label: string; defaultName: string; dataName: string; kind: Kind; instruction: string; success: string }>> = {
  list_collect: {
    label: "목록 수집",
    defaultName: "목록 수집 자동화",
    dataName: "수집목록",
    kind: "list",
    instruction: "목록의 각 행에서 제목, 작성자, 날짜, 상태처럼 반복되는 값을 추출하라.",
    success: "수집할 행이 없으면 데이터 없음으로 종료하고, 있으면 행 단위 결과를 만든다.",
  },
  approval_branch: {
    label: "승인 후 분기 (사람 판정)",
    defaultName: "승인 후 분기 자동화",
    dataName: "",
    kind: "once",
    instruction: "",
    success: "",
  },
  approval_decide: {
    label: "결재 처리",
    defaultName: "결재 처리 자동화",
    dataName: "결재정보",
    kind: "once",
    instruction: "결재 문서의 제목, 기안자, 금액, 현재 상태와 승인/반려 판단에 필요한 핵심 값을 추출하라.",
    success: "결재 대상 문서 한 건의 상태와 처리 가능 여부를 확인한다.",
  },
  attachment_download: {
    label: "첨부 다운로드",
    defaultName: "첨부 확인 자동화",
    dataName: "첨부목록",
    kind: "list",
    instruction: "화면에 표시된 첨부 파일명, 다운로드 링크, 파일 상태를 추출하라.",
    success: "첨부가 없으면 데이터 없음으로 종료하고, 있으면 첨부별 참조 정보를 만든다.",
  },
  form_entry: {
    label: "양식 입력",
    defaultName: "양식 입력 자동화",
    dataName: "입력결과",
    kind: "once",
    instruction: "입력 전후 화면 상태와 제출 결과 메시지를 확인해 양식 처리 결과를 추출하라.",
    success: "제출 완료 메시지 또는 업무 실패 메시지를 분명히 확인한다.",
  },
  login_lookup: {
    label: "로그인 후 조회",
    defaultName: "로그인 조회 자동화",
    dataName: "조회결과",
    kind: "once",
    instruction: "로그인 후 도착한 조회 화면에서 요청한 대상의 핵심 값을 추출하라.",
    success: "로그인 필요, 대상 없음, 조회 성공을 구분한다.",
  },
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// 절대 URL(http/https) 검증 — 실행기 navigate 요구사항.
export function urlState(s: string): "empty" | "ok" | "bad" {
  const v = s.trim();
  if (v === "") return "empty";
  try {
    const u = new URL(v);
    return u.protocol === "http:" || u.protocol === "https:" ? "ok" : "bad";
  } catch {
    return "bad";
  }
}

// url_ref 로 쓰는 고정 params 키. 입력 URL은 이 키의 params_schema default 로 실린다.
const ENTRY_KEY = "entry_url";
export const DEFAULT_MAX_PAGES = 3;
export const DEFAULT_NEXT_INSTRUCTION = "다음 페이지 버튼을 눌러 다음 목록 화면으로 이동하라.";
export const DEFAULT_NO_NEXT_FLAG = "no_next_page";
export const PAGE_END_FLAGS = ["no_next_page", "cursor_reached", "not_found"] as const;

function defaultInstruction(dataName: string, kind: Kind): string {
  const label = dataName.trim() || "필요한 데이터";
  return kind === "list"
    ? `페이지의 목록에서 ${label} 항목을 행 단위로 추출하라.`
    : `현재 페이지에서 ${label} 값을 추출하라.`;
}

function composeInstruction(instruction: string, successCriteria: string): string {
  const base = instruction.trim();
  const success = successCriteria.trim();
  return success.length > 0 ? `${base}\n성공 기준: ${success}` : base;
}

function clampMaxPages(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return DEFAULT_MAX_PAGES;
  return Math.max(1, Math.min(100, Math.floor(n)));
}

function sanitizeFlag(value: unknown): string {
  return typeof value === "string" && PAGE_END_FLAGS.includes(value as (typeof PAGE_END_FLAGS)[number])
    ? value
    : DEFAULT_NO_NEXT_FLAG;
}

function extractFlagFromUntil(until: unknown): string {
  if (typeof until !== "string") return DEFAULT_NO_NEXT_FLAG;
  const match = /flags\.([A-Za-z_][A-Za-z0-9_]*)/.exec(until);
  return sanitizeFlag(match?.[1]);
}

export function buildIr(
  name: string,
  pageUrl: string,
  dataName: string,
  kind: Kind,
  instruction = defaultInstruction(dataName, kind),
  successCriteriaOrVersion: string | number = "",
  versionMaybe = 1,
  pagination: PaginationOptions = {},
): unknown {
  const successCriteria = typeof successCriteriaOrVersion === "number" ? "" : successCriteriaOrVersion;
  const version = typeof successCriteriaOrVersion === "number" ? successCriteriaOrVersion : versionMaybe;
  const meta = { name: name.trim() || "새 자동화", version, studio_mode: "easy" };
  // url_ref = 고정 키(ENTRY_KEY). 입력 URL은 url_ref 에 박지 않고 params_schema[entry_url].default 로 싣는다
  // (유효 http(s) URL일 때만) — 실행 대화상자가 이 default 로 prefill한다. 무효/빈값이면 default 없이 키만 선언.
  const entryParam: Record<string, unknown> = { type: "string", description: "실행 대상 페이지 주소" };
  if (urlState(pageUrl) === "ok") entryParam.default = pageUrl.trim();
  const params_schema = { type: "object", properties: { [ENTRY_KEY]: entryParam }, required: [ENTRY_KEY] };
  const schemaRef = dataName.trim() || "수집데이터";
  const baseInstruction = instruction.trim().length > 0 ? instruction : defaultInstruction(dataName, kind);
  const extractInstruction = composeInstruction(baseInstruction, successCriteria);
  if (kind === "list") {
    const maxPages = clampMaxPages(pagination.maxPages);
    const maxAdditionalPages = Math.max(0, maxPages - 1);
    const nextInstruction =
      typeof pagination.nextInstruction === "string" && pagination.nextInstruction.trim().length > 0
        ? pagination.nextInstruction.trim()
        : DEFAULT_NEXT_INSTRUCTION;
    const noNextFlag = sanitizeFlag(pagination.noNextFlag);
    const nodes: Record<string, Record<string, unknown>> = {
      open: { what: [{ action: "navigate", url_ref: ENTRY_KEY }], next: "collect" },
      collect: {
        what: [{ action: "extract", instruction: extractInstruction, schema_ref: schemaRef }],
        next: maxAdditionalPages > 0 ? "page_loop" : "done",
      },
      done: { terminal: "success" },
    };
    if (maxAdditionalPages > 0) {
      nodes.page_loop = {
        loop: {
          body_target: "next_page",
          exit_target: "done",
          until: `flags.${noNextFlag} || loop.page_count >= ${maxAdditionalPages}`,
          max_iterations: maxAdditionalPages,
        },
      };
      nodes.next_page = { what: [{ action: "act", instruction: nextInstruction }], next: "collect" };
    }
    return {
      meta,
      params_schema,
      start: "open",
      nodes,
    };
  }
  // 한 번만: 사이트 열기 → 가져오기 → 마무리.
  return {
    meta,
    params_schema,
    start: "open",
    nodes: {
      open: { what: [{ action: "navigate", url_ref: ENTRY_KEY }], next: "collect" },
      collect: { what: [{ action: "extract", instruction: extractInstruction, schema_ref: schemaRef }], next: "done" },
      done: { terminal: "success" },
    },
  };
}

// 승인 후 분기(@human_task approval) — 운영자가 양식으로 만드는 사람 판정 분기 자동화.
//   open(navigate) → review(@human_task approval, return_node=decide) → decide(on node.review.decision)
//   → approved(success) / rejected(fail_business). 분기 골격은 고정(승인=완료/반려=업무실패), 운영자는
//   이름·페이지·승인자 역할만 채운다. 더 정교한 분기는 '직접 편집'에서. (C1–C3 계약/런타임이 이 형태를 실행한다.)
export const APPROVAL_ASSIGNEE_ROLES = ["approver", "reviewer"] as const;
export const DEFAULT_ASSIGNEE_ROLE = "approver";

function sanitizeAssigneeRole(role: string | undefined): string {
  return role !== undefined && (APPROVAL_ASSIGNEE_ROLES as readonly string[]).includes(role)
    ? role
    : DEFAULT_ASSIGNEE_ROLE;
}

export function buildApprovalIr(name: string, pageUrl: string, assigneeRole: string, version = 1): unknown {
  const entryParam: Record<string, unknown> = { type: "string", description: "승인 대상이 보이는 페이지 주소" };
  if (urlState(pageUrl) === "ok") entryParam.default = pageUrl.trim();
  return {
    meta: { name: name.trim() || "승인 후 분기 자동화", version, studio_mode: "easy" },
    params_schema: { type: "object", properties: { [ENTRY_KEY]: entryParam }, required: [ENTRY_KEY] },
    start: "open",
    nodes: {
      open: { what: [{ action: "navigate", url_ref: ENTRY_KEY }], next: "review" },
      review: {
        what: [],
        next: {
          handler: "@human_task",
          input: { kind: "approval", assignee_role: sanitizeAssigneeRole(assigneeRole) },
          return_node: "decide",
        },
      },
      decide: {
        on: [
          { when: 'node.review.decision == "approve"', target: "approved", priority: 2 },
          { when: "true", target: "rejected", priority: 1 },
        ],
      },
      approved: { terminal: "success" },
      rejected: { terminal: "fail_business" },
    },
  };
}

// 승인 분기 IR 의 라운드트립 — 양식 필드(이름/URL/역할)를 복원하되, **재생성 결과가 원본과 구조적으로 일치할 때만** 인정한다.
//   (운영자가 '직접 편집'에서 분기 구조를 손보면 재생성으로 그 수정을 무음 손실하므로, 불일치 시 undefined → 쉬운 만들기 잠금.)
//   비교는 백엔드/콘솔이 주입·변형하는 필드(ir.target·meta.studio_mode·meta.version)를 제외하고 key 순서 무관(canonical)으로
//   수행한다 — 저장(scenarios.ts: {...ir, target} + jsonb key 재배열)을 거친 IR 도 동일 구조면 라운드트립 가능(저장본 재편집).
function approvalInitialFromIr(ir: unknown): OperatorWizardInitial | undefined {
  if (!isRecord(ir) || !isRecord(ir.nodes)) return undefined;
  const review = isRecord(ir.nodes.review) ? ir.nodes.review : undefined;
  const call = review !== undefined && isRecord(review.next) ? review.next : undefined;
  if (call === undefined || call.handler !== "@human_task") return undefined;
  const input = isRecord(call.input) ? call.input : {};
  const assigneeRole = sanitizeAssigneeRole(typeof input.assignee_role === "string" ? input.assignee_role : undefined);
  const meta = isRecord(ir.meta) ? ir.meta : {};
  const name = typeof meta.name === "string" ? meta.name : "승인 후 분기 자동화";
  const properties = isRecord(ir.params_schema) && isRecord(ir.params_schema.properties) ? ir.params_schema.properties : {};
  const entryParam = isRecord(properties[ENTRY_KEY]) ? properties[ENTRY_KEY] : {};
  const pageUrl = typeof entryParam.default === "string" ? entryParam.default : "";
  // 구조 동등성 검사: 비교-무관 필드 제외 + canonical(key 정렬) 후 재생성 IR 과 일치하면 손실 없이 라운드트립.
  if (approvalCanonical(buildApprovalIr(name, pageUrl, assigneeRole)) !== approvalCanonical(ir)) {
    return undefined;
  }
  return { name, pageUrl, dataName: "", kind: "once", instruction: "", template: "approval_branch", assigneeRole };
}

// 비교용 정규화 — 저장이 주입·변형하는 비교-무관 필드를 제거하고 key 순서를 무관화(jsonb 재배열 흡수)한다.
//   ir.target: 저장 시 시작 URL→사이트 자동 추론 주입(scenarios.ts). easy 재저장 시 동일 URL 로 재추론되어 무손실.
//   meta.studio_mode/version: 콘솔 스탬프·편집 버전 bump(+1). 분기 구조 동등성과 무관.
function approvalCanonical(ir: unknown): string {
  return canonicalJson(stripApprovalVolatile(ir));
}

function stripApprovalVolatile(ir: unknown): unknown {
  if (!isRecord(ir)) return ir;
  const clone: Record<string, unknown> = { ...ir };
  delete clone.target;
  if (isRecord(clone.meta)) {
    const meta = { ...clone.meta };
    delete meta.studio_mode;
    delete meta.version;
    clone.meta = meta;
  }
  return clone;
}

// key 순서 무관 canonical JSON(객체 key 재귀 정렬; 배열 순서는 의미 보존). jsonb round-trip 의 key 재배열을 흡수.
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function wizardInitialFromIr(ir: unknown): OperatorWizardInitial | undefined {
  if (!isRecord(ir) || !isRecord(ir.nodes)) return undefined;
  // 예약 핸들러(@human_task) 포함 IR: 승인 분기 정형이면 라운드트립, 아니면 쉬운 만들기로 표현 불가(undefined → 잠금).
  if (Object.values(ir.nodes).some((n) => isRecord(n) && isRecord(n.next) && typeof n.next.handler === "string")) {
    return approvalInitialFromIr(ir);
  }
  const meta = isRecord(ir.meta) ? ir.meta : {};
  const name = typeof meta.name === "string" ? meta.name : "새 자동화";
  const paramsSchema = isRecord(ir.params_schema) ? ir.params_schema : {};
  const properties = isRecord(paramsSchema.properties) ? paramsSchema.properties : {};
  const entryParam = isRecord(properties[ENTRY_KEY]) ? properties[ENTRY_KEY] : {};
  const pageUrl = typeof entryParam.default === "string" ? entryParam.default : "";
  const nodes = ir.nodes;
  const collect = isRecord(nodes.collect) ? nodes.collect : {};
  const what = Array.isArray(collect.what) ? collect.what : [];
  const extract = what.find((item) => isRecord(item) && item.action === "extract");
  const extractRecord = isRecord(extract) ? extract : {};
  const dataName = typeof extractRecord.schema_ref === "string" ? extractRecord.schema_ref : "";
  const pageLoop = isRecord(nodes.page_loop) ? nodes.page_loop : {};
  const loop = isRecord(pageLoop.loop) ? pageLoop.loop : {};
  const nextPage = isRecord(nodes.next_page) ? nodes.next_page : {};
  const nextWhat = Array.isArray(nextPage.what) ? nextPage.what : [];
  const nextAction = isRecord(nextWhat[0]) ? nextWhat[0] : {};
  const kind: Kind = isRecord(nodes.check) || isRecord(nodes.page_loop) || isRecord(nodes.next_page) ? "list" : "once";
  const instruction =
    typeof extractRecord.instruction === "string" && extractRecord.instruction.trim().length > 0
      ? extractRecord.instruction
      : defaultInstruction(dataName, kind);
  const maxIterations = typeof loop.max_iterations === "number" ? loop.max_iterations : 0;
  const maxPages = kind === "list" ? Math.max(1, maxIterations + 1) : undefined;
  const nextInstruction =
    typeof nextAction.instruction === "string" && nextAction.instruction.trim().length > 0
      ? nextAction.instruction
      : undefined;
  // 쉬운 만들기(OperatorWizard)는 템플릿 기반 단순화기 — collect IR 은 best-effort prefill 로 표현(엄격 라운드트립 아님,
  //   기존 설계: 쉬운 만들기는 자동화를 '템플릿 형태로 단순화'). 예약 핸들러 미포함 collect 류는 항상 쉬운 만들기로 연다.
  return { name, pageUrl, dataName, kind, instruction, maxPages, nextInstruction, noNextFlag: extractFlagFromUntil(loop.until) };
}
