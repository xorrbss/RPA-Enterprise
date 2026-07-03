// mapHumanTask 실 투영과 1:1. on_timeout=human_tasks.on_timeout 실 컬럼(타임아웃 시 동작).
// V2 검증 워크벤치용 payload/result_schema/artifact_refs/result를 포함하되 artifact 본문은 Artifacts API로 별도 조회한다.
export interface HumanTaskItem {
  readonly human_task_id: string;
  readonly state: string;
  readonly kind: string;
  readonly assignee: string | null;
  readonly timeout: string | null;
  readonly on_timeout: string | null;
  readonly run_id: string | null;
  readonly payload?: Record<string, unknown> | null;
  readonly result_schema?: Record<string, unknown> | null;
  readonly artifact_refs?: readonly string[];
  readonly result?: HumanTaskResolution | null;
  readonly escalation_reason?: string | null; // H5 이관 사유(optional). 재배정 담당자 맥락.
  readonly escalated_by?: string | null;
  readonly escalated_at?: string | null;
}

export interface HumanTaskResolution {
  readonly decision: "approve" | "reject" | "correct" | "retry";
  readonly corrections?: Record<string, unknown>;
  readonly reason?: string;
  readonly confidence?: number;
  readonly notes?: string;
}

export type HumanTaskBusinessFormFieldType = "text" | "textarea" | "number" | "boolean" | "date" | "select";

export interface HumanTaskBusinessFormField {
  readonly key: string;
  readonly label: string;
  readonly type: HumanTaskBusinessFormFieldType;
  readonly required?: boolean;
  readonly options?: readonly string[];
  readonly help_text?: string;
}

export interface HumanTaskBusinessFormSchema {
  readonly version: "business_form_v1";
  readonly fields: readonly HumanTaskBusinessFormField[];
}

export interface HumanTaskPolicySnapshot {
  readonly source: string;
  readonly default_timeout_ms: number;
  readonly on_timeout: "fail" | "escalate";
  readonly allowed_kinds: readonly string[];
}

// 하이웍스 결재 수집 행(수집 run의 extract 아티팩트 content = JSON `{ rows: ApprovalRow[] }`). 고정 계약(api-surface 기록).
// doc_ref: 하이웍스 office origin 절대 URL(결재 run의 navigate 대상) — 필수·actionable(없으면 건별 결재 불가).
export interface ApprovalRow {
  readonly doc_ref: string;
  readonly approval_id?: string;
  readonly title: string;
  readonly status: string;
  readonly doc_type: string;
  readonly drafter: string;
  readonly drafted_at?: string;
}

// POST /v1/approvals/decide body(닫힌 shape — 백엔드 parseDecideBody 정합). reject 는 reason 필수(엔드포인트 강제).
export interface DecideApprovalBody {
  readonly source_run_id: string; // 인박스를 노출한 수집 run
  readonly doc_ref: string; // 결재 문서 참조(approval origin 절대 URL)
  readonly decision: "approve" | "reject";
  readonly reason?: string;
}

// POST /v1/approvals/decide 201 응답. spawned_run_id = 내부에서 스폰된 결재 처리 run(콘솔이 폴링·딥링크).
export interface DecideApprovalResult {
  readonly decision_id: string;
  readonly source_run_id: string;
  readonly doc_ref: string;
  readonly decision: "approve" | "reject";
  readonly spawned_run_id: string;
}

// POST /v1/approvals/fan-out 201 응답 — 수집 목록의 각 행을 검토 run(@human_task)으로 일괄 스폰.
//   spawned = 새로 스폰된 검토 run(doc_ref↔run_id), skipped = 스폰 못 한 행(already_fanned_out/invalid_doc_ref/missing_approval_id 등).
export interface FanOutApprovalsResult {
  readonly source_run_id: string;
  readonly spawned: ReadonlyArray<{ readonly doc_ref: string; readonly run_id: string }>;
  readonly spawned_count: number;
  readonly skipped: ReadonlyArray<{ readonly doc_ref: string; readonly reason: string }>;
  readonly skipped_count: number;
  readonly total: number;
  readonly auto_enabled?: boolean; // enable_auto 요청 시 이 수집 시나리오의 자동 fan-out 을 켰음(②).
}
