import { useQuery } from "@tanstack/react-query";

import { useApiClient } from "../../api/context";
import { ActionButton } from "../../components/ActionButton";
import { QueryPanel } from "../../components/QueryPanel";
import { formatDateTime } from "../../util/time";
import { GovernanceStageBadge, GovernanceStageButton, governanceStage } from "./governance";
import { CertificationBadge } from "./labels";
import type { ScenarioItem, ScenarioVersionItem } from "../../api/types";

export function ScenarioVersionsPanel(props: { scenario: ScenarioItem; onClose: () => void }): JSX.Element {
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
