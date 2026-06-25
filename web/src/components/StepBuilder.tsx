import { useEffect, useRef, useState } from "react";

import { terminalLabel } from "./badges";

// 단계 빌더(비주얼 스튜디오 1차 슬라이스): 단계(노드)를 양식으로 구성 → 유효 IR 생성.
// 안전 범위: action은 act/observe/none과 필수 필드를 폼으로 채울 수 있는 extract/navigate를 생성한다.
// shell/api_call처럼 별도 레지스트리나 비밀 경계가 필요한 액션은 '자동화 정의 직접 편집'에서 다룬다(무효 IR 미생성 원칙).
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
const FLAG_LABELS: Record<(typeof FLAGS)[number], string> = {
  no_next_page: "다음 페이지 없음",
  cursor_reached: "목록 끝에 도달",
  login_required: "로그인 필요",
  blocked: "진행 차단",
  not_found: "대상 없음",
  no_review_message_visible: "리뷰 없음 안내 미표시",
  reviews_visible: "리뷰 목록 표시",
};
const TERMINALS = [
  "success",
  "success_empty",
  "fail_business",
  "fail_system",
] as const;
// 빌더가 안전 생성하는 액션: 추가 필수 필드가 없거나(act/observe) 단일 ref만 필요한 것(extract→schema_ref,
// navigate→url_ref). shell(cmd_ref 등록 필요)·api_call 등은 '자동화 정의 직접 편집'에서 다룬다.
const ACTIONS = ["none", "observe", "act", "extract", "navigate"] as const;
const ACTION_LABELS: Record<(typeof ACTIONS)[number], string> = {
  none: "없음(흐름만)",
  observe: "화면 확인",
  act: "화면 조작",
  extract: "데이터 추출",
  navigate: "페이지 이동",
};
const DEFAULT_SCHEMA_REF = "수집데이터";
const DEFAULT_URL_REF = "이동주소";

type Rule = { when: string; target: string; priority: number };
type Flow =
  | { kind: "terminal"; terminal: string }
  | { kind: "next"; target: string }
  | { kind: "on"; rules: Rule[] }
  | {
      kind: "loop";
      bodyTarget: string;
      exitTarget: string;
      until: string;
      maxIterations: number;
    };
