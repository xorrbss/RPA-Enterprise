import { useEffect, useState } from "react";

import {
  APPROVAL_ASSIGNEE_ROLES,
  DEFAULT_ASSIGNEE_ROLE,
  DEFAULT_MAX_PAGES,
  DEFAULT_NEXT_INSTRUCTION,
  DEFAULT_NO_NEXT_FLAG,
  PAGE_END_FLAGS,
  TEMPLATES,
  buildApprovalIr,
  buildIr,
  urlState,
  type Kind,
  type OperatorWizardInitial,
  type TemplateKey,
} from "./operator-wizard/wizard-ir";
import { flagLabel } from "./StepBuilder";

// IR 생성·라운드트립 판별은 operator-wizard/wizard-ir.ts 소관. 소비처(ScenarioForm·테스트) 호환 위해 re-export.
export { buildIr, buildApprovalIr, wizardInitialFromIr } from "./operator-wizard/wizard-ir";
export type { OperatorWizardInitial, PaginationOptions } from "./operator-wizard/wizard-ir";

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
  const [templateKey, setTemplateKey] = useState<TemplateKey>(initial?.template ?? "list_collect");
  const template = TEMPLATES[templateKey];
  const [name, setName] = useState(initial?.name ?? template.defaultName);
  const [pageUrl, setPageUrl] = useState(initial?.pageUrl ?? "");
  const [assigneeRole, setAssigneeRole] = useState(initial?.assigneeRole ?? DEFAULT_ASSIGNEE_ROLE);
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

  const isApproval = templateKey === "approval_branch";

  // 입력이 바뀔 때마다 IR 재생성 → 상위(폼)로 전달. 저장은 동일 파이프라인. 승인 분기는 전용 생성기(buildApprovalIr).
  useEffect(() => {
    onChange(
      isApproval
        ? buildApprovalIr(name, pageUrl, assigneeRole, version)
        : buildIr(name, pageUrl, dataName, kind, instruction, successCriteria, version, { maxPages: Number(maxPages), nextInstruction, noNextFlag }),
    );
  }, [isApproval, name, pageUrl, assigneeRole, dataName, kind, instruction, successCriteria, version, maxPages, nextInstruction, noNextFlag, onChange]);

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
            setAssigneeRole(DEFAULT_ASSIGNEE_ROLE);
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
      {isApproval && (
        <div className="panel" style={{ padding: 10, marginTop: 4, display: "grid", gap: 8, maxWidth: 560 }}>
          <label style={{ display: "grid", gap: 4 }}>
            <span className="subtle">③ 승인을 맡을 담당자 역할</span>
            <select value={assigneeRole} onChange={(e) => setAssigneeRole(e.target.value)} style={{ padding: "8px 10px", fontSize: 14, width: 220 }}>
              {APPROVAL_ASSIGNEE_ROLES.map((role) => (
                <option key={role} value={role}>{role === "approver" ? "승인자(approver)" : "검토자(reviewer)"}</option>
              ))}
            </select>
          </label>
          <span className="subtle">
            이 페이지를 연 뒤 <b>사람의 승인/반려</b>를 기다립니다. <b>승인</b>하면 자동화가 정상 완료되고, <b>반려</b>하면
            업무 실패로 종료합니다. (승인 후 다른 작업으로 이어지게 하려면 ‘자동화 정의 직접 편집’에서 분기 대상을 바꾸세요.)
          </span>
        </div>
      )}
      {!isApproval && (
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
        hint={<span className="subtle">자동화 정의 구조에 맞춰 실행 지시문에 포함됩니다.</span>}
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
            <span className="subtle">마지막 페이지 판정 방법</span>
            <select value={noNextFlag} onChange={(e) => setNoNextFlag(e.target.value)} style={{ padding: "8px 10px", fontSize: 14, width: 220 }}>
              {PAGE_END_FLAGS.map((flag) => (
                <option key={flag} value={flag}>{flagLabel(flag)}</option>
              ))}
            </select>
          </label>
          <span className="subtle">사이트 설정에서 이 화면 조건을 등록하면 마지막 페이지에서 반복이 멈춥니다.</span>
        </div>
      )}
      </details>
      )}
      <p className="badge" style={{ display: "block", margin: "10px 0 0", whiteSpace: "normal" }}>
        ⚠ 지금은 자동화의 <b>흐름(구조)</b>만 만들어 저장합니다. 실제로 이 페이지에서 데이터를 가져오는 동작은
        실행기(브라우저 워커) 연결과 사이트별 추출 설정이 있어야 합니다.
      </p>
    </div>
  );
}
