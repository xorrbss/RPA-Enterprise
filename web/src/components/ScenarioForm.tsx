import { useCallback, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useApiClient } from "../api/context";
import { type ValidationResult } from "../api/types";
import { ConfirmDialog } from "./ConfirmDialog";
import { StepBuilder, stepBuilderInitialFromIr, stepBuilderRepresentable } from "./StepBuilder";
import { OperatorWizard, wizardInitialFromIr } from "./OperatorWizard";
import { StudioValidationStages } from "./StudioValidationStages";
import { VisualFlowCanvas } from "./VisualFlowCanvas";
import {
  bumpVersion,
  studioModeFromIr,
  template,
  withStudioMode,
  type EditorMode,
} from "./scenario-form/ir-mode";
import { describe, validationReportLines } from "./scenario-form/validation-report";

// 자동화(시나리오) 작성/편집 폼. 자동화 정의 원문(ir.schema)을 입력 → 저장 시 백엔드 컴파일 파이프라인
// (ajv→IREL→V1–V11)이 검증. 편집은 GET으로 직전 IR을 불러와 prefill하고 [검증](dry-run) 후
// [저장](PUT If-Match=현재 version → 새 draft, meta.version=현재+1). 조용한 실패 금지: ApiError 코드+상세 표면화.

export type ScenarioFormMode =
  | { readonly kind: "create" }
  | {
      readonly kind: "edit";
      readonly scenarioId: string;
      readonly name: string;
      readonly version: number;
    };

