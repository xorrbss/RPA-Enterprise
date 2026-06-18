import { useMutation } from "@tanstack/react-query";
import { useState } from "react";

import { useApiClient } from "../api/context";
import { type ValidationResult } from "../api/types";
import { errorLabel } from "../components/badges";
import { navigate } from "../router";

// 시나리오 검증 — POST /v1/scenarios/{id}/validate(비변이)로 V1–V11 정적검증 dry-run, ValidationReport 렌더.
// IR 본문은 붙여넣기(에디터 전 단계). 저장/승격은 scenarioStudio.
interface Issue {
  rule?: string;
  code?: string;
  message?: string;
  node_id?: string;
}

function IssueList({ title, items, tone }: { title: string; items: Issue[]; tone: "red" | "amber" }): JSX.Element | null {
  if (items.length === 0) return null;
  return (
    <div style={{ marginTop: 12 }}>
      <strong style={{ fontSize: 13 }}>
        {title} ({items.length})
      </strong>
      <ul style={{ margin: "6px 0 0", paddingLeft: 18, fontSize: 13 }}>
        {items.map((it, i) => (
          <li key={i} style={{ marginBottom: 4 }}>
            <span className={`badge ${tone}`}>{it.rule ?? it.code ?? "rule"}</span> {it.message ?? JSON.stringify(it)}
            {it.node_id !== undefined ? <code> @{it.node_id}</code> : null}
            <div className="prescription">
              <span className="subtle">{prescriptionFor(it)}</span>
              <button className="linklike" type="button" onClick={() => navigate("scenarioStudio")}>
                자동화 편집으로 이동 <span aria-hidden="true">→</span>
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function prescriptionFor(issue: Issue): string {
  const key = `${issue.rule ?? ""} ${issue.code ?? ""} ${issue.message ?? ""}`.toLowerCase();
  if (key.includes("instruction") || key.includes("extract")) return "데이터 추출 단계에 추출/입력 규칙과 출력 스키마가 있는지 확인하세요.";
  if (key.includes("target") || key.includes("branch") || key.includes("node")) return "조건 분기 대상과 다음 단계 ID가 실제 단계 목록에 존재하는지 확인하세요.";
  if (key.includes("priority")) return "같은 조건 그룹에서 우선순위가 겹치지 않도록 숫자를 조정하세요.";
  if (key.includes("loop")) return "반복 단계에는 종료 조건과 최대 반복 횟수가 필요합니다.";
  if (key.includes("url") || key.includes("navigate")) return "페이지 이동 단계의 URL 실행값과 사이트 등록 상태를 확인하세요.";
  return "자동화 만들기의 단계 편집 또는 IR 직접 편집에서 해당 규칙을 수정하세요.";
}

export function IrValidationView(): JSX.Element {
  const api = useApiClient();
  const [scenarioId, setScenarioId] = useState("");
  const [irText, setIrText] = useState('{\n  "nodes": []\n}');
  const mut = useMutation({
    mutationFn: async (): Promise<ValidationResult> => {
      let ir: unknown;
      try {
        ir = JSON.parse(irText);
      } catch {
        throw new Error("IR JSON 파싱 실패 — 유효한 JSON을 입력하세요.");
      }
      return api.validateScenario(scenarioId.trim(), ir, crypto.randomUUID());
    },
  });

  const report = (mut.data?.report ?? {}) as { errors?: Issue[]; warnings?: Issue[] };
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>시나리오 정적검증 (V1–V11)</h2>
      </div>
      <div className="panel-body" style={{ padding: 16, display: "flex", flexDirection: "column", gap: 10 }}>
        <label style={{ fontSize: 12, color: "var(--muted)", display: "flex", flexDirection: "column", gap: 4 }}>
          시나리오 ID
          <input
            value={scenarioId}
            onChange={(e) => setScenarioId(e.target.value)}
            placeholder="00000000-0000-0000-0000-000000000000"
            style={{ padding: "7px 10px", borderRadius: 8, border: "1px solid var(--line-strong)", fontSize: 13 }}
          />
        </label>
        <label style={{ fontSize: 12, color: "var(--muted)", display: "flex", flexDirection: "column", gap: 4 }}>
          IR (JSON)
          <textarea
            value={irText}
            onChange={(e) => setIrText(e.target.value)}
            rows={10}
            spellCheck={false}
            style={{ padding: 10, borderRadius: 8, border: "1px solid var(--line-strong)", fontFamily: "monospace", fontSize: 12 }}
          />
        </label>
        <div>
          <button
            className="btn primary"
            type="button"
            disabled={scenarioId.trim() === "" || mut.isPending}
            onClick={() => mut.mutate()}
          >
            {mut.isPending ? "검증 중…" : "검증 실행"}
          </button>
        </div>
        {mut.isError && <div className="badge red">{errorLabel(mut.error)}</div>}
        {/* 성공 표기는 validate가 실제 보고한 valid(=V1–V11 dry-run 통과)만 말한다. 승격 가능 여부(scenario.promote admin */}
        {/* 게이트·If-Match version 동시성)는 이 화면이 관찰한 적 없으므로 단정하지 않는다(조용한 false 금지; */}
        {/* api-surface §2(validate=dry-run, line 91)·저장X, promote만 승격). 승격은 scenarioStudio 별도 명령으로 안내만 한다. */}
        {mut.data !== undefined && (
          <div>
            <span className={`badge ${mut.data.valid ? "green" : "red"}`}>{mut.data.valid ? "정적 구조 검증 통과" : "검증 실패"}</span>
            {mut.data.valid && (
              <p className="subtle" style={{ marginTop: 8 }}>
                이 결과는 IR 문서 구조, IREL 식, 그래프 규칙만 확인합니다. 사이트 로그인 상태, 셀렉터 존재, 실제 추출 가능성은 실행으로 별도 확인해야 합니다. prod 승격은 별도 명령(관리자 권한·버전 일치 필요)으로,{" "}
                <button className="linklike" type="button" onClick={() => navigate("scenarioStudio")}>
                  자동화 만들기에서 진행 <span aria-hidden="true">→</span>
                </button>
                합니다.
              </p>
            )}
            <IssueList title="오류" items={report.errors ?? []} tone="red" />
            <IssueList title="경고" items={report.warnings ?? []} tone="amber" />
          </div>
        )}
      </div>
    </section>
  );
}
