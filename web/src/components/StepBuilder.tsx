import { useEffect, useRef, useState } from "react";

import { terminalLabel } from "./badges";

// 단계 빌더(비주얼 스튜디오 1차 슬라이스): 단계(노드)를 양식으로 구성 → 유효 IR 생성.
// 안전 범위: action은 추가 필수 필드 없는 act/observe(+없음)만, 흐름키는 next/terminal/on[flags]만 생성.
// extract/navigate/shell 등 추가 필드가 필요한 액션은 'IR 직접 편집'에서 다룬다(무효 IR 미생성 원칙).
// 산출 IR은 그대로 컴파일 파이프라인(ajv→IREL→V1–V11)이 저장 시 재검증한다.

// IREL flags 닫힌 레지스트리(ir-static-validation §2 / architecture §9.2). when = "flags.<flag>".
const FLAGS = [
  "no_next_page",
  "cursor_reached",
  "login_required",
  "blocked",
  "not_found",
  "no_review_message_visible",
  "reviews_visible",
] as const;
const TERMINALS = ["success", "success_empty", "fail_business", "fail_system"] as const;
// 빌더가 안전 생성하는 액션: 추가 필수 필드가 없거나(act/observe) 단일 ref만 필요한 것(extract→schema_ref,
// navigate→url_ref). shell(cmd_ref 등록 필요)·api_call 등은 'IR 직접 편집'에서 다룬다.
const ACTIONS = ["none", "observe", "act", "extract", "navigate"] as const;

type Rule = { when: string; target: string; priority: number };
type Flow =
  | { kind: "terminal"; terminal: string }
  | { kind: "next"; target: string }
  | { kind: "on"; rules: Rule[] };
