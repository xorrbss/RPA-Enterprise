import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { useApiClient } from "../api/context";
import { useCan } from "../api/permissions";
import { useListView } from "../api/useListView";
import { QueryPanel } from "../components/QueryPanel";
import { ActionButton } from "../components/ActionButton";
import { BrowserRecorderPanel } from "../components/BrowserRecorderPanel";
import { PromptScenarioGenerator } from "../components/PromptScenarioGenerator";
import { RunScenarioButton } from "../components/RunScenarioButton";
import { ScenarioForm, type ScenarioFormMode } from "../components/ScenarioForm";
import { navigate, useHashParam } from "../router";
import type { ScenarioEnvironmentBinding, ScenarioItem, ScenarioReleaseItem, ScenarioReleaseTarget, ScenarioVersionItem } from "../api/types";

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
  // 'AI로 설명해서 만들기'(자연어 생성기) 펼침 — 기본 진입은 '+ 새 자동화 만들기'(쉬운 만들기), AI 생성기는 접어 둔다.
  // 단 사이트 등록→생성 prefill·Playground 'AI로 만들기' 딥링크로 들어오면 자동 펼침(접힌 채면 prefill이 묻혀 dead-end).
  const prefillSite = useHashParam("site");
  const prefillStartUrl = useHashParam("start_url");
  const prefillBrowser = useHashParam("browser_identity");
  const prefillNetwork = useHashParam("network_policy");
  const prefillCreator = useHashParam("creator");
  const aiDeepLinked =
    prefillSite !== null || prefillStartUrl !== null || prefillBrowser !== null || prefillNetwork !== null || prefillCreator === "ai";
  const [aiOpen, setAiOpen] = useState(aiDeepLinked);
  useEffect(() => {
    if (aiDeepLinked) setAiOpen(true);
  }, [aiDeepLinked]);

  return (
    <div>
      {can("scenario.promote.approve") && <PromotionInbox />}
      {can("scenario.create") && (
        <details className="ai-creator" open={aiOpen} onToggle={(event) => setAiOpen((event.currentTarget as HTMLDetailsElement).open)}>
          <summary>AI로 설명해서 만들기 — 하고 싶은 일을 문장으로 적으면 자동으로 만들어 줍니다</summary>
          <PromptScenarioGenerator />
        </details>
      )}
      {can("scenario.create") && <BrowserRecorderPanel />}
      {can("scenario.create") && (
        <div style={{ marginBottom: 12 }}>
          <button className="btn" type="button" onClick={() => setForm({ kind: "create" })} disabled={form?.kind === "create"}>
            + 새 자동화 만들기
          </button>
        </div>
      )}
      {form !== null && <ScenarioForm mode={form} onClose={() => setForm(null)} />}
      <QueryPanel<ScenarioItem>
        title="자동화 목록"
        query={scenarioList.query}
        pager={scenarioList.pager}
        rowKey={(r) => r.scenario_id}
        emptyMessage="저장된 자동화가 없습니다. ‘새 자동화 만들기’로 시작하세요."
        emptyAction={
          can("scenario.create") ? (
            <button className="btn primary" type="button" onClick={() => setForm({ kind: "create" })} disabled={form?.kind === "create"}>
              + 첫 자동화 만들기
            </button>
          ) : undefined
        }
        columns={[
          { header: "이름", render: (r) => r.name },
          // 식별값(scenario_id) 노출 — 자동화 검사 화면이 "자동화 목록에서 복사한 식별값"을 요구하므로
          // 그 출처를 실제로 보여준다(개발자도구를 열어야 하던 dead-end 해소). code 요소라 선택·복사 가능.
          { header: "식별값", render: (r) => <code className="subtle">{r.scenario_id}</code> },
          { header: "버전", render: (r) => `v${r.version}` },
          {
            header: "운영",
            render: (r) => (
              <span className={`badge ${r.promotion_status === "prod" ? "green" : "muted"}`}>
                {r.promotion_status === "prod" ? "운영 기준" : "초안"}
              </span>
            ),
          },
          { header: "실행 기준", render: (r) => <span className="badge muted">v{r.version} 준비됨</span> },
          {
            header: "작업",
            render: (r) => (
              <span style={{ display: "inline-flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
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
                <button className="btn" type="button" onClick={() => setVersionsFor(r)}>
                  이력
                </button>
                <button className="btn" type="button" onClick={() => setReleasesFor(r)}>
                  릴리스
                </button>
                <ActionButton
                  label={r.promotion_status === "prod" ? "운영 해제" : "운영 지정"}
                  action="scenario.promote"
                  title="운영 지정은 실행에 꼭 필요한 단계가 아니라 운영 기준 표시를 위한 보조 작업입니다."
                  confirmText={
                    r.promotion_status === "prod"
                      ? `${r.name} v${r.version}을(를) 운영 기준에서 내릴까요? 실행 이력은 보존됩니다.`
                      : `${r.name} v${r.version}을(를) 운영 기준으로 지정할까요? 실행에 꼭 필요한 단계는 아니며, 운영 기준 표시를 위한 보조 작업입니다. 자동화 검사를 통과하고 사이트 승인·세션이 준비되어야 실제로 실행됩니다.`
                  }
                  run={(key) => api.setScenarioPromotion(r.scenario_id, r.version, r.promotion_status === "prod" ? "draft" : "prod", key)}
                  invalidateKeys={[["scenarios"]]}
                  successText={null}
                />
                {r.promotion_status !== "prod" && !can("scenario.promote") && (
                  <ActionButton
                    label="승격 요청"
                    action="scenario.update"
                    inputLabel="승격 사유"
                    title="운영(prod) 승격을 승인자에게 요청합니다. 요청자와 다른 승인자가 승인해야 적용됩니다."
                    confirmText={`${r.name} v${r.version}을(를) 운영 기준으로 승격 요청할까요? 승인자 검토 후 적용됩니다.`}
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
              </span>
            ),
          },
        ]}
      />
      {versionsFor !== null && <ScenarioVersionsPanel scenario={versionsFor} onClose={() => setVersionsFor(null)} />}
      {releasesFor !== null && <ScenarioReleasesPanel scenario={releasesFor} onClose={() => setReleasesFor(null)} />}
    </div>
  );
}

// approver 승격 인박스(maker-checker, D4) — pending prod 승격 요청을 승인/반려. 요청자≠승인자는 백엔드가 강제(SoD).
function PromotionInbox(): JSX.Element | null {
  const api = useApiClient();
  const inbox = useQuery({ queryKey: ["promotion-requests"], queryFn: () => api.listPromotionRequests(), refetchInterval: 15_000 });
  if (inbox.isLoading || inbox.data === undefined) return null;
  const items = inbox.data.items;
  return (
    <section
      aria-label="승격 승인 대기"
      style={{ border: "1px solid var(--border, #e2e8f0)", borderRadius: 8, padding: 12, marginBottom: 12 }}
    >
      <h2 style={{ margin: "0 0 4px", fontSize: 16 }}>승격 승인 대기{items.length > 0 ? ` (${items.length})` : ""}</h2>
      <p className="subtle" style={{ margin: "0 0 8px" }}>
        운영자가 요청한 운영(prod) 승격입니다. 요청자와 다른 승인자가 승인해야 실제로 적용됩니다.
      </p>
      {items.length === 0 ? (
        <p className="subtle" style={{ margin: 0 }}>대기 중인 승격 요청이 없습니다.</p>
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
                  confirmText={`${req.scenario_name} v${req.version}을(를) 운영 기준으로 승격할까요? 요청자: ${req.requested_by}`}
                  run={(key) => api.decidePromotionRequest(req.scenario_id, req.request_id, "approve", undefined, key)}
                  invalidateKeys={[["promotion-requests"], ["scenarios"]]}
                  successText="승격됨"
                />
                <ActionButton
                  label="반려"
                  action="scenario.promote.approve"
                  inputLabel="반려 사유(선택)"
                  inputOptional={true}
                  confirmText={`${req.scenario_name} v${req.version} 승격 요청을 반려할까요?`}
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
          {
            header: "상태",
            render: (r) => (
              <span className={`badge ${r.promotion_status === "prod" ? "green" : "muted"}`}>
                {r.promotion_status === "prod" ? "운영 기준" : "초안"}
              </span>
            ),
          },
          { header: "작성", render: (r) => new Date(r.created_at).toLocaleString() },
          { header: "승격", render: (r) => (r.promoted_at !== null ? new Date(r.promoted_at).toLocaleString() : "-") },
          {
            header: "작업",
            render: (r) => (
              <ActionButton
                label="이 버전으로 복원"
                action="scenario.update"
                disabled={r.version === props.scenario.version}
                confirmText={`${props.scenario.name} v${r.version}을(를) 복제해 새 초안 v${props.scenario.version + 1}을 만들까요?`}
                run={(key) => api.rollbackScenario(props.scenario.scenario_id, r.version, props.scenario.version, key)}
                invalidateKeys={[["scenarios"], ["scenario-versions", props.scenario.scenario_id]]}
              />
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
              <option value="prod">prod</option>
              <option value="staging">staging</option>
            </select>
          </label>
          <ActionButton
            label="릴리스 요청"
            action="scenario_release.submit"
            confirmText={`${props.scenario.name} v${props.scenario.version}을(를) ${target} 릴리스 후보로 만들까요?`}
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
          { header: "환경", render: (r) => <span className={`badge ${r.environment === "prod" ? "green" : "muted"}`}>{r.environment}</span> },
          { header: "버전", render: (r) => `v${r.version}` },
          { header: "활성화", render: (r) => new Date(r.activated_at).toLocaleString() },
          { header: "처리자", render: (r) => <code className="subtle">{r.activated_by}</code> },
        ]}
      />
      <QueryPanel<ScenarioReleaseItem>
        title="릴리스 이력"
        query={releases}
        rowKey={(r) => r.release_id}
        emptyMessage="릴리스 요청이 없습니다."
        columns={[
          { header: "대상", render: (r) => <span className={`badge ${r.target_environment === "prod" ? "green" : "muted"}`}>{r.target_environment}</span> },
          { header: "버전", render: (r) => `v${r.source_version}` },
          { header: "상태", render: (r) => <span className={`badge ${releaseTone(r.status)}`}>{releaseLabel(r.status)}</span> },
          { header: "요청자", render: (r) => <code className="subtle">{r.requested_by}</code> },
          { header: "패키지", render: (r) => <code className="subtle">{r.package_hash.slice(0, 18)}…</code> },
          {
            header: "작업",
            render: (r) => (
              <span style={{ display: "inline-flex", gap: 6, flexWrap: "wrap" }}>
                {r.status === "draft" && (
                  <ActionButton
                    label="제출"
                    action="scenario_release.submit"
                    confirmText={`v${r.source_version} ${r.target_environment} 릴리스를 제출할까요?`}
                    run={(key) => api.submitScenarioRelease(r.release_id, key)}
                    invalidateKeys={invalidate}
                  />
                )}
                {r.status === "submitted" && (
                  <ActionButton
                    label="승인"
                    action="scenario_release.approve"
                    confirmText={`v${r.source_version} ${r.target_environment} 릴리스를 승인할까요?`}
                    run={(key) => api.approveScenarioRelease(r.release_id, null, key)}
                    invalidateKeys={invalidate}
                  />
                )}
                {r.status === "submitted" && (
                  <ActionButton
                    label="반려"
                    action="scenario_release.approve"
                    confirmText={`v${r.source_version} ${r.target_environment} 릴리스를 반려할까요?`}
                    inputLabel="반려 사유"
                    run={(key, reason) => api.rejectScenarioRelease(r.release_id, reason ?? "", key)}
                    invalidateKeys={invalidate}
                  />
                )}
                {r.status === "approved" && (
                  <ActionButton
                    label="배포"
                    action="scenario_release.deploy"
                    confirmText={`v${r.source_version}을(를) ${r.target_environment} 기준으로 배포할까요?`}
                    run={(key) => api.deployScenarioRelease(r.release_id, props.scenario.version, key)}
                    invalidateKeys={invalidate}
                  />
                )}
                {r.status === "deployed" && (
                  <ActionButton
                    label="롤백"
                    action="scenario_release.rollback"
                    confirmText={`${r.target_environment} 기준을 직전 배포 버전으로 롤백할까요?`}
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