const FLOW_LABELS: Record<Flow["kind"], string> = {
  terminal: "종료",
  next: "다음 단계로",
  on: "조건 분기",
  loop: "반복",
};
export interface Step {
  id: string;
  action: (typeof ACTIONS)[number];
  instruction?: string; // observe/act 전용
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

function normalizeDefaultRef(value: string, fallback: string): string {
  if (value === "extracted_rows" || value === "target_url") return fallback;
  return value;
}

// 닫힌 flags 레지스트리(ir-static-validation §2)의 운영자 라벨 — OperatorWizard 등과 공유(vocab 단일 출처).
export function flagLabel(flag: string): string {
  return FLAGS.includes(flag as (typeof FLAGS)[number])
    ? FLAG_LABELS[flag as (typeof FLAGS)[number]]
    : "사용자 조건";
}

function dataNameForDisplay(schemaRef?: string): string {
  if (schemaRef === undefined || schemaRef.trim().length === 0)
    return DEFAULT_SCHEMA_REF;
  return normalizeDefaultRef(schemaRef.trim(), DEFAULT_SCHEMA_REF);
}

function instructionForDisplay(instruction: string, schemaRef?: string): string {
  const label = dataNameForDisplay(schemaRef);
  return instruction
    .replace(/\bextracted_rows 데이터를/g, `${label} 내용을`)
    .replace(/\bextracted_rows\b/g, label);
}

function defaultExtractInstruction(schemaRef?: string): string {
  return `현재 페이지에서 ${dataNameForDisplay(schemaRef)} 내용을 추출하라.`;
}

function defaultActionInstruction(action: Step["action"]): string {
  if (action === "act") return "화면의 다음 업무 단계로 진행하라.";
  return "현재 화면 상태와 주요 업무 신호를 관찰하라.";
}

// 액션 객체 생성(ir.schema action: additionalProperties false → 허용 키만 emit, 필수 필드 포함).
function actionObj(s: Step): Record<string, unknown> | null {
  switch (s.action) {
    case "none":
      return null;
    case "extract":
      return {
        action: "extract",
        instruction:
          s.extractInstruction && s.extractInstruction.trim().length > 0
            ? s.extractInstruction.trim()
            : defaultExtractInstruction(s.schemaRef),
        schema_ref:
          s.schemaRef && s.schemaRef.length > 0
            ? s.schemaRef
            : DEFAULT_SCHEMA_REF,
      };
    case "navigate":
      return {
        action: "navigate",
        url_ref: s.urlRef && s.urlRef.length > 0 ? s.urlRef : DEFAULT_URL_REF,
      };
    case "act":
    case "observe":
      return {
        action: s.action,
        instruction:
          s.instruction && s.instruction.trim().length > 0
            ? s.instruction.trim()
            : defaultActionInstruction(s.action),
      };
  }
}

function stepsToIr(
  name: string,
  steps: readonly Step[],
  version: number,
): unknown {
  const nodes: Record<string, Record<string, unknown>> = {};
  for (const s of steps) {
    const node: Record<string, unknown> = {};
    const act = actionObj(s);
    if (act !== null) node.what = [act];
    if (s.flow.kind === "terminal") node.terminal = s.flow.terminal;
    else if (s.flow.kind === "next") node.next = s.flow.target;
    else if (s.flow.kind === "on")
      node.on = s.flow.rules.map((r) => ({
        when: r.when,
        target: r.target,
        priority: r.priority,
      }));
    else {
      node.loop = {
        body_target: s.flow.bodyTarget,
        exit_target: s.flow.exitTarget,
        until: s.flow.until,
        max_iterations: Math.max(
          1,
          Math.min(10000, Math.floor(s.flow.maxIterations)),
        ),
      };
    }
    nodes[s.id] = node;
  }
  return {
    meta: { name, version, studio_mode: "form" },
    start: steps[0]?.id ?? "n1",
    nodes,
  };
}

const SELECT = { padding: "4px 6px", fontSize: 13 } as const;

const DEFAULT_STEPS: Step[] = [
  {
    id: "n1",
    action: "observe",
    instruction: defaultActionInstruction("observe"),
    flow: { kind: "next", target: "n2" },
  },
  {
    id: "n2",
    action: "extract",
    schemaRef: DEFAULT_SCHEMA_REF,
    extractInstruction: defaultExtractInstruction(DEFAULT_SCHEMA_REF),
    flow: { kind: "terminal", terminal: "success" },
  },
];

export function stepBuilderInitialFromIr(
  ir: unknown,
): StepBuilderInitial | undefined {
  if (!isRecord(ir) || !isRecord(ir.nodes)) return undefined;
  const meta = isRecord(ir.meta) ? ir.meta : {};
  const name = typeof meta.name === "string" ? meta.name : "새 자동화";
  const start = typeof ir.start === "string" ? ir.start : undefined;
  const entries = Object.entries(ir.nodes);
  const ordered =
    start !== undefined
      ? [
          ...entries.filter(([id]) => id === start),
          ...entries.filter(([id]) => id !== start),
        ]
      : entries;
  const steps = ordered.map(([id, node]): Step => {
    const n = isRecord(node) ? node : {};
    const what = Array.isArray(n.what) ? n.what : [];
    const first = isRecord(what[0]) ? what[0] : {};
    const action =
      typeof first.action === "string" &&
      ACTIONS.includes(first.action as Step["action"])
        ? (first.action as Step["action"])
        : "none";
    const loop = isRecord(n.loop) ? n.loop : undefined;
    const flow: Flow =
      typeof n.terminal === "string"
        ? { kind: "terminal", terminal: n.terminal }
        : typeof n.next === "string"
          ? { kind: "next", target: n.next }
          : Array.isArray(n.on)
            ? {
                kind: "on",
                rules: n.on.filter(isRecord).map(
                  (r): Rule => ({
                    when:
                      typeof r.when === "string" ? r.when : "flags.not_found",
                    target: typeof r.target === "string" ? r.target : id,
                    priority: typeof r.priority === "number" ? r.priority : 1,
                  }),
                ),
              }
            : loop !== undefined
              ? {
                  kind: "loop",
                  bodyTarget:
                    typeof loop.body_target === "string"
                      ? loop.body_target
                      : id,
                  exitTarget:
                    typeof loop.exit_target === "string"
                      ? loop.exit_target
                      : id,
                  until:
                    typeof loop.until === "string"
                      ? loop.until
                      : "flags.no_next_page",
                  maxIterations:
                    typeof loop.max_iterations === "number"
                      ? loop.max_iterations
                      : 1,
                }
              : { kind: "terminal", terminal: "success" };
    const schemaRef =
      typeof first.schema_ref === "string"
        ? normalizeDefaultRef(first.schema_ref, DEFAULT_SCHEMA_REF)
        : undefined;
    const urlRef =
      typeof first.url_ref === "string"
        ? normalizeDefaultRef(first.url_ref, DEFAULT_URL_REF)
        : undefined;
    const instruction =
      typeof first.instruction === "string"
        ? instructionForDisplay(first.instruction, schemaRef)
        : undefined;
    return {
      id,
      action,
      instruction,
      schemaRef,
      extractInstruction: instruction,
      urlRef,
      flow:
        flow.kind === "on" && flow.rules.length === 0
          ? { kind: "terminal", terminal: "success" }
          : flow,
    };
  });
  return { name, steps: steps.length > 0 ? steps : DEFAULT_STEPS };
}

// StepBuilder(단계 편집)가 **충실히 round-trip** 하는 IR 만 true. stepBuilderInitialFromIr 는 표현 못 하는 형태를 무음으로
//   떨군다: ① 미지원 what 액션(api_call/shell/download/upload/file 등)→action:"none"(액션 소실), ② 다중 what 액션→첫 액션만,
//   ③ 예약 핸들러(next/on[].target 객체)·fallback_chain·미지원 flow→terminal:success(흐름/분기 소실). 그런 IR 을 단계 편집으로
//   열면 저장 시 그 단계가 사라진다(조용한 false 위반) → '직접 편집'으로만 안전. 단계 편집 잠금 기준.
const STEP_BUILDER_WHAT_ACTIONS = new Set(["act", "observe", "extract", "navigate"]);
export function stepBuilderRepresentable(ir: unknown): boolean {
  if (!isRecord(ir) || !isRecord(ir.nodes) || Object.keys(ir.nodes).length === 0) return false;
  return Object.values(ir.nodes).every((node) => isRecord(node) && nodeStepBuilderRepresentable(node));
}

function nodeStepBuilderRepresentable(node: Record<string, unknown>): boolean {
  // what: 안전 단일 액션만(빈 what=흐름전용 허용). 다중·미지원 액션은 무음 손실되므로 표현 불가.
  const what = Array.isArray(node.what) ? node.what : [];
  if (what.length > 1) return false;
  for (const step of what) {
    if (!isRecord(step) || typeof step.action !== "string" || !STEP_BUILDER_WHAT_ACTIONS.has(step.action)) return false;
  }
  // flow: terminal(string) | next(string) | on(array·string target) | loop(object) 만. 예약 핸들러(next/on-target 객체)·
  //   fallback_chain·미지원 flow 는 표현 불가.
  if (typeof node.terminal === "string") return true;
  if (typeof node.next === "string") return true;
  if (Array.isArray(node.on)) return node.on.every((branch) => isRecord(branch) && typeof branch.target === "string");
  if (isRecord(node.loop)) return true;
  return false;
}

function initialCounter(steps: readonly Step[]): number {
  const max = steps.reduce((acc, step) => {
    const match = /^n(\d+)$/.exec(step.id);
    return match === null ? acc : Math.max(acc, Number(match[1]));
  }, 0);
  return Math.max(2, max);
}

export function StepBuilder({
  onChange,
  initial,
  version = 1,
}: {
  onChange: (ir: unknown) => void;
  initial?: StepBuilderInitial;
  version?: number;
}): JSX.Element {
  const seedSteps = initial?.steps ?? DEFAULT_STEPS;
  const counter = useRef(initialCounter(seedSteps));
  const [name, setName] = useState(initial?.name ?? "새 자동화");
  const [steps, setSteps] = useState<Step[]>(
    seedSteps.map((s) => ({
      ...s,
      flow:
        s.flow.kind === "on"
          ? { ...s.flow, rules: [...s.flow.rules] }
          : { ...s.flow },
    })),
  );

  // 단계/이름 변경 시 IR을 재생성해 상위(폼)로 전달 → 저장은 동일 파이프라인.
  useEffect(() => {
    onChange(stepsToIr(name, steps, version));
  }, [name, steps, version, onChange]);

  const ids = steps.map((s) => s.id);
  const update = (i: number, patch: Partial<Step>) =>
    setSteps((p) => p.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const addStep = () => {
    counter.current += 1;
    setSteps((p) => [
      ...p,
      {
        id: `n${counter.current}`,
        action: "none",
        flow: { kind: "terminal", terminal: "success" },
      },
    ]);
  };
  const removeStep = (i: number) =>
    setSteps((p) => (p.length > 1 ? p.filter((_, j) => j !== i) : p));

  function setFlowKind(i: number, kind: Flow["kind"]): void {
    const fallbackTarget = ids[i + 1] ?? ids[0] ?? "n1";
    const flow: Flow =
      kind === "terminal"
        ? { kind: "terminal", terminal: "success" }
        : kind === "next"
          ? { kind: "next", target: fallbackTarget }
          : kind === "on"
            ? {
                kind: "on",
                rules: [
                  {
                    when: "flags.not_found",
                    target: fallbackTarget,
                    priority: 1,
                  },
                ],
              }
            : {
                kind: "loop",
                bodyTarget: fallbackTarget,
                exitTarget: ids[i + 2] ?? fallbackTarget,
                until: "flags.no_next_page",
                maxIterations: 10,
              };
    update(i, { flow });
  }

  return (
    <div>
      <label style={{ display: "block", marginBottom: 10 }}>
        <span className="subtle">자동화 이름</span>
        <br />
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          style={{
            padding: "6px 8px",
            fontSize: 14,
            width: 320,
            maxWidth: "100%",
          }}
        />
      </label>
      <ol
        style={{
          listStyle: "none",
          padding: 0,
          margin: 0,
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
        {steps.map((s, i) => (
          <li
            key={s.id}
            className="panel"
            style={{
              padding: 10,
              display: "flex",
              flexWrap: "wrap",
              gap: 8,
              alignItems: "center",
            }}
          >
            <strong style={{ minWidth: 34 }}>
              {i === 0 ? `${s.id}★` : s.id}
            </strong>
            <label>
              <span className="subtle">동작</span>{" "}
              <select
                value={s.action}
                onChange={(e) => {
                  const action = e.target.value as Step["action"];
                  const patch: Partial<Step> = { action };
                  // 필수 ref를 비우지 않도록 전환 시 기본값 채움(유효 IR 유지).
                  if (action === "extract") {
                    const nextSchemaRef =
                      s.schemaRef === undefined || s.schemaRef.length === 0
                        ? DEFAULT_SCHEMA_REF
                        : s.schemaRef;
                    patch.schemaRef = nextSchemaRef;
                    if (
                      s.extractInstruction === undefined ||
                      s.extractInstruction.trim().length === 0
                    ) {
                      patch.extractInstruction =
                        defaultExtractInstruction(nextSchemaRef);
                    }
                  }
                  if (
                    (action === "observe" || action === "act") &&
                    (s.instruction === undefined ||
                      s.instruction.trim().length === 0)
                  ) {
                    patch.instruction = defaultActionInstruction(action);
                  }
                  if (
                    action === "navigate" &&
                    (s.urlRef === undefined || s.urlRef.length === 0)
                  )
                    patch.urlRef = DEFAULT_URL_REF;
                  update(i, patch);
                }}
                style={SELECT}
              >
                {ACTIONS.map((action) => (
                  <option key={action} value={action}>
                    {ACTION_LABELS[action]}
                  </option>
                ))}
              </select>
            </label>
            {s.action === "extract" && (
              <>
                <label>
                  <span className="subtle">수집 결과 이름</span>{" "}
                  <input
                    value={s.schemaRef ?? ""}
                    onChange={(e) => update(i, { schemaRef: e.target.value })}
                    placeholder="예: 주문 목록"
                    style={{ ...SELECT, width: 150 }}
                  />
                </label>
                <label style={{ flexBasis: "100%", flexGrow: 1 }}>
                  <span className="subtle">추출 규칙</span>
                  <textarea
                    value={s.extractInstruction ?? ""}
                    onChange={(e) =>
                      update(i, { extractInstruction: e.target.value })
                    }
                    placeholder={defaultExtractInstruction(s.schemaRef)}
                    rows={3}
                    style={{
                      width: "100%",
                      minHeight: 76,
                      marginTop: 4,
                      padding: "8px 10px",
                      fontSize: 13,
                      boxSizing: "border-box",
                      resize: "vertical",
                    }}
                  />
                </label>
              </>
            )}
            {s.action === "navigate" && (
              <label>
                <span className="subtle">이동 주소 입력명</span>{" "}
                <input
                  value={s.urlRef ?? ""}
                  onChange={(e) => update(i, { urlRef: e.target.value })}
                  placeholder="예: 주문 페이지 주소"
                  style={{ ...SELECT, width: 170 }}
                />
              </label>
            )}
            <label>
              <span className="subtle">다음</span>{" "}
              <select
                value={s.flow.kind}
                onChange={(e) => setFlowKind(i, e.target.value as Flow["kind"])}
                style={SELECT}
              >
                {(Object.keys(FLOW_LABELS) as Flow["kind"][]).map((kind) => (
                  <option key={kind} value={kind}>
                    {FLOW_LABELS[kind]}
                  </option>
                ))}
              </select>
            </label>
            {(s.action === "observe" || s.action === "act") && (
              <label style={{ flexBasis: "100%", flexGrow: 1 }}>
                <span className="subtle">동작 지시문</span>
                <textarea
                  value={s.instruction ?? ""}
                  onChange={(e) => update(i, { instruction: e.target.value })}
                  placeholder={defaultActionInstruction(s.action)}
                  rows={2}
                  style={{
                    width: "100%",
                    minHeight: 56,
                    marginTop: 4,
                    padding: "8px 10px",
                    fontSize: 13,
                    boxSizing: "border-box",
                    resize: "vertical",
                  }}
                />
              </label>
            )}
            {s.flow.kind === "terminal" && (
              <select
                value={s.flow.terminal}
                onChange={(e) =>
                  update(i, {
                    flow: { kind: "terminal", terminal: e.target.value },
                  })
                }
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
              <select
                value={s.flow.target}
                onChange={(e) =>
                  update(i, { flow: { kind: "next", target: e.target.value } })
                }
                style={SELECT}
              >
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
            {s.flow.kind === "loop" && (
              <LoopControls
                flow={s.flow}
                ids={ids}
                onChange={(flow) => update(i, { flow })}
              />
            )}
            <button
              className="btn"
              type="button"
              onClick={() => removeStep(i)}
              disabled={steps.length === 1}
              style={{ marginLeft: "auto" }}
            >
              삭제
            </button>
          </li>
        ))}
      </ol>
      <button
        className="btn"
        type="button"
        onClick={addStep}
        style={{ marginTop: 8 }}
      >
        + 단계 추가
      </button>
      <p className="subtle" style={{ margin: "8px 0 0" }}>
        ★ = 시작 단계. 저장 시 단계 연결 검증을 통과해야 합니다. 추가 고급
        동작은 ‘자동화 정의 직접 편집’에서 보강하세요.
      </p>
    </div>
  );
}

function LoopControls({
  flow,
  ids,
  onChange,
}: {
  flow: Extract<Flow, { kind: "loop" }>;
  ids: readonly string[];
  onChange: (flow: Extract<Flow, { kind: "loop" }>) => void;
}): JSX.Element {
  const set = (patch: Partial<Extract<Flow, { kind: "loop" }>>) =>
    onChange({ ...flow, ...patch });
  const untilOptions = FLAGS.map((flag) => `flags.${flag}`);
  const hasKnownUntil = untilOptions.includes(flow.until);
  return (
    <span
      style={{
        display: "inline-flex",
        flexWrap: "wrap",
        gap: 6,
        alignItems: "center",
      }}
    >
      <span className="subtle">반복할 단계</span>
      <select
        value={flow.bodyTarget}
        onChange={(e) => set({ bodyTarget: e.target.value })}
        style={SELECT}
      >
        {ids.map((id) => (
          <option key={id} value={id}>
            {id}
          </option>
        ))}
      </select>
      <span className="subtle">반복 후 이동</span>
      <select
        value={flow.exitTarget}
        onChange={(e) => set({ exitTarget: e.target.value })}
        style={SELECT}
      >
        {ids.map((id) => (
          <option key={id} value={id}>
            {id}
          </option>
        ))}
      </select>
      <span className="subtle">멈춤 조건</span>
      <select
        value={hasKnownUntil ? flow.until : "__custom"}
        onChange={(e) => {
          if (e.target.value !== "__custom") set({ until: e.target.value });
        }}
        style={SELECT}
      >
        {untilOptions.map((value) => {
          const flag = value.replace("flags.", "");
          return (
            <option key={value} value={value}>
              {flagLabel(flag)}
            </option>
          );
        })}
        {!hasKnownUntil && <option value="__custom">사용자 조건</option>}
      </select>
      <span className="subtle">최대 반복</span>
      <input
        type="number"
        min={1}
        max={10000}
        value={flow.maxIterations}
        onChange={(e) => set({ maxIterations: Number(e.target.value) })}
        style={{ ...SELECT, width: 72 }}
      />
    </span>
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
  const set = (i: number, patch: Partial<Rule>) =>
    onChange(rules.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <span style={{ display: "inline-flex", flexDirection: "column", gap: 4 }}>
      {rules.map((r, i) => (
        <span
          key={i}
          style={{ display: "inline-flex", gap: 4, alignItems: "center" }}
        >
          <span className="subtle">조건</span>
          <select
            value={r.when.replace("flags.", "")}
            onChange={(e) => set(i, { when: `flags.${e.target.value}` })}
            style={SELECT}
          >
            {FLAGS.map((f) => (
              <option key={f} value={f}>
                {flagLabel(f)}
              </option>
            ))}
          </select>
          <span className="subtle">이동</span>
          <select
            value={r.target}
            onChange={(e) => set(i, { target: e.target.value })}
            style={SELECT}
          >
            {ids.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
          <span className="subtle">순서</span>
          <input
            type="number"
            value={r.priority}
            onChange={(e) => set(i, { priority: Number(e.target.value) })}
            style={{ ...SELECT, width: 52 }}
          />
          <button
            className="btn"
            type="button"
            onClick={() => onChange(rules.filter((_, j) => j !== i))}
            disabled={rules.length === 1}
          >
            ×
          </button>
        </span>
      ))}
      <button
        className="btn"
        type="button"
        onClick={() =>
          onChange([
            ...rules,
            {
              when: "flags.blocked",
              target: ids[0] ?? "n1",
              priority: rules.length + 1,
            },
          ])
        }
      >
        + 조건
      </button>
    </span>
  );
}