export interface Step {
  id: string;
  action: (typeof ACTIONS)[number];
  schemaRef?: string; // extract 전용
  extractInstruction?: string; // extract 전용
  urlRef?: string; // navigate 전용
  flow: Flow;
}
export interface StepBuilderInitial {
  readonly name: string;
  readonly steps: readonly Step[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function defaultExtractInstruction(schemaRef?: string): string {
  const label = schemaRef !== undefined && schemaRef.trim().length > 0 ? schemaRef.trim() : "extracted_rows";
  return `현재 페이지에서 ${label} 데이터를 추출하라.`;
}

// 액션 객체 생성(ir.schema action: additionalProperties false → 허용 키만 emit, 필수 필드 포함).
function actionObj(s: Step): Record<string, unknown> | null {
  switch (s.action) {
    case "none":
      return null;
    case "extract":
      return {
        action: "extract",
        instruction: s.extractInstruction && s.extractInstruction.trim().length > 0 ? s.extractInstruction.trim() : defaultExtractInstruction(s.schemaRef),
        schema_ref: s.schemaRef && s.schemaRef.length > 0 ? s.schemaRef : "extracted_rows",
      };
    case "navigate":
      return { action: "navigate", url_ref: s.urlRef && s.urlRef.length > 0 ? s.urlRef : "target_url" };
    default:
      return { action: s.action }; // act, observe
  }
}

function stepsToIr(name: string, steps: readonly Step[], version: number): unknown {
  const nodes: Record<string, Record<string, unknown>> = {};
  for (const s of steps) {
    const node: Record<string, unknown> = {};
    const act = actionObj(s);
    if (act !== null) node.what = [act];
    if (s.flow.kind === "terminal") node.terminal = s.flow.terminal;
    else if (s.flow.kind === "next") node.next = s.flow.target;
    else node.on = s.flow.rules.map((r) => ({ when: r.when, target: r.target, priority: r.priority }));
    nodes[s.id] = node;
  }
  return { meta: { name, version, studio_mode: "form" }, start: steps[0]?.id ?? "n1", nodes };
}

const SELECT = { padding: "4px 6px", fontSize: 13 } as const;

const DEFAULT_STEPS: Step[] = [
    { id: "n1", action: "observe", flow: { kind: "on", rules: [{ when: "flags.not_found", target: "n2", priority: 1 }] } },
    { id: "n2", action: "none", flow: { kind: "terminal", terminal: "success" } },
];

export function stepBuilderInitialFromIr(ir: unknown): StepBuilderInitial | undefined {
  if (!isRecord(ir) || !isRecord(ir.nodes)) return undefined;
  const meta = isRecord(ir.meta) ? ir.meta : {};
  const name = typeof meta.name === "string" ? meta.name : "새 자동화";
  const start = typeof ir.start === "string" ? ir.start : undefined;
  const entries = Object.entries(ir.nodes);
  const ordered = start !== undefined
    ? [...entries.filter(([id]) => id === start), ...entries.filter(([id]) => id !== start)]
    : entries;
  const steps = ordered.map(([id, node]): Step => {
    const n = isRecord(node) ? node : {};
    const what = Array.isArray(n.what) ? n.what : [];
    const first = isRecord(what[0]) ? what[0] : {};
    const action = typeof first.action === "string" && ACTIONS.includes(first.action as Step["action"])
      ? first.action as Step["action"]
      : "none";
    const flow: Flow =
      typeof n.terminal === "string"
        ? { kind: "terminal", terminal: n.terminal }
        : typeof n.next === "string"
          ? { kind: "next", target: n.next }
          : Array.isArray(n.on)
            ? {
                kind: "on",
                rules: n.on
                  .filter(isRecord)
                  .map((r): Rule => ({
                    when: typeof r.when === "string" ? r.when : "flags.not_found",
                    target: typeof r.target === "string" ? r.target : id,
                    priority: typeof r.priority === "number" ? r.priority : 1,
                  })),
              }
            : { kind: "terminal", terminal: "success" };
    return {
      id,
      action,
      schemaRef: typeof first.schema_ref === "string" ? first.schema_ref : undefined,
      extractInstruction: typeof first.instruction === "string" ? first.instruction : undefined,
      urlRef: typeof first.url_ref === "string" ? first.url_ref : undefined,
      flow: flow.kind === "on" && flow.rules.length === 0 ? { kind: "terminal", terminal: "success" } : flow,
    };
  });
  return { name, steps: steps.length > 0 ? steps : DEFAULT_STEPS };
}

function initialCounter(steps: readonly Step[]): number {
  const max = steps.reduce((acc, step) => {
    const match = /^n(\d+)$/.exec(step.id);
    return match === null ? acc : Math.max(acc, Number(match[1]));
  }, 0);
  return Math.max(2, max);
}

export function StepBuilder({ onChange, initial, version = 1 }: { onChange: (ir: unknown) => void; initial?: StepBuilderInitial; version?: number }): JSX.Element {
  const seedSteps = initial?.steps ?? DEFAULT_STEPS;
  const counter = useRef(initialCounter(seedSteps));
  const [name, setName] = useState(initial?.name ?? "새 자동화");
  const [steps, setSteps] = useState<Step[]>(seedSteps.map((s) => ({ ...s, flow: s.flow.kind === "on" ? { ...s.flow, rules: [...s.flow.rules] } : { ...s.flow } })));

  // 단계/이름 변경 시 IR을 재생성해 상위(폼)로 전달 → 저장은 동일 파이프라인.
  useEffect(() => {
    onChange(stepsToIr(name, steps, version));
  }, [name, steps, version, onChange]);

  const ids = steps.map((s) => s.id);
  const update = (i: number, patch: Partial<Step>) => setSteps((p) => p.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const addStep = () => {
    counter.current += 1;
    setSteps((p) => [...p, { id: `n${counter.current}`, action: "none", flow: { kind: "terminal", terminal: "success" } }]);
  };
  const removeStep = (i: number) => setSteps((p) => (p.length > 1 ? p.filter((_, j) => j !== i) : p));

  function setFlowKind(i: number, kind: Flow["kind"]): void {
    const fallbackTarget = ids[i + 1] ?? ids[0] ?? "n1";
    const flow: Flow =
      kind === "terminal"
        ? { kind: "terminal", terminal: "success" }
        : kind === "next"
          ? { kind: "next", target: fallbackTarget }
          : { kind: "on", rules: [{ when: "flags.not_found", target: fallbackTarget, priority: 1 }] };
    update(i, { flow });
  }

  return (
    <div>
      <label style={{ display: "block", marginBottom: 10 }}>
        <span className="subtle">자동화 이름</span>
        <br />
        <input value={name} onChange={(e) => setName(e.target.value)} style={{ padding: "6px 8px", fontSize: 14, width: 320, maxWidth: "100%" }} />
      </label>
      <ol style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 8 }}>
        {steps.map((s, i) => (
          <li key={s.id} className="panel" style={{ padding: 10, display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
            <strong style={{ minWidth: 34 }}>{i === 0 ? `${s.id}★` : s.id}</strong>
            <label>
              <span className="subtle">동작</span>{" "}
              <select
                value={s.action}
                onChange={(e) => {
                  const action = e.target.value as Step["action"];
                  const patch: Partial<Step> = { action };
                  // 필수 ref를 비우지 않도록 전환 시 기본값 채움(유효 IR 유지).
                  if (action === "extract") {
                    const nextSchemaRef = s.schemaRef === undefined || s.schemaRef.length === 0 ? "extracted_rows" : s.schemaRef;
                    patch.schemaRef = nextSchemaRef;
                    if (s.extractInstruction === undefined || s.extractInstruction.trim().length === 0) {
                      patch.extractInstruction = defaultExtractInstruction(nextSchemaRef);
                    }
                  }
                  if (action === "navigate" && (s.urlRef === undefined || s.urlRef.length === 0)) patch.urlRef = "target_url";
                  update(i, patch);
                }}
                style={SELECT}
              >
                <option value="none">없음(흐름만)</option>
                <option value="observe">관찰(observe)</option>
                <option value="act">조작(act)</option>
                <option value="extract">추출(extract)</option>
                <option value="navigate">이동(navigate)</option>
              </select>
            </label>
            {s.action === "extract" && (
              <>
                <label>
                  <span className="subtle">출력 스키마(schema_ref)</span>{" "}
                  <input value={s.schemaRef ?? ""} onChange={(e) => update(i, { schemaRef: e.target.value })} style={{ ...SELECT, width: 150 }} />
                </label>
                <label style={{ flexBasis: 360, flexGrow: 1 }}>
                  <span className="subtle">추출 규칙</span>{" "}
                  <input
                    value={s.extractInstruction ?? ""}
                    onChange={(e) => update(i, { extractInstruction: e.target.value })}
                    placeholder={defaultExtractInstruction(s.schemaRef)}
                    style={{ ...SELECT, width: "min(100%, 360px)" }}
                  />
                </label>
              </>
            )}
            {s.action === "navigate" && (
              <label>
                <span className="subtle">이동 URL(url_ref)</span>{" "}
                <input value={s.urlRef ?? ""} onChange={(e) => update(i, { urlRef: e.target.value })} style={{ ...SELECT, width: 170 }} />
              </label>
            )}
            <label>
              <span className="subtle">다음</span>{" "}
              <select value={s.flow.kind} onChange={(e) => setFlowKind(i, e.target.value as Flow["kind"])} style={SELECT}>
                <option value="terminal">종료</option>
                <option value="next">다음 단계로</option>
                <option value="on">조건 분기</option>
              </select>
            </label>
            {s.flow.kind === "terminal" && (
              <select
                value={s.flow.terminal}
                onChange={(e) => update(i, { flow: { kind: "terminal", terminal: e.target.value } })}
                style={SELECT}
              >
                {TERMINALS.map((t) => (
                  <option key={t} value={t}>
                    {terminalLabel(t)}
                  </option>
                ))}
              </select>
            )}
            {s.flow.kind === "next" && (
              <select value={s.flow.target} onChange={(e) => update(i, { flow: { kind: "next", target: e.target.value } })} style={SELECT}>
                {ids.map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
              </select>
            )}
            {s.flow.kind === "on" && (
              <BranchRules
                rules={s.flow.rules}
                ids={ids}
                onChange={(rules) => update(i, { flow: { kind: "on", rules } })}
              />
            )}
            <button className="btn" type="button" onClick={() => removeStep(i)} disabled={steps.length === 1} style={{ marginLeft: "auto" }}>
              삭제
            </button>
          </li>
        ))}
      </ol>
      <button className="btn" type="button" onClick={addStep} style={{ marginTop: 8 }}>
        + 단계 추가
      </button>
      <p className="subtle" style={{ margin: "8px 0 0" }}>
        ★ = 시작 단계. 저장 시 그래프 검증(V1–V11)을 통과해야 합니다. shell·api_call 등 추가 동작은 ‘IR 직접 편집’에서 보강하세요.
      </p>
    </div>
  );
}

function BranchRules({
  rules,
  ids,
  onChange,
}: {
  rules: readonly Rule[];
  ids: readonly string[];
  onChange: (rules: Rule[]) => void;
}): JSX.Element {
  const set = (i: number, patch: Partial<Rule>) => onChange(rules.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <span style={{ display: "inline-flex", flexDirection: "column", gap: 4 }}>
      {rules.map((r, i) => (
        <span key={i} style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
          <span className="subtle">조건</span>
          <select value={r.when.replace("flags.", "")} onChange={(e) => set(i, { when: `flags.${e.target.value}` })} style={SELECT}>
            {FLAGS.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
          <span className="subtle">→</span>
          <select value={r.target} onChange={(e) => set(i, { target: e.target.value })} style={SELECT}>
            {ids.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
          <span className="subtle">우선</span>
          <input
            type="number"
            value={r.priority}
            onChange={(e) => set(i, { priority: Number(e.target.value) })}
            style={{ ...SELECT, width: 52 }}
          />
          <button className="btn" type="button" onClick={() => onChange(rules.filter((_, j) => j !== i))} disabled={rules.length === 1}>
            ×
          </button>
        </span>
      ))}
      <button
        className="btn"
        type="button"
        onClick={() => onChange([...rules, { when: "flags.blocked", target: ids[0] ?? "n1", priority: rules.length + 1 }])}
      >
        + 조건
      </button>
    </span>
  );
}
