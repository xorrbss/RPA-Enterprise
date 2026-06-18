import { useCallback, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useApiClient } from "../api/context";
import { ApiError, type ValidationResult } from "../api/types";
import { errorLabel } from "./badges";
import { ConfirmDialog } from "./ConfirmDialog";
import { StepBuilder, stepBuilderInitialFromIr } from "./StepBuilder";
import { OperatorWizard, wizardInitialFromIr } from "./OperatorWizard";

// 자동화(시나리오) 작성/편집 폼. IR 문서(ir.schema)를 입력 → 저장 시 백엔드 컴파일 파이프라인
// (ajv→IREL→V1–V11)이 검증. 편집은 GET으로 직전 IR을 불러와 prefill하고 [검증](dry-run) 후
// [저장](PUT If-Match=현재 version → 새 draft, meta.version=현재+1). 조용한 실패 금지: ApiError 코드+상세 표면화.

export type ScenarioFormMode =
  | { readonly kind: "create" }
  | { readonly kind: "edit"; readonly scenarioId: string; readonly name: string; readonly version: number };
type EditorMode = "easy" | "form" | "ir";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// 권위 있는 유효 IR(app/test/scenarios.int.ts validIr 기준). 새 자동화 작성의 출발 템플릿.
function template(name: string, version: number): string {
  return JSON.stringify(
    {
      meta: { name, version, studio_mode: "ir" },
      start: "n1",
      nodes: {
        n1: {
          on: [
            { when: "flags.blocked", target: "n2", priority: 1 },
            { when: "flags.not_found", target: "n3", priority: 0 },
          ],
        },
        n2: { terminal: "success" },
        n3: { terminal: "success" },
      },
    },
    null,
    2,
  );
}

// 직전 IR을 새 버전 번호로 bump해 편집 출발점으로 사용(meta.version=현재+1, PUT 규칙).
function bumpVersion(ir: unknown, version: number): string {
  if (isRecord(ir)) {
    const meta = isRecord(ir.meta) ? ir.meta : {};
    return JSON.stringify({ ...ir, meta: { ...meta, version } }, null, 2);
  }
  return JSON.stringify(ir, null, 2);
}

function studioModeFromIr(ir: unknown): EditorMode {
  if (!isRecord(ir) || !isRecord(ir.meta)) return "ir";
  return ir.meta.studio_mode === "easy" || ir.meta.studio_mode === "form" || ir.meta.studio_mode === "ir"
    ? ir.meta.studio_mode
    : "ir";
}

function withStudioMode(ir: unknown, studioMode: EditorMode): unknown {
  if (!isRecord(ir)) return ir;
  const meta = isRecord(ir.meta) ? ir.meta : {};
  return { ...ir, meta: { ...meta, studio_mode: studioMode } };
}

function describe(e: unknown): string {
  // web-고유 행동지향 분기: 붙여넣은 IR JSON 자체가 깨진 경우는 계약 코드가 아니라 입력 수정 안내(보존).
  if (e instanceof SyntaxError) return "JSON 형식 오류 — 중괄호/쉼표를 확인하세요.";
  // 그 외(ApiError 포함)는 errorLabel(계약 userMessage 미러)로 통일하되, 검증 details는 진단용으로 부가.
  if (e instanceof ApiError && e.body?.details) {
    return `${errorLabel(e)} — ${JSON.stringify(e.body.details)}`;
  }
  return errorLabel(e);
}

