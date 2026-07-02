import { useEffect, useState } from "react";

import { useApiClient } from "../../api/context";
import { ActionButton } from "../../components/ActionButton";
import type { RunDetail } from "../../api/types";

// 실패 실행 재실행 — 원인을 확인한 그 자리(상세 패널)에서 목록 복귀 없이 재실행한다(실행 식별성 S1).
// '수정 입력'은 실행 원본 params(RunDetail.params, 진실원천)를 필드로 프리필해 값만 고쳐 돌린다 —
// raw JSON 타이핑 제거. 스칼라(문자열·숫자·불리언)만 필드로 노출하고 구조형 값은 원문 참고로만 보여준다
// (구조형 편집은 목록 행의 JSON 편집 경로가 전문가용으로 남아 있다 — 이중 편집 UI 금지, KISS).
export function RerunControls({ detail }: { readonly detail: RunDetail }): JSX.Element | null {
  const api = useApiClient();
  const [edited, setEdited] = useState<Record<string, string>>({});
  useEffect(() => setEdited({}), [detail.run_id]);
  const failed = detail.status === "failed_business" || detail.status === "failed_system";
  if (!failed) return null;

  const params = detail.params ?? null;
  const entries = params !== null ? Object.entries(params) : [];
  const scalarEntries = entries.filter(([, v]) => isScalarParam(v));
  const structuralEntries = entries.filter(([, v]) => !isScalarParam(v));

  const buildEditedParams = (): Record<string, unknown> => {
    const merged: Record<string, unknown> = { ...(params ?? {}) };
    for (const [key, raw] of Object.entries(edited)) {
      merged[key] = coerceEditedValue(key, raw, (params ?? {})[key]);
    }
    return merged;
  };

  return (
    <div
      role="region"
      aria-label="실패 실행 재실행"
      className="panel-body"
      style={{ display: "grid", gap: 8, margin: "8px 0 0", padding: 12, border: "1px solid var(--line)", borderRadius: 8 }}
    >
      <strong>다시 실행</strong>
      <span style={{ display: "inline-flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
        <ActionButton
          label="같은 입력 재실행"
          action="run.rerun"
          confirmText="이 실패 실행을 같은 입력으로 다시 실행할까요?"
          successText="재실행을 대기열에 등록했습니다."
          run={(key) => api.rerunRun(detail.run_id, { mode: "same_input" }, key)}
          invalidateKeys={[["runs"]]}
        />
      </span>
      {scalarEntries.length > 0 && (
        <div style={{ display: "grid", gap: 6 }}>
          <span className="subtle">입력값을 고쳐 다시 실행 — 실패했을 때의 값이 미리 채워져 있습니다.</span>
          {scalarEntries.map(([key, value]) => (
            <label key={key} style={{ display: "grid", gap: 2 }}>
              <span className="label">{key}</span>
              <input
                value={edited[key] ?? String(value)}
                onChange={(e) => setEdited((prev) => ({ ...prev, [key]: e.target.value }))}
              />
            </label>
          ))}
          <span>
            <ActionButton
              label="수정 입력으로 재실행"
              action="run.rerun"
              confirmText="수정한 입력값으로 이 실패 실행을 다시 실행할까요?"
              successText="수정 입력 재실행을 대기열에 등록했습니다."
              run={(key) =>
                api.rerunRun(
                  detail.run_id,
                  { mode: "edited_input", params: buildEditedParams(), reason: "operator edited input" },
                  key,
                )
              }
              invalidateKeys={[["runs"]]}
            />
          </span>
        </div>
      )}
      {entries.length === 0 && (
        <span className="subtle">이 실행에는 편집할 입력값이 없습니다.</span>
      )}
      {structuralEntries.length > 0 && (
        <details className="developer-details">
          <summary>구조형 입력값 원문(참고)</summary>
          <pre style={{ margin: "8px 0 0" }}>
            {JSON.stringify(Object.fromEntries(structuralEntries), null, 2)}
          </pre>
        </details>
      )}
    </div>
  );
}

function isScalarParam(value: unknown): value is string | number | boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

// 편집값을 원본 타입으로 되돌린다 — 숫자/불리언 파라미터를 문자열로 보내 서버 params_schema 검증에
// 걸리지 않게 한다. 무효 입력은 throw → ActionButton 오류 표면화(조용한 실패 금지).
function coerceEditedValue(key: string, raw: string, original: unknown): unknown {
  if (typeof original === "number") {
    const n = Number(raw.trim());
    if (!Number.isFinite(n)) throw new Error(`'${key}' 값은 숫자여야 합니다.`);
    return n;
  }
  if (typeof original === "boolean") {
    const t = raw.trim().toLowerCase();
    if (t === "true" || t === "예") return true;
    if (t === "false" || t === "아니오") return false;
    throw new Error(`'${key}' 값은 true 또는 false여야 합니다.`);
  }
  return raw;
}
