import { useEffect, useState } from "react";

// 운영자용 '쉬운 만들기' — IR/flags/동작 같은 기술 용어 없이 평이한 질문 몇 개로 유효 IR을 생성한다.
// 템플릿이 흐름(navigate→observe→extract→종료)을 고정하고, 운영자는 페이지 주소/데이터 이름만 채운다.
// navigate.url_ref 는 리터럴 URL이 아니라 run params 의 '키'다(런타임 site-resolution: 키-only, 리터럴 흡수 금지).
// 따라서 고정 키(entry_url)를 url_ref 로 쓰고, 입력 URL은 params_schema[entry_url].default 로 실어 실행 대화상자가
// 그 값으로 입력을 prefill하게 한다. 페이지 주소는 default 로 쓸 절대 URL(http/https)인지 검증한다.
// ※ 산출 IR은 '구조'다 — 실제로 그 페이지에서 데이터를 가져오려면 실행기 연결 + 사이트별 추출 설정이 필요하다.

type Kind = "list" | "once";
type TemplateKey = "list_collect" | "approval_decide" | "attachment_download" | "form_entry" | "login_lookup";
export interface OperatorWizardInitial {
  readonly name: string;
  readonly pageUrl: string;
  readonly dataName: string;
  readonly kind: Kind;
  readonly instruction: string;
  readonly maxPages?: number;
  readonly nextInstruction?: string;
  readonly noNextFlag?: string;
}

export interface PaginationOptions {
  readonly maxPages?: number;
  readonly nextInstruction?: string;
  readonly noNextFlag?: string;
}