export function ScenarioForm({ mode, onClose }: { mode: ScenarioFormMode; onClose: () => void }): JSX.Element {
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

  const [text, setText] = useState<string | null>(() => (isEdit ? null : template("새 자동화 예시", 1)));
  const [report, setReport] = useState<ValidationResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 생성은 '쉬운 만들기(운영자 마법사)' 기본. 단계 편집/IR 직접 편집은 고급. 편집은 직전 IR prefill로 'IR' 고정.
  const [editor, setEditor] = useState<EditorMode>(isEdit ? "ir" : "easy");
  // dirty = IR 텍스트를 직접 편집함(빌더 생성물과 다름). pendingEditor = 전환 확인 대기.
  const [dirty, setDirty] = useState(false);
  const [pendingEditor, setPendingEditor] = useState<EditorMode | null>(null);
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
    if (mode.kind !== "edit" || text !== null || detail.data === undefined) return;
    const ir = detail.data.ir;
    setDirty(false);
    setEditor(studioModeFromIr(ir));
    setText(ir !== undefined ? bumpVersion(ir, mode.version + 1) : template(mode.name, mode.version + 1));
  }, [mode, text, detail.data]);

  function parseIr(): unknown {
    return JSON.parse(text ?? "");
  }

  const currentVersion = mode.kind === "edit" ? mode.version + 1 : 1;
  const parsedIr = useMemo(() => {
    try {
      return text !== null ? JSON.parse(text) as unknown : undefined;
    } catch {
      return undefined;
    }
  }, [text]);
  const wizardInitial = useMemo(() => wizardInitialFromIr(parsedIr), [parsedIr]);
  const stepInitial = useMemo(() => stepBuilderInitialFromIr(parsedIr), [parsedIr]);

  const validate = useMutation({
    mutationFn: async () => {
      if (mode.kind !== "edit") throw new Error("새 시나리오는 저장 시 검증됩니다");
      return api.validateScenario(mode.scenarioId, withStudioMode(parseIr(), editor), crypto.randomUUID());
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
      return mode.kind === "edit" ? api.updateScenario(mode.scenarioId, stamped, mode.version) : api.createScenario(stamped);
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
      <section className="panel" style={{ marginBottom: 16, padding: 16 }} aria-label="자동화 편집">
        <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <strong>자동화 편집 — {(mode as { name: string }).name}</strong>
          <button className="btn" type="button" onClick={onClose}>
            닫기
          </button>
        </header>
        <p className="subtle" role="status" style={{ margin: "8px 0 0" }}>
          {detail.isError ? "직전 시나리오를 불러오지 못했습니다." : "직전 시나리오를 불러오는 중…"}
        </p>
      </section>
    );
  }

  return (
    <section className="panel" style={{ marginBottom: 16, padding: 16 }} aria-label="자동화 작성">
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <strong>{isEdit ? `자동화 편집 — ${mode.name} (v${mode.version} → v${mode.version + 1})` : "새 자동화 만들기"}</strong>
        <button className="btn" type="button" onClick={onClose} disabled={busy}>
          닫기
        </button>
      </header>
      <p className="subtle" style={{ margin: "0 0 8px" }}>
        {!isEdit && editor === "easy"
          ? "질문에 답하면 자동화가 만들어집니다. 저장할 때 자동으로 검증됩니다."
          : "자동화 시나리오를 IR 문서로 작성합니다. 저장 시 문법(ajv)·조건식(IREL)·그래프(V1–V11) 검증을 통과해야 합니다."}
        {isEdit ? " 편집은 새 버전(draft)으로 저장되며 이름은 바꿀 수 없습니다." : ""}
      </p>
      <div role="tablist" style={{ display: "flex", gap: 6, marginBottom: 10, flexWrap: "wrap" }}>
        <button className="btn" type="button" aria-pressed={editor === "easy"} onClick={() => switchEditor("easy")}>
          쉬운 만들기
        </button>
        <button className="btn" type="button" aria-pressed={editor === "form"} onClick={() => switchEditor("form")}>
          단계 편집(고급)
        </button>
        <button className="btn" type="button" aria-pressed={editor === "ir"} onClick={() => switchEditor("ir")}>
          IR 직접 편집(개발자)
        </button>
      </div>
      {editor === "easy" ? (
        <OperatorWizard key={`easy-${editId ?? "new"}`} onChange={handleBuilderChange} initial={wizardInitial} version={currentVersion} />
      ) : editor === "form" ? (
        <StepBuilder key={`form-${editId ?? "new"}`} onChange={handleBuilderChange} initial={stepInitial} version={currentVersion} />
      ) : (
        <textarea
          value={text ?? ""}
          onChange={(e) => { setText(e.target.value); setDirty(true); }}
          spellCheck={false}
          aria-label="IR 문서"
          style={{ width: "100%", minHeight: 260, fontFamily: "monospace", fontSize: 13, padding: 10, boxSizing: "border-box" }}
        />
      )}
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8 }}>
        {isEdit && (
          <button className="btn" type="button" onClick={() => validate.mutate()} disabled={busy}>
            {validate.isPending ? "검증 중…" : "검증"}
          </button>
        )}
        <button className="btn" type="button" onClick={() => save.mutate()} disabled={busy}>
          {save.isPending ? "저장 중…" : "저장"}
        </button>
        {report !== null && (
          <span className={`badge ${report.valid ? "green" : "red"}`}>{report.valid ? "정적 구조 검증 통과" : "검증 실패"}</span>
        )}
      </div>
      {error !== null && (
        <p className="badge red" role="alert" style={{ display: "block", marginTop: 8, whiteSpace: "pre-wrap" }}>
          {error}
        </p>
      )}
      {report !== null && !report.valid && (
        <pre style={{ marginTop: 8, fontSize: 12, maxHeight: 160, overflow: "auto" }}>{JSON.stringify(report.report, null, 2)}</pre>
      )}
      {pendingEditor !== null && (
        <ConfirmDialog
          title="IR 직접 편집 내용이 새로 생성되어 사라집니다. 계속할까요?"
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