export function ScenarioForm({
  mode,
  onClose,
}: {
  mode: ScenarioFormMode;
  onClose: () => void;
}): JSX.Element {
  const api = useApiClient();
  const qc = useQueryClient();
  const isEdit = mode.kind === "edit";
  const editId = mode.kind === "edit" ? mode.scenarioId : null;

  // 편집: 직전 IR을 불러와 prefill.
  const detail = useQuery({
    queryKey: ["scenario-detail", editId ?? "new"],
    queryFn: () => api.getScenario(editId as string),
    enabled: editId !== null,
  });

  const [text, setText] = useState<string | null>(() =>
    isEdit ? null : template("새 자동화 예시", 1),
  );
  const [report, setReport] = useState<ValidationResult | null>(null);
  const [error, setError] = useState<string | null>(null);
// 생성은 '쉬운 만들기(운영자 마법사)' 기본. 단계 편집/자동화 정의 직접 편집은 고급. 편집은 직전 IR prefill로 'IR' 고정.
  const [editor, setEditor] = useState<EditorMode>(isEdit ? "ir" : "easy");
  // dirty = IR 텍스트를 직접 편집함(빌더 생성물과 다름). pendingEditor = 전환 확인 대기.
  const [dirty, setDirty] = useState(false);
  const [pendingEditor, setPendingEditor] = useState<EditorMode | null>(null);
  // 개발자 편집 모드(<details>) 펼침 — 운영자 기본은 '쉬운 만들기', 단계/IR 편집은 접어 둔다. editor 전환 시 동기화.
  const [devEditorsOpen, setDevEditorsOpen] = useState(editor !== "easy");
  const handleBuilderChange = useCallback((ir: unknown) => {
    setText(JSON.stringify(ir, null, 2));
    setDirty(false); // 빌더가 생성한 텍스트 = 손실 위험 없음
  }, []);
  // 빌더(easy/form) 모드로 전환하면 mount-effect가 IR을 새로 생성해 텍스트를 덮어쓴다. IR을 직접 편집(dirty)했다면
  // 무음 손실이므로 ConfirmDialog로 경고(native confirm 대체). ir 모드 전환은 텍스트 보존이라 무경고.
  const switchEditor = (target: EditorMode): void => {
    if (target !== editor && target !== "ir" && dirty) setPendingEditor(target);
    else setEditor(target);
  };

  // editor 모드와 개발자 편집 details 펼침 동기화(easy=접힘, 단계/IR=펼침). 사용자 수동 토글은 onToggle로 유지.
  useEffect(() => {
    setDevEditorsOpen(editor !== "easy");
  }, [editor]);

  useEffect(() => {
    setReport(null);
    setError(null);
    setDirty(false);
    setPendingEditor(null);
    if (mode.kind === "edit") {
      setEditor("ir");
      setText(null);
    } else {
      setEditor("easy");
      setText(template("새 자동화 예시", 1));
    }
  }, [mode.kind, editId]);

  useEffect(() => {
    if (mode.kind !== "edit" || text !== null || detail.data === undefined)
      return;
    const ir = detail.data.ir;
    setDirty(false);
    // studio_mode 를 따르되, 그 빌더가 이 IR 을 표현 못 하면 '직접 편집'으로 강등(무음 손실 차단). 승인 분기 정형은 easy 유지.
    const sm = studioModeFromIr(ir);
    setEditor(
      sm === "easy" && wizardInitialFromIr(ir) === undefined
        ? "ir"
        : sm === "form" && !stepBuilderRepresentable(ir)
          ? "ir"
          : sm,
    );
    setText(
      ir !== undefined
        ? bumpVersion(ir, mode.version + 1)
        : template(mode.name, mode.version + 1),
    );
  }, [mode, text, detail.data]);

  function parseIr(): unknown {
    return JSON.parse(text ?? "");
  }

  const currentVersion = mode.kind === "edit" ? mode.version + 1 : 1;
  const parsedIr = useMemo(() => {
    try {
      return text !== null ? (JSON.parse(text) as unknown) : undefined;
    } catch {
      return undefined;
    }
  }, [text]);
  const wizardInitial = useMemo(
    () => wizardInitialFromIr(parsedIr),
    [parsedIr],
  );
  const stepInitial = useMemo(
    () => stepBuilderInitialFromIr(parsedIr),
    [parsedIr],
  );
  // 빌더가 무음으로 IR 을 파괴하는 경우를 모드별로 잠근다(조용한 false 방지).
  //   - 단계 편집(StepBuilder): 예약 핸들러(@human_task)·fallback_chain·미지원/다중 what 액션(api_call·shell 등)을 표현 못 해
  //     terminal/none 으로 떨군다 → stepBuilderRepresentable 가 false 면 잠금(formUnsafe). C4 의 예약-핸들러 한정 가드 확장.
  //   - 쉬운 만들기(OperatorWizard): 승인 분기는 1급 지원(C4b)이나, 그 외 형태(일반 @human_task·손편집 분기)는 표현 불가
  //     → wizardInitialFromIr 가 undefined(easyUnsafe). 승인 분기 정형은 라운드트립 가능해 잠기지 않는다.
  const formUnsafe = useMemo(() => !stepBuilderRepresentable(parsedIr), [parsedIr]);
  const easyUnsafe = wizardInitial === undefined;
  // '직접 편집' 전용(어느 빌더로도 안전히 못 여는) IR — 운영자 안내 노트 표시 기준.
  const rawOnly = formUnsafe && easyUnsafe;

  // 방어 심층: 현재 빌더 모드가 이 IR 을 표현 못 하면 '직접 편집'으로 되돌린다(무음 손실 차단).
  useEffect(() => {
    if ((editor === "easy" && easyUnsafe) || (editor === "form" && formUnsafe)) setEditor("ir");
  }, [editor, easyUnsafe, formUnsafe]);

  const validate = useMutation({
    mutationFn: async () => {
      if (mode.kind !== "edit")
        throw new Error("새 자동화는 저장 시 검증됩니다");
      return api.validateScenario(
        mode.scenarioId,
        withStudioMode(parseIr(), editor),
        crypto.randomUUID(),
      );
    },
    onMutate: () => {
      setError(null);
      setReport(null);
    },
    onSuccess: (r) => setReport(r),
    onError: (e) => setError(describe(e)),
  });

  const save = useMutation({
    mutationFn: async () => {
      const ir = parseIr();
      const stamped = withStudioMode(ir, editor);
      return mode.kind === "edit"
        ? api.updateScenario(mode.scenarioId, stamped, mode.version)
        : api.createScenario(stamped);
    },
    onMutate: () => {
      setError(null);
      setReport(null);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["scenarios"] });
      onClose();
    },
    onError: (e) => setError(describe(e)),
  });

  const busy = validate.isPending || save.isPending;

  // 편집 prefill 로딩/오류 — 조용한 빈화면 금지.
  if (isEdit && text === null) {
    return (
      <section
        className="panel"
        style={{ marginBottom: 16, padding: 16 }}
        aria-label="자동화 편집"
      >
        <header
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <strong>자동화 편집 — {(mode as { name: string }).name}</strong>
          <button className="btn" type="button" onClick={onClose}>
            닫기
          </button>
        </header>
        <p className="subtle" role="status" style={{ margin: "8px 0 0" }}>
          {detail.isError
            ? "직전 자동화 정의를 불러오지 못했습니다."
            : "직전 자동화 정의를 불러오는 중…"}
        </p>
      </section>
    );
  }

  return (
    <section
      className="panel"
      style={{ marginBottom: 16, padding: 16 }}
      aria-label="자동화 작성"
    >
      <header
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 8,
        }}
      >
        <strong>
          {isEdit
            ? `자동화 편집 — ${mode.name} (v${mode.version} → v${mode.version + 1})`
            : "새 자동화 만들기"}
        </strong>
        <button className="btn" type="button" onClick={onClose} disabled={busy}>
          닫기
        </button>
      </header>
      <p className="subtle" style={{ margin: "0 0 8px" }}>
        {!isEdit && editor === "easy"
          ? "질문에 답하면 자동화가 만들어집니다. 저장할 때 자동으로 검증됩니다."
          : "자동화 문서를 직접 작성합니다. 저장 시 형식·조건식·단계 연결 검증을 통과해야 합니다."}
        {isEdit
          ? " 편집은 새 초안 버전으로 저장되며 이름은 바꿀 수 없습니다."
          : ""}
      </p>
      <div
        className="editor-switch"
        style={{
          display: "flex",
          gap: 6,
          marginBottom: 10,
          flexWrap: "wrap",
          alignItems: "flex-start",
        }}
      >
        <button
          className="btn"
          type="button"
          aria-pressed={editor === "easy"}
          onClick={() => switchEditor("easy")}
          disabled={busy || easyUnsafe}
        >
          쉬운 만들기
        </button>
        <details
          className="advanced-editors"
          open={devEditorsOpen}
          onToggle={(event) =>
            setDevEditorsOpen((event.currentTarget as HTMLDetailsElement).open)
          }
        >
          <summary>개발자 편집 모드</summary>
          <div
            role="group"
            aria-label="개발자 편집 방식"
            style={{ display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap" }}
          >
            <button
              className="btn"
              type="button"
              aria-pressed={editor === "form"}
              onClick={() => switchEditor("form")}
              disabled={busy || formUnsafe}
            >
              단계 편집
            </button>
            <button
              className="btn"
              type="button"
              aria-pressed={editor === "visual"}
              onClick={() => switchEditor("visual")}
              disabled={busy}
            >
              시각 캔버스
            </button>
            <button
              className="btn"
              type="button"
              aria-pressed={editor === "ir"}
              onClick={() => switchEditor("ir")}
            >
              자동화 정의 직접 편집
            </button>
          </div>
        </details>
      </div>
      {rawOnly && (
        <p role="note" style={{ margin: "8px 0", fontSize: 13, color: "var(--muted, #555)" }}>
          이 자동화는 <strong>사람 승인 분기</strong>(승인·반려에 따라 흐름이 갈리는 단계) 같은 고급 흐름을 포함해, ‘쉬운
          만들기·단계 편집’으로 열면 그 단계가 사라질 수 있어요. 그래서 ‘자동화 정의 직접 편집’에서만 안전하게 수정합니다.
        </p>
      )}
      {editor === "easy" ? (
        <OperatorWizard
          key={`easy-${editId ?? "new"}`}
          onChange={handleBuilderChange}
          initial={wizardInitial}
          version={currentVersion}
        />
      ) : editor === "form" ? (
        <StepBuilder
          key={`form-${editId ?? "new"}`}
          onChange={handleBuilderChange}
          initial={stepInitial}
          version={currentVersion}
        />
      ) : editor === "visual" ? (
        <VisualFlowCanvas ir={parsedIr} />
      ) : (
        <textarea
          value={text ?? ""}
          onChange={(e) => {
            setText(e.target.value);
            setDirty(true);
          }}
          spellCheck={false}
          aria-label="자동화 정의 원문"
          style={{
            width: "100%",
            minHeight: 260,
            fontFamily: "monospace",
            fontSize: 13,
            padding: 10,
            boxSizing: "border-box",
          }}
        />
      )}
      <div
        style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8 }}
      >
        {isEdit && (
          <button
            className="btn"
            type="button"
            onClick={() => validate.mutate()}
            disabled={busy}
          >
            {validate.isPending ? "검증 중…" : "검증"}
          </button>
        )}
        <button
          className="btn"
          type="button"
          onClick={() => save.mutate()}
          disabled={busy}
        >
          {save.isPending ? "저장 중…" : "저장"}
        </button>
        {report !== null && (
          <span className={`badge ${report.valid ? "green" : "red"}`}>
            {report.valid ? "자동화 정의 검사 통과" : "검증 실패"}
          </span>
        )}
      </div>
      {error !== null && (
        <p
          className="badge red"
          role="alert"
          style={{ display: "block", marginTop: 8, whiteSpace: "pre-wrap" }}
        >
          {error}
        </p>
      )}
      {report !== null && (
        <div className="scenario-validation-summary" role="status" aria-label="검증 단계">
          <strong>검증 단계</strong>
          <StudioValidationStages stages={report.stages} />
        </div>
      )}
      {report !== null && !report.valid && (
        <div
          className="scenario-validation-summary"
          role="status"
          aria-label="검증 실패 요약"
        >
          <strong>검증 결과 요약</strong>
          <ul>
            {validationReportLines(report.report).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <details>
            <summary>원본 검증 결과 보기</summary>
            <pre>{JSON.stringify(report.report, null, 2)}</pre>
          </details>
        </div>
      )}
      {pendingEditor !== null && (
        <ConfirmDialog
          title="자동화 정의 직접 편집 내용이 새로 생성되어 사라집니다. 계속할까요?"
          confirmLabel="계속"
          onCancel={() => setPendingEditor(null)}
          onConfirm={() => {
            setDirty(false);
            setEditor(pendingEditor);
            setPendingEditor(null);
          }}
        />
      )}
    </section>
  );
}