const TEMPLATES: Readonly<Record<TemplateKey, { label: string; defaultName: string; dataName: string; kind: Kind; instruction: string; success: string }>> = {
  list_collect: {
    label: "목록 수집",
    defaultName: "목록 수집 자동화",
    dataName: "수집목록",
    kind: "list",
    instruction: "목록의 각 행에서 제목, 작성자, 날짜, 상태처럼 반복되는 값을 추출하라.",
    success: "수집할 행이 없으면 데이터 없음으로 종료하고, 있으면 행 단위 결과를 만든다.",
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
function urlState(s: string): "empty" | "ok" | "bad" {
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
const DEFAULT_MAX_PAGES = 3;
const DEFAULT_NEXT_INSTRUCTION = "다음 페이지 버튼을 눌러 다음 목록 화면으로 이동하라.";
const DEFAULT_NO_NEXT_FLAG = "no_next_page";
const PAGE_END_FLAGS = ["no_next_page", "cursor_reached", "not_found"] as const;

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
  const entryParam: Record<string, unknown> = { type: "string", description: "실행 대상 페이지 URL" };
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

export function wizardInitialFromIr(ir: unknown): OperatorWizardInitial | undefined {
  if (!isRecord(ir) || !isRecord(ir.nodes)) return undefined;
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
  return { name, pageUrl, dataName, kind, instruction, maxPages, nextInstruction, noNextFlag: extractFlagFromUntil(loop.until) };
}

function Field({ label, value, onChange, placeholder, hint, multiline }: { label: string; value: string; onChange: (v: string) => void; placeholder: string; hint?: JSX.Element; multiline?: boolean }): JSX.Element {
  return (
    <label style={{ display: "block", marginBottom: 10 }}>
      <span className="subtle">{label}</span>
      <br />
      {multiline === true ? (
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          rows={3}
          style={{ padding: "8px 10px", fontSize: 14, width: 520, maxWidth: "100%", boxSizing: "border-box", resize: "vertical" }}
        />
      ) : (
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          style={{ padding: "8px 10px", fontSize: 14, width: 420, maxWidth: "100%" }}
        />
      )}
      {hint !== undefined && <div style={{ marginTop: 4 }}>{hint}</div>}
    </label>
  );
}

export function OperatorWizard({ onChange, initial, version = 1 }: { onChange: (ir: unknown) => void; initial?: OperatorWizardInitial; version?: number }): JSX.Element {
  const [templateKey, setTemplateKey] = useState<TemplateKey>("list_collect");
  const template = TEMPLATES[templateKey];
  const [name, setName] = useState(initial?.name ?? template.defaultName);
  const [pageUrl, setPageUrl] = useState(initial?.pageUrl ?? "");
  const [dataName, setDataName] = useState(initial?.dataName ?? template.dataName);
  const [kind, setKind] = useState<Kind>(initial?.kind ?? template.kind);
  const [instruction, setInstruction] = useState(initial?.instruction ?? template.instruction);
  const [successCriteria, setSuccessCriteria] = useState(initial === undefined ? template.success : "");
  const [maxPages, setMaxPages] = useState(String(initial?.maxPages ?? DEFAULT_MAX_PAGES));
  const [nextInstruction, setNextInstruction] = useState(initial?.nextInstruction ?? DEFAULT_NEXT_INSTRUCTION);
  const [noNextFlag, setNoNextFlag] = useState(initial?.noNextFlag ?? DEFAULT_NO_NEXT_FLAG);
  const [instructionTouched, setInstructionTouched] = useState(initial !== undefined);
  // 세부 조정(<details>) 펼침 — 신규 작성은 접힘(업무 템플릿 기본값으로 충분), 편집(initial)은 기존 값이 보이게 펼침.
  const [detailsOpen, setDetailsOpen] = useState(initial !== undefined);

  useEffect(() => {
    if (!instructionTouched) setInstruction(TEMPLATES[templateKey].instruction);
  }, [templateKey, instructionTouched]);

  // 입력이 바뀔 때마다 IR 재생성 → 상위(폼)로 전달. 저장은 동일 파이프라인.
  useEffect(() => {
    onChange(buildIr(name, pageUrl, dataName, kind, instruction, successCriteria, version, { maxPages: Number(maxPages), nextInstruction, noNextFlag }));
  }, [name, pageUrl, dataName, kind, instruction, successCriteria, version, maxPages, nextInstruction, noNextFlag, onChange]);

  const us = urlState(pageUrl);
  const instructionMissing = instruction.trim().length === 0;

  return (
    <div>
      <p className="subtle" style={{ margin: "0 0 12px" }}>
        평이한 질문 몇 개로 자동화의 <b>흐름</b>을 만듭니다. 저장할 때 자동으로 검증됩니다.
      </p>
      <label style={{ display: "block", marginBottom: 10 }}>
        <span className="subtle">업무 템플릿</span>
        <br />
        <select
          value={templateKey}
          onChange={(e) => {
            const next = e.target.value as TemplateKey;
            const t = TEMPLATES[next];
            setTemplateKey(next);
            setName(t.defaultName);
            setDataName(t.dataName);
            setKind(t.kind);
            setInstruction(t.instruction);
            setSuccessCriteria(t.success);
            setMaxPages(String(DEFAULT_MAX_PAGES));
            setNextInstruction(DEFAULT_NEXT_INSTRUCTION);
            setNoNextFlag(DEFAULT_NO_NEXT_FLAG);
            setInstructionTouched(false);
          }}
          style={{ padding: "8px 10px", fontSize: 14, minWidth: 420, maxWidth: "100%" }}
        >
          {Object.entries(TEMPLATES).map(([key, t]) => (
            <option key={key} value={key}>{t.label}</option>
          ))}
        </select>
      </label>
      <Field label="① 자동화 이름" value={name} onChange={setName} placeholder="예: 리뷰 수집" />
      <Field
        label="② 자동화할 페이지 주소 (전체 주소를 붙여넣으세요)"
        value={pageUrl}
        onChange={setPageUrl}
        placeholder="예: https://www.example.com/products/123"
        hint={
          us === "bad" ? (
            <span className="badge red">https:// 로 시작하는 전체 주소를 넣어 주세요 (지금 값은 실행기가 열 수 없습니다)</span>
          ) : us === "ok" ? (
            <span className="badge green">주소 형식 OK</span>
          ) : undefined
        }
      />
      <details className="wizard-advanced" open={detailsOpen} onToggle={(event) => setDetailsOpen((event.currentTarget as HTMLDetailsElement).open)}>
        <summary>세부 조정 (선택) — 비워두면 업무 템플릿 기본값으로 동작합니다</summary>
      <Field label="③ 가져올 데이터 이름(라벨)" value={dataName} onChange={setDataName} placeholder="예: 리뷰목록" />
      <Field
        label="④ 추출/입력 규칙"
        value={instruction}
        onChange={(v) => {
          setInstructionTouched(true);
          setInstruction(v);
        }}
        placeholder="예: 공지사항 목록의 각 행에서 제목, 작성자, 작성일, 조회수를 추출하라."
        multiline
        hint={
          instructionMissing ? (
            <span className="badge red">추출 규칙은 비워둘 수 없습니다. 저장 시 검증에서 거부됩니다.</span>
          ) : undefined
        }
      />
      <Field
        label="⑤ 성공 기준"
        value={successCriteria}
        onChange={setSuccessCriteria}
        placeholder="예: 최소 1개 행을 추출하거나 데이터 없음으로 종료한다."
        multiline
        hint={<span className="subtle">IR 스키마가 닫힌 구조라 별도 필드 대신 실행 지시문에 포함됩니다.</span>}
      />
      <label style={{ display: "block", marginBottom: 6 }}>
        <span className="subtle">⑥ 방식</span>
        <br />
        <select value={kind} onChange={(e) => setKind(e.target.value as Kind)} style={{ padding: "8px 10px", fontSize: 14, minWidth: 420, maxWidth: "100%" }}>
          <option value="list">여러 페이지 목록 수집 (반복 수집)</option>
          <option value="once">한 화면에서 한 번만 가져오기</option>
        </select>
      </label>
      {kind === "list" && (
        <div className="panel" style={{ padding: 10, marginTop: 10, display: "grid", gap: 8, maxWidth: 560 }}>
          <label style={{ display: "grid", gap: 4 }}>
            <span className="subtle">⑦ 최대 페이지 수</span>
            <input
              type="number"
              min={1}
              max={100}
              value={maxPages}
              onChange={(e) => setMaxPages(e.target.value)}
              style={{ padding: "8px 10px", fontSize: 14, width: 140 }}
            />
          </label>
          <label style={{ display: "grid", gap: 4 }}>
            <span className="subtle">⑧ 다음 페이지 동작</span>
            <textarea
              value={nextInstruction}
              onChange={(e) => setNextInstruction(e.target.value)}
              rows={2}
              placeholder={DEFAULT_NEXT_INSTRUCTION}
              style={{ padding: "8px 10px", fontSize: 14, width: "100%", boxSizing: "border-box", resize: "vertical" }}
            />
          </label>
          <label style={{ display: "grid", gap: 4 }}>
            <span className="subtle">마지막 페이지 판정 flag</span>
            <select value={noNextFlag} onChange={(e) => setNoNextFlag(e.target.value)} style={{ padding: "8px 10px", fontSize: 14, width: 220 }}>
              {PAGE_END_FLAGS.map((flag) => (
                <option key={flag} value={flag}>{flag}</option>
              ))}
            </select>
          </label>
          <span className="subtle">사이트 설정에서 이 flag selector를 등록하면 마지막 페이지에서 반복이 멈춥니다.</span>
        </div>
      )}
      </details>
      <p className="badge" style={{ display: "block", margin: "10px 0 0", whiteSpace: "normal" }}>
        ⚠ 지금은 자동화의 <b>흐름(구조)</b>만 만들어 저장합니다. 실제로 이 페이지에서 데이터를 가져오는 동작은
        실행기(브라우저 워커) 연결과 사이트별 추출 설정이 있어야 합니다.
      </p>
    </div>
  );
}
