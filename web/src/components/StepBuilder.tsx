import { useEffect, useRef, useState } from "react";

import { terminalLabel } from "./badges";
import { BranchRules, LoopControls } from "./step-builder/FlowEditors";
import {
  ACTIONS,
  ACTION_LABELS,
  DEFAULT_SCHEMA_REF,
  DEFAULT_STEPS,
  DEFAULT_URL_REF,
  FLOW_LABELS,
  SELECT,
  TERMINALS,
  defaultActionInstruction,
  defaultExtractInstruction,
  initialCounter,
  stepsToIr,
  type Flow,
  type Step,
  type StepBuilderInitial,
} from "./step-builder/model";

// 단계 빌더(비주얼 스튜디오 1차 슬라이스): 단계(노드)를 양식으로 구성 → 유효 IR 생성.
// 안전 범위: action은 act/observe/none과 필수 필드를 폼으로 채울 수 있는 extract/navigate를 생성한다.
// shell/api_call처럼 별도 레지스트리나 비밀 경계가 필요한 액션은 '자동화 정의 직접 편집'에서 다룬다(무효 IR 미생성 원칙).
// 산출 IR은 그대로 컴파일 파이프라인(ajv→IREL→V1–V11)이 저장 시 재검증한다.

// 단계 모델·IR 변환·round-trip 판별은 step-builder/model.ts 소관. 소비처(ScenarioForm·OperatorWizard·테스트) 호환 위해 re-export.
export { flagLabel, stepBuilderInitialFromIr, stepBuilderRepresentable } from "./step-builder/model";
export type { Step, StepBuilderInitial } from "./step-builder/model";

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
