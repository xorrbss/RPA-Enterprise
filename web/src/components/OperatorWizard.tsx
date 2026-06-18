import { useEffect, useState } from "react";

// 운영자용 '쉬운 만들기' — IR/flags/동작 같은 기술 용어 없이 평이한 질문 몇 개로 유효 IR을 생성한다.
// 템플릿이 흐름(navigate→observe→extract→종료)을 고정하고, 운영자는 페이지 주소/데이터 이름만 채운다.
// navigate.url_ref 는 리터럴 URL이 아니라 run params 의 '키'다(런타임 site-resolution: 키-only, 리터럴 흡수 금지).
// 따라서 고정 키(entry_url)를 url_ref 로 쓰고, 입력 URL은 params_schema[entry_url].default 로 실어 실행 대화상자가
// 그 값으로 입력을 prefill하게 한다. 페이지 주소는 default 로 쓸 절대 URL(http/https)인지 검증한다.
// ※ 산출 IR은 '구조'다 — 실제로 그 페이지에서 데이터를 가져오려면 실행기 연결 + 사이트별 추출 설정이 필요하다.

type Kind = "list" | "once";
export interface OperatorWizardInitial {
  readonly name: string;
  readonly pageUrl: string;
  readonly dataName: string;
  readonly kind: Kind;
  readonly instruction: string;
}

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

function defaultInstruction(dataName: string, kind: Kind): string {
  const label = dataName.trim() || "필요한 데이터";
  return kind === "list"
    ? `페이지의 목록에서 ${label} 항목을 행 단위로 추출하라.`
    : `현재 페이지에서 ${label} 값을 추출하라.`;
}

export function buildIr(
  name: string,
  pageUrl: string,
  dataName: string,
  kind: Kind,
  instruction = defaultInstruction(dataName, kind),
  version = 1,
): unknown {
  const meta = { name: name.trim() || "새 자동화", version, studio_mode: "easy" };
  // url_ref = 고정 키(ENTRY_KEY). 입력 URL은 url_ref 에 박지 않고 params_schema[entry_url].default 로 싣는다
  // (유효 http(s) URL일 때만) — 실행 대화상자가 이 default 로 prefill한다. 무효/빈값이면 default 없이 키만 선언.
  const entryParam: Record<string, unknown> = { type: "string", description: "실행 대상 페이지 URL" };
  if (urlState(pageUrl) === "ok") entryParam.default = pageUrl.trim();
  const params_schema = { type: "object", properties: { [ENTRY_KEY]: entryParam }, required: [ENTRY_KEY] };
  const schemaRef = dataName.trim() || "수집데이터";
  const extractInstruction = instruction.trim();
  if (kind === "list") {
    // 여러 화면 수집: 사이트 열기 → 화면 확인 → (목록 보이면) 가져오기 → 마무리.
    return {
      meta,
      params_schema,
      start: "open",
      nodes: {
        open: { what: [{ action: "navigate", url_ref: ENTRY_KEY }], next: "check" },
        check: {
          what: [{ action: "observe" }],
          on: [
            { when: "flags.reviews_visible", target: "collect", priority: 2 },
            { when: "flags.not_found", target: "done", priority: 1 },
          ],
        },
        collect: { what: [{ action: "extract", instruction: extractInstruction, schema_ref: schemaRef }], next: "done" },
        done: { terminal: "success" },
      },
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
  const kind: Kind = isRecord(nodes.check) ? "list" : "once";
  const instruction =
    typeof extractRecord.instruction === "string" && extractRecord.instruction.trim().length > 0
      ? extractRecord.instruction
      : defaultInstruction(dataName, kind);
  return { name, pageUrl, dataName, kind, instruction };
}

function Field({ label, value, onChange, placeholder, hint }: { label: string; value: string; onChange: (v: string) => void; placeholder: string; hint?: JSX.Element }): JSX.Element {
  return (
    <label style={{ display: "block", marginBottom: 10 }}>
      <span className="subtle">{label}</span>
      <br />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        style={{ padding: "8px 10px", fontSize: 14, width: 420, maxWidth: "100%" }}
      />
      {hint !== undefined && <div style={{ marginTop: 4 }}>{hint}</div>}
    </label>
  );
}

export function OperatorWizard({ onChange, initial, version = 1 }: { onChange: (ir: unknown) => void; initial?: OperatorWizardInitial; version?: number }): JSX.Element {
  const [name, setName] = useState(initial?.name ?? "새 자동화");
  const [pageUrl, setPageUrl] = useState(initial?.pageUrl ?? "");
  const [dataName, setDataName] = useState(initial?.dataName ?? "");
  const [kind, setKind] = useState<Kind>(initial?.kind ?? "list");
  const [instruction, setInstruction] = useState(initial?.instruction ?? defaultInstruction("", "list"));
  const [instructionTouched, setInstructionTouched] = useState(initial !== undefined);

  useEffect(() => {
    if (!instructionTouched) setInstruction(defaultInstruction(dataName, kind));
  }, [dataName, kind, instructionTouched]);

  // 입력이 바뀔 때마다 IR 재생성 → 상위(폼)로 전달. 저장은 동일 파이프라인.
  useEffect(() => {
    onChange(buildIr(name, pageUrl, dataName, kind, instruction, version));
  }, [name, pageUrl, dataName, kind, instruction, version, onChange]);

  const us = urlState(pageUrl);
  const instructionMissing = instruction.trim().length === 0;

  return (
    <div>
      <p className="subtle" style={{ margin: "0 0 12px" }}>
        평이한 질문 몇 개로 자동화의 <b>흐름</b>을 만듭니다. 저장할 때 자동으로 검증됩니다.
      </p>
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
      <Field label="③ 가져올 데이터 이름(라벨)" value={dataName} onChange={setDataName} placeholder="예: 리뷰목록" />
      <Field
        label="④ 추출 규칙"
        value={instruction}
        onChange={(v) => {
          setInstructionTouched(true);
          setInstruction(v);
        }}
        placeholder="예: 공지사항 목록의 각 행에서 제목, 작성자, 작성일, 조회수를 추출하라."
        hint={
          instructionMissing ? (
            <span className="badge red">추출 규칙은 비워둘 수 없습니다. 저장 시 검증에서 거부됩니다.</span>
          ) : undefined
        }
      />
      <label style={{ display: "block", marginBottom: 6 }}>
        <span className="subtle">⑤ 방식</span>
        <br />
        <select value={kind} onChange={(e) => setKind(e.target.value as Kind)} style={{ padding: "8px 10px", fontSize: 14, minWidth: 420, maxWidth: "100%" }}>
          <option value="list">여러 화면에서 목록 수집 (페이지 넘기며)</option>
          <option value="once">한 화면에서 한 번만 가져오기</option>
        </select>
      </label>
      <p className="badge" style={{ display: "block", margin: "10px 0 0", whiteSpace: "normal" }}>
        ⚠ 지금은 자동화의 <b>흐름(구조)</b>만 만들어 저장합니다. 실제로 이 페이지에서 데이터를 가져오는 동작은
        실행기(브라우저 워커) 연결과 사이트별 추출 설정이 있어야 합니다.
      </p>
    </div>
  );
}
