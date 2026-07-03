import { useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { useApiClient } from "../../api/context";
import { ActionButton } from "../../components/ActionButton";
import { QueryPanel } from "../../components/QueryPanel";
import { formatDateTime } from "../../util/time";
import { CertificationBadge, environmentLabel, releaseLabel, releaseTone } from "./labels";
import type {
  ScenarioEnvironmentBinding,
  ScenarioItem,
  ScenarioReleaseItem,
  ScenarioReleaseTarget,
} from "../../api/types";

export function ScenarioReleasesPanel(props: { scenario: ScenarioItem; onClose: () => void }): JSX.Element {
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
