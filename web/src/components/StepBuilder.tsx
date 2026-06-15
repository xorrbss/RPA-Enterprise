import { useEffect, useRef, useState } from "react";

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
const ACTIONS = ["none", "observe", "act"] as const;

type Rule = { when: string; target: string; priority: number };
type Flow =
  | { kind: "terminal"; terminal: string }
  | { kind: "next"; target: string }
  | { kind: "on"; rules: Rule[] };
export interface Step {
  id: string;
  action: (typeof ACTIONS)[number];
  flow: Flow;
}

function stepsToIr(name: string, steps: readonly Step[]): unknown {
  const nodes: Record<string, Record<string, unknown>> = {};
  for (const s of steps) {
    const node: Record<string, unknown> = {};
    if (s.action !== "none") node.what = [{ action: s.action }];
    if (s.flow.kind === "terminal") node.terminal = s.flow.terminal;
    else if (s.flow.kind === "next") node.next = s.flow.target;
    else node.on = s.flow.rules.map((r) => ({ when: r.when, target: r.target, priority: r.priority }));
    nodes[s.id] = node;
  }
  return { meta: { name, version: 1 }, start: steps[0]?.id ?? "n1", nodes };
}

const SELECT = { padding: "4px 6px", fontSize: 13 } as const;

export function StepBuilder({ onChange }: { onChange: (ir: unknown) => void }): JSX.Element {
  const counter = useRef(2);
  const [name, setName] = useState("새 자동화");
  const [steps, setSteps] = useState<Step[]>([
    { id: "n1", action: "observe", flow: { kind: "on", rules: [{ when: "flags.not_found", target: "n2", priority: 1 }] } },
    { id: "n2", action: "none", flow: { kind: "terminal", terminal: "success" } },
  ]);

  // 단계/이름 변경 시 IR을 재생성해 상위(폼)로 전달 → 저장은 동일 파이프라인.
  useEffect(() => {
    onChange(stepsToIr(name, steps));
  }, [name, steps, onChange]);

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
              <select value={s.action} onChange={(e) => update(i, { action: e.target.value as Step["action"] })} style={SELECT}>
                <option value="none">없음(흐름만)</option>
                <option value="observe">관찰(observe)</option>
                <option value="act">조작(act)</option>
              </select>
            </label>
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
                    {t}
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
        ★ = 시작 단계. 저장 시 그래프 검증(V1–V11)을 통과해야 합니다. 세부 동작(extract/입력 등)은 ‘IR 직접 편집’에서 보강하세요.
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
