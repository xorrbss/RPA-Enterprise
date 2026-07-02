import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useApiClient } from "../api/context";
import { useCan } from "../api/permissions";
import { useListView } from "../api/useListView";
import { QueryPanel } from "../components/QueryPanel";
import { ActionButton } from "../components/ActionButton";
import { BrowserRecorderPanel } from "../components/BrowserRecorderPanel";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { PromptScenarioGenerator } from "../components/PromptScenarioGenerator";
import { RunScenarioButton } from "../components/RunScenarioButton";
import { ScenarioForm, type ScenarioFormMode } from "../components/ScenarioForm";
import { errorLabel } from "../components/badges";
import { navigate } from "../router";
import { formatDateTime } from "../util/time";
import type {
  ScenarioCertification,
  ScenarioEnvironmentBinding,
  ScenarioGovernanceStage,
  ScenarioGovernanceTransitionStage,
  ScenarioItem,
  ScenarioReleaseItem,
  ScenarioReleaseTarget,
  ScenarioVersionItem,
} from "../api/types";

// 자동화 만들기(시나리오 스튜디오): 작성/편집 폼 + 목록 + 운영 기준 지정.
// 생성=POST /v1/scenarios, 편집=PUT(If-Match), 운영 지정=POST /promote(If-Match=현재 version). 역할 게이팅: scenario.create/update/promote.
// 운영 지정은 실행 전제가 아니라 canonical 표시 + AST 캐시 빌드 역할이므로 실행 버튼보다 보조 액션으로 둔다.
export function ScenariosView(): JSX.Element {
  const api = useApiClient();
  const can = useCan();
  const scenarioList = useListView<ScenarioItem>(
    ["scenarios"],
    (params) => api.listScenarios(params),
    { limit: 50, refetchInterval: 10_000 },
  );
  const [form, setForm] = useState<ScenarioFormMode | null>(null);
  const [versionsFor, setVersionsFor] = useState<ScenarioItem | null>(null);
  const [releasesFor, setReleasesFor] = useState<ScenarioItem | null>(null);
  const recorderRef = useRef<HTMLDivElement | null>(null);

  function focusNaturalLanguageInput(): void {
    const target = document.getElementById("scenario-natural-language-request");
    target?.focus();
    target?.scrollIntoView?.({ block: "center" });
  }

  function focusRecorder(): void {
    recorderRef.current?.scrollIntoView?.({ block: "start" });
  }

  return (
    <div>
      {can("scenario.create") && (
        <>
          <section className="panel scenario-create-strip" aria-label="자동화 제작 시작">
            <div>
              <h2>자동화 제작 시작</h2>
              <p className="subtle">말로 시작해 초안을 만들고, 필요하면 로컬 브라우저 녹화로 보완합니다.</p>
            </div>
            <span className="scenario-create-actions">
              <button className="btn primary" type="button" onClick={focusNaturalLanguageInput}>
                자동화 초안 만들기
              </button>
              <button className="btn" type="button" onClick={focusRecorder}>
                브라우저 녹화로 만들기
              </button>
            </span>
          </section>
          <PromptScenarioGenerator />
        </>
      )}
      {can("scenario.create") && (
        <div ref={recorderRef}>
          <BrowserRecorderPanel />
        </div>
      )}
      {can("scenario.create") && (
        <ManualScenarioCreateDetails
          disabled={form?.kind === "create"}
          onCreate={() => setForm({ kind: "create" })}
        />
      )}
      {can("scenario.promote.approve") && <PromotionInbox />}
      {form !== null && <ScenarioForm mode={form} onClose={() => setForm(null)} />}
      <QueryPanel<ScenarioItem>
        title="자동화 목록"
        query={scenarioList.query}
        pager={scenarioList.pager}
        rowKey={(r) => r.scenario_id}
        emptyTitle="첫 실행 전"
        emptyMessage="저장된 자동화가 없습니다. 문장으로 초안을 만든 뒤 테스트 실행까지 이어가세요."
        emptyAction={
          can("scenario.create") ? (
            <button className="btn primary" type="button" onClick={focusNaturalLanguageInput}>
              자동화 초안 만들기
            </button>
          ) : undefined
        }
        columns={[
          { header: "이름", render: (r) => <ScenarioNameCell scenario={r} /> },
          { header: "버전", render: (r) => `v${r.version}` },
          {
            header: "운영 기준",
            render: (r) => (
              <span className={`badge ${r.promotion_status === "prod" ? "green" : "muted"}`}>
                {r.promotion_status === "prod" ? "운영 기준" : "초안"}
              </span>
            ),
          },
          { header: "실행 기준", render: (r) => <span className="badge muted">v{r.version} 준비됨</span> },
          {
            header: "주요 작업",
            render: (r) => (
              <div style={{ display: "inline-flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                <RunScenarioButton scenario={r} />
                <button className="btn" type="button" onClick={() => navigate("playground", { scenario: r.scenario_id })}>
                  미리보기
                </button>
                {can("scenario.update") && (
                  <button
                    className="btn"
                    type="button"
                    onClick={() => setForm({ kind: "edit", scenarioId: r.scenario_id, name: r.name, version: r.version })}
                  >
                    편집
                  </button>
                )}
                <details className="developer-details" style={{ display: "inline-block", minWidth: 120 }}>
                  <summary>관리 작업</summary>
                  <div style={{ display: "inline-flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginTop: 8 }}>
                    <button className="btn" type="button" onClick={() => setVersionsFor(r)}>
                      이력
                    </button>
                    <button className="btn" type="button" onClick={() => setReleasesFor(r)}>
                      배포
                    </button>
                    <ActionButton
                      label={r.promotion_status === "prod" ? "운영 기준 해제" : "운영 기준 지정"}
                      action="scenario.promote"
                      title="운영 기준 지정은 실행 필수 단계가 아니라 운영 표준 버전을 표시하는 보조 작업입니다."
                      confirmText={
                        r.promotion_status === "prod"
                          ? `${r.name} v${r.version}을(를) 운영 기준에서 내릴까요? 실행 이력은 보존됩니다.`
                          : `${r.name} v${r.version}을(를) 운영 기준으로 지정할까요? 실행에 꼭 필요한 단계는 아니며, 자동화 검사 통과와 사이트 승인·세션 준비는 별도로 확인됩니다.`
                      }
                      run={(key) => api.setScenarioPromotion(r.scenario_id, r.version, r.promotion_status === "prod" ? "draft" : "prod", key)}
                      invalidateKeys={[["scenarios"]]}
                      successText={null}
                    />
                    {r.promotion_status !== "prod" && !can("scenario.promote") && (
                      <ActionButton
                        label="운영 기준 승인 요청"
                        action="scenario.update"
                        inputLabel="요청 사유"
                        title="운영 기준 지정을 승인자에게 요청합니다. 요청자와 다른 승인자가 승인해야 적용됩니다."
                        confirmText={`${r.name} v${r.version}을(를) 운영 기준으로 승인 요청할까요? 승인자 검토 후 적용됩니다.`}
                        run={(key, reason) => api.createPromotionRequest(r.scenario_id, r.version, reason ?? "", key)}
                        invalidateKeys={[["promotion-requests"]]}
                        successText="요청됨"
                      />
                    )}
                    <ActionButton
                      label="보관"
                      action="scenario.update"
                      confirmText={`${r.name}을(를) 보관할까요? 목록과 실행 생성 동선에서 제외됩니다.`}
                      run={(key) => api.archiveScenario(r.scenario_id, r.version, key)}
                      invalidateKeys={[["scenarios"]]}
                    />
                  </div>
                </details>
              </div>
            ),
          },
        ]}
      />
      {versionsFor !== null && <ScenarioVersionsPanel scenario={versionsFor} onClose={() => setVersionsFor(null)} />}
      {releasesFor !== null && <ScenarioReleasesPanel scenario={releasesFor} onClose={() => setReleasesFor(null)} />}
    </div>
  );
}

function ManualScenarioCreateDetails(props: { disabled: boolean; onCreate: () => void }): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <details
      className="developer-details"
      open={open}
      style={{ marginBottom: 12 }}
    >
      <summary
        onClick={(event) => {
          event.preventDefault();
          setOpen((current) => !current);
        }}
      >
        양식으로 직접 만들기
      </summary>
      {open && (
        <div style={{ display: "grid", gap: 8, marginTop: 8 }}>
          <p className="subtle" style={{ margin: 0 }}>
            문장으로 초안을 만들 수 없는 예외 상황에서만 직접 입력 양식을 엽니다.
          </p>
          <button className="btn" type="button" onClick={props.onCreate} disabled={props.disabled} style={{ justifySelf: "start" }}>
            + 새 자동화 만들기
          </button>
        </div>
      )}
    </details>
  );
}

function ScenarioNameCell(props: { scenario: ScenarioItem }): JSX.Element {
  return (
    <div style={{ display: "grid", gap: 4 }}>
      <strong>{props.scenario.name}</strong>
      <details className="developer-details" style={{ marginTop: 0 }}>
        <summary>식별값 보기</summary>
        <code className="subtle">{props.scenario.scenario_id}</code>
      </details>
    </div>
  );
}

// approver 운영 기준 인박스(maker-checker, D4) — pending 운영 기준 요청을 승인/반려. 요청자≠승인자는 백엔드가 강제(SoD).
function PromotionInbox(): JSX.Element | null {
  const api = useApiClient();
  const inbox = useQuery({ queryKey: ["promotion-requests"], queryFn: () => api.listPromotionRequests(), refetchInterval: 15_000 });
  if (inbox.isLoading || inbox.data === undefined) return null;
  const items = inbox.data.items;
  return (
    <section
      aria-label="운영 기준 승인 대기"
      style={{ border: "1px solid var(--border, #e2e8f0)", borderRadius: 8, padding: 12, marginBottom: 12 }}
    >
      <h2 style={{ margin: "0 0 4px", fontSize: 16 }}>운영 기준 승인 대기{items.length > 0 ? ` (${items.length})` : ""}</h2>
      <p className="subtle" style={{ margin: "0 0 8px" }}>
        운영자가 요청한 운영 기준 변경입니다. 요청자와 다른 승인자가 승인해야 실제로 적용됩니다.
      </p>
      {items.length === 0 ? (
        <p className="subtle" style={{ margin: 0 }}>대기 중인 운영 기준 요청이 없습니다.</p>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 8 }}>
          {items.map((req) => (
            <li
              key={req.request_id}
              style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}
            >
              <div>
                <strong>{req.scenario_name}</strong> <span className="badge muted">v{req.version}</span>
                <div className="subtle">요청자 {req.requested_by} · 사유: {req.reason}</div>
              </div>
              <span style={{ display: "inline-flex", gap: 6 }}>
                <ActionButton
                  label="승인"
                  action="scenario.promote.approve"
                  confirmText={`${req.scenario_name} v${req.version}을(를) 운영 기준으로 지정할까요? 요청자: ${req.requested_by}`}
                  run={(key) => api.decidePromotionRequest(req.scenario_id, req.request_id, "approve", undefined, key)}
                  invalidateKeys={[["promotion-requests"], ["scenarios"]]}
                  successText="승인됨"
                />
                <ActionButton
                  label="반려"
                  action="scenario.promote.approve"
                  inputLabel="반려 사유(선택)"
                  inputOptional={true}
                  confirmText={`${req.scenario_name} v${req.version} 운영 기준 요청을 반려할까요?`}
                  run={(key, reason) => api.decidePromotionRequest(req.scenario_id, req.request_id, "reject", reason, key)}
                  invalidateKeys={[["promotion-requests"]]}
                  successText="반려됨"
                />
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ScenarioVersionsPanel(props: { scenario: ScenarioItem; onClose: () => void }): JSX.Element {
  const api = useApiClient();
  const query = useQuery({
    queryKey: ["scenario-versions", props.scenario.scenario_id],
    queryFn: () => api.listScenarioVersions(props.scenario.scenario_id),
  });

  return (
    <section style={{ marginTop: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, marginBottom: 8 }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>{props.scenario.name} 버전 이력</h2>
        <button className="btn" type="button" onClick={props.onClose}>닫기</button>
      </div>
      <QueryPanel<ScenarioVersionItem>
        title="버전"
        query={query}
        rowKey={(r) => r.version_id}
        emptyMessage="저장된 버전이 없습니다."
        columns={[
          { header: "버전", render: (r) => `v${r.version}` },
          { header: "운영 인증", render: (r) => <CertificationBadge certification={r.certification} /> },
          { header: "검토 단계", render: (r) => <GovernanceStageBadge certification={r.certification} /> },
          {
            header: "상태",
            render: (r) => (
              <span className={`badge ${r.promotion_status === "prod" ? "green" : "muted"}`}>
                {r.promotion_status === "prod" ? "운영 기준" : "초안"}
              </span>
            ),
          },
          { header: "작성", render: (r) => formatDateTime(r.created_at) },
          { header: "운영 기준 지정", render: (r) => (r.promoted_at !== null ? formatDateTime(r.promoted_at) : "-") },
          {
            header: "작업",
            render: (r) => (
              <span style={{ display: "inline-flex", gap: 6, flexWrap: "wrap" }}>
                <ActionButton
                  label="이 버전으로 복원"
                  action="scenario.update"
                  disabled={r.version === props.scenario.version}
                  confirmText={`${props.scenario.name} v${r.version}을(를) 복제해 새 초안 v${props.scenario.version + 1}을 만들까요?`}
                  run={(key) => api.rollbackScenario(props.scenario.scenario_id, r.version, props.scenario.version, key)}
                  invalidateKeys={[["scenarios"], ["scenario-versions", props.scenario.scenario_id]]}
                />
                <GovernanceStageButton
                  scenario={props.scenario}
                  version={r.version}
                  targetStage="review"
                  currentStage={governanceStage(r.certification)}
                />
                <GovernanceStageButton
                  scenario={props.scenario}
                  version={r.version}
                  targetStage="pilot"
                  currentStage={governanceStage(r.certification)}
                />
                <GovernanceStageButton
                  scenario={props.scenario}
                  version={r.version}
                  targetStage="deprecated"
                  currentStage={governanceStage(r.certification)}
                />
                {r.certification.status !== "certified" && (
                  <ActionButton
                    label="인증"
                    action="scenario.certify"
                    inputLabel="인증 사유"
                    confirmText={`${props.scenario.name} v${r.version}을 운영 인증할까요? 운영 배포 승인은 인증 이후에만 가능합니다.`}
                    run={(key, reason) => api.certifyScenarioVersion(props.scenario.scenario_id, r.version, reason ?? "", null, key)}
                    invalidateKeys={[["scenarios"], ["scenario-versions", props.scenario.scenario_id], ["scenario-releases", props.scenario.scenario_id]]}
                  />
                )}
                {r.certification.status === "certified" && (
                  <ActionButton
                    label="인증 취소"
                    action="scenario.certify"
                    inputLabel="취소 사유"
                    confirmText={`${props.scenario.name} v${r.version}의 운영 인증을 취소할까요? 이후 운영 승인과 배포가 차단됩니다.`}
                    run={(key, reason) => api.revokeScenarioCertification(props.scenario.scenario_id, r.version, reason ?? "", key)}
                    invalidateKeys={[["scenarios"], ["scenario-versions", props.scenario.scenario_id], ["scenario-releases", props.scenario.scenario_id]]}
                  />
                )}
              </span>
            ),
          },
        ]}
      />
    </section>
  );
}

function ScenarioReleasesPanel(props: { scenario: ScenarioItem; onClose: () => void }): JSX.Element {
  const api = useApiClient();
  const [target, setTarget] = useState<ScenarioReleaseTarget>("prod");
  const bindings = useQuery({
    queryKey: ["scenario-bindings", props.scenario.scenario_id],
    queryFn: () => api.listScenarioEnvironmentBindings(props.scenario.scenario_id),
  });
  const releases = useQuery({
    queryKey: ["scenario-releases", props.scenario.scenario_id],
    queryFn: () => api.listScenarioReleases(props.scenario.scenario_id, { limit: 20 }),
  });
  const invalidate = [["scenario-releases", props.scenario.scenario_id], ["scenario-bindings", props.scenario.scenario_id], ["scenarios"]] as const;

  return (
    <section style={{ marginTop: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, marginBottom: 8, flexWrap: "wrap" }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>{props.scenario.name} 릴리스</h2>
        <span style={{ display: "inline-flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <label style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
            <span className="label">대상</span>
            <select value={target} onChange={(event) => setTarget(event.target.value as ScenarioReleaseTarget)}>
              <option value="prod">운영</option>
              <option value="staging">스테이징</option>
            </select>
          </label>
          <ActionButton
            label="릴리스 요청"
            action="scenario_release.submit"
            confirmText={`${props.scenario.name} v${props.scenario.version}을(를) ${environmentLabel(target)} 배포 후보로 만들까요?`}
            run={(key) => api.createScenarioRelease(props.scenario.scenario_id, { source_version: props.scenario.version, target_environment: target, reason: "console release request" }, key)}
            invalidateKeys={invalidate}
          />
          <button className="btn" type="button" onClick={props.onClose}>닫기</button>
        </span>
      </div>
      <QueryPanel<ScenarioEnvironmentBinding>
        title="환경 기준"
        query={bindings}
        rowKey={(r) => r.binding_id}
        emptyMessage="아직 활성화된 환경 기준이 없습니다."
        columns={[
          { header: "환경", render: (r) => <span className={`badge ${r.environment === "prod" ? "green" : "muted"}`}>{environmentLabel(r.environment)}</span> },
          { header: "버전", render: (r) => `v${r.version}` },
          { header: "활성화", render: (r) => formatDateTime(r.activated_at) },
          { header: "처리자", render: (r) => <code className="subtle">{r.activated_by}</code> },
        ]}
      />
      <QueryPanel<ScenarioReleaseItem>
        title="릴리스 이력"
        query={releases}
        rowKey={(r) => r.release_id}
        emptyMessage="릴리스 요청이 없습니다."
        columns={[
          { header: "대상", render: (r) => <span className={`badge ${r.target_environment === "prod" ? "green" : "muted"}`}>{environmentLabel(r.target_environment)}</span> },
          { header: "버전", render: (r) => `v${r.source_version}` },
          { header: "인증", render: (r) => <CertificationBadge certification={r.certification} /> },
          { header: "상태", render: (r) => <span className={`badge ${releaseTone(r.status)}`}>{releaseLabel(r.status)}</span> },
          { header: "요청자", render: (r) => <code className="subtle">{r.requested_by}</code> },
          {
            header: "패키지",
            render: (r) => (
              <details className="developer-details" style={{ marginTop: 0 }}>
                <summary>패키지 식별값 보기</summary>
                <code className="subtle">{r.package_hash}</code>
              </details>
            ),
          },
          {
            header: "작업",
            render: (r) => (
              <span style={{ display: "inline-flex", gap: 6, flexWrap: "wrap" }}>
                {r.status === "draft" && (
                  <ActionButton
                    label="제출"
                    action="scenario_release.submit"
                    confirmText={`v${r.source_version} ${environmentLabel(r.target_environment)} 배포 요청을 제출할까요?`}
                    run={(key) => api.submitScenarioRelease(r.release_id, key)}
                    invalidateKeys={invalidate}
                  />
                )}
                {r.status === "submitted" && (
                  <ActionButton
                    label="승인"
                    action="scenario_release.approve"
                    confirmText={`v${r.source_version} ${environmentLabel(r.target_environment)} 배포 요청을 승인할까요?`}
                    run={(key) => api.approveScenarioRelease(r.release_id, null, key)}
                    invalidateKeys={invalidate}
                  />
                )}
                {r.status === "submitted" && (
                  <ActionButton
                    label="반려"
                    action="scenario_release.approve"
                    confirmText={`v${r.source_version} ${environmentLabel(r.target_environment)} 배포 요청을 반려할까요?`}
                    inputLabel="반려 사유"
                    run={(key, reason) => api.rejectScenarioRelease(r.release_id, reason ?? "", key)}
                    invalidateKeys={invalidate}
                  />
                )}
                {r.status === "approved" && (
                  <ActionButton
                    label="배포"
                    action="scenario_release.deploy"
                    confirmText={`v${r.source_version}을(를) ${environmentLabel(r.target_environment)} 기준으로 배포할까요?`}
                    run={(key) => api.deployScenarioRelease(r.release_id, props.scenario.version, key)}
                    invalidateKeys={invalidate}
                  />
                )}
                {r.status === "deployed" && (
                  <ActionButton
                    label="롤백"
                    action="scenario_release.rollback"
                    confirmText={`${environmentLabel(r.target_environment)} 기준을 직전 배포 버전으로 롤백할까요?`}
                    run={(key) => api.rollbackScenarioRelease(r.release_id, props.scenario.version, key)}
                    invalidateKeys={invalidate}
                  />
                )}
              </span>
            ),
          },
        ]}
      />
    </section>
  );
}

function GovernanceStageBadge(props: { certification?: ScenarioCertification | null }): JSX.Element {
  const stage = governanceStage(props.certification);
  const certification = props.certification;
  const details = [
    certification?.governance_reason ?? null,
    certification?.governance_evidence_ref !== null && certification?.governance_evidence_ref !== undefined
      ? `근거 ${certification.governance_evidence_ref}`
      : null,
    certification?.governance_updated_by !== null && certification?.governance_updated_by !== undefined
      ? `처리자 ${certification.governance_updated_by}`
      : null,
    certification?.governance_updated_at !== null && certification?.governance_updated_at !== undefined
      ? formatDateTime(certification.governance_updated_at)
      : null,
  ].filter((value): value is string => value !== null && value.length > 0);
  return (
    <span className={`badge ${governanceStageTone(stage)}`} title={details.length > 0 ? details.join(" / ") : "운영 검토 단계"}>
      {governanceStageLabel(stage)}
    </span>
  );
}

function GovernanceStageButton(props: {
  scenario: ScenarioItem;
  version: number;
  targetStage: ScenarioGovernanceTransitionStage;
  currentStage: ScenarioGovernanceStage;
}): JSX.Element | null {
  const api = useApiClient();
  const can = useCan();
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState("");
  const [evidenceRef, setEvidenceRef] = useState("");
  const [msg, setMsg] = useState<{ tone: "green" | "red"; text: string } | null>(null);
  const invalidateKeys = [["scenarios"], ["scenario-versions", props.scenario.scenario_id], ["scenario-releases", props.scenario.scenario_id]] as const;
  const targetLabel = governanceStageTransitionLabel(props.targetStage);
  const mut = useMutation({
    mutationFn: (body: { reason: string; evidence_ref: string }) =>
      api.setScenarioVersionGovernanceStage(
        props.scenario.scenario_id,
        props.version,
        { stage: props.targetStage, reason: body.reason, evidence_ref: body.evidence_ref },
        crypto.randomUUID(),
      ),
    onSuccess: () => {
      setMsg({ tone: "green", text: "단계 변경됨" });
      for (const key of invalidateKeys) void qc.invalidateQueries({ queryKey: key });
    },
    onError: (e) => setMsg({ tone: "red", text: errorLabel(e) }),
  });

  if (!can("scenario.update")) return null;

  return (
    <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
      <button
        className="btn"
        type="button"
        title="운영 검토 단계만 변경합니다. 운영 인증과 배포 승인은 별도입니다."
        disabled={props.currentStage === props.targetStage || mut.isPending}
        onClick={() => {
          setReason("");
          setEvidenceRef("");
          setMsg(null);
          setConfirming(true);
        }}
      >
        {mut.isPending ? "변경 중…" : targetLabel}
      </button>
      {msg !== null && <span className={`badge ${msg.tone}`} role={msg.tone === "green" ? "status" : "alert"}>{msg.text}</span>}
      {confirming && (
        <ConfirmDialog
          title={`${props.scenario.name} v${props.version} 운영 검토 단계: ${governanceStageLabel(props.targetStage)}`}
          confirmDisabled={reason.trim() === "" || evidenceRef.trim() === "" || mut.isPending}
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            const body = { reason: reason.trim(), evidence_ref: evidenceRef.trim() };
            setConfirming(false);
            mut.mutate(body);
          }}
        >
          <label style={{ display: "grid", gap: 4 }}>
            <span className="label">변경 사유</span>
            <input value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
          </label>
          <label style={{ display: "grid", gap: 4 }}>
            <span className="label">근거 링크/문서</span>
            <input value={evidenceRef} onChange={(e) => setEvidenceRef(e.target.value)} placeholder="예: 결재 GOV-123 또는 감사 문서 링크" />
          </label>
        </ConfirmDialog>
      )}
    </span>
  );
}

function governanceStage(certification?: ScenarioCertification | null): ScenarioGovernanceStage {
  return certification?.governance_stage ?? (certification?.status === "certified" && certification.valid_for_prod ? "certified" : "dev");
}

function governanceStageLabel(stage: ScenarioGovernanceStage): string {
  const labels: Record<ScenarioGovernanceStage, string> = {
    dev: "초안 검토 전",
    review: "검토 중",
    pilot: "파일럿 운영",
    certified: "운영 인증",
    deprecated: "사용 중단",
  };
  return labels[stage];
}

function governanceStageTransitionLabel(stage: ScenarioGovernanceTransitionStage): string {
  const labels: Record<ScenarioGovernanceTransitionStage, string> = {
    review: "검토로 보내기",
    pilot: "파일럿으로 지정",
    deprecated: "사용 중단 표시",
  };
  return labels[stage];
}

function governanceStageTone(stage: ScenarioGovernanceStage): "green" | "amber" | "red" | "blue" | "muted" {
  if (stage === "certified") return "green";
  if (stage === "pilot") return "amber";
  if (stage === "review") return "blue";
  if (stage === "deprecated") return "red";
  return "muted";
}

function CertificationBadge(props: { certification?: ScenarioCertification | null }): JSX.Element {
  const certification = props.certification;
  if (certification === undefined || certification === null) {
    return <span className="badge amber" title="API 응답에 인증 상태가 없습니다.">인증 미확인</span>;
  }
  if (certification.status === "certified" && certification.valid_for_prod) {
    return (
      <span className="badge green" title={certification.reason ?? "운영 인증됨"}>
        인증됨
      </span>
    );
  }
  if (certification.status === "certified") {
    return (
      <span className="badge amber" title={certification.expires_at !== null ? `만료: ${formatDateTime(certification.expires_at)}` : "운영 인증 유효성 확인 필요"}>
        만료
      </span>
    );
  }
  if (certification.status === "revoked") {
    return <span className="badge red" title={certification.revoke_reason ?? "운영 인증 취소됨"}>취소됨</span>;
  }
  return <span className="badge muted">미인증</span>;
}

function environmentLabel(environment: string): string {
  const labels: Record<string, string> = {
    dev: "개발",
    staging: "스테이징",
    prod: "운영",
  };
  return labels[environment] ?? environment;
}

function releaseLabel(status: string): string {
  const labels: Record<string, string> = {
    draft: "초안",
    submitted: "승인 대기",
    approved: "승인됨",
    rejected: "반려됨",
    deployed: "배포됨",
    rolled_back: "롤백됨",
    cancelled: "취소됨",
  };
  return labels[status] ?? status;
}

function releaseTone(status: string): "green" | "amber" | "red" | "muted" {
  if (status === "deployed" || status === "approved") return "green";
  if (status === "submitted" || status === "draft") return "amber";
  if (status === "rejected") return "red";
  return "muted";
}
