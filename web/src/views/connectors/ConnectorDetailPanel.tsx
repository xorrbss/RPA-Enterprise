import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";

import { useApiClient } from "../../api/context";
import type { ConnectorCatalogItem } from "../../api/types";
import {
  KIND_LABEL,
  STATUS_LABEL,
  actionsLabel,
  envLabel,
  implementationLabel,
  listLabel,
  priorityLabel,
  priorityTone,
  profileStatusLabel,
  profileStatusTone,
  secretRefs,
  securityNoteLabel,
  splitMetadataLines,
  statusTone,
} from "./catalog-labels";

export function ConnectorDetailPanel({ connector: selectedConnector }: { connector: ConnectorCatalogItem | null }): JSX.Element {
  const api = useApiClient();
  const [profileName, setProfileName] = useState("");
  const [profileSecretRefs, setProfileSecretRefs] = useState("");
  const [profileAllowedHosts, setProfileAllowedHosts] = useState("");
  const [profileOwnerRef, setProfileOwnerRef] = useState("");
  const [profileSupportOwnerRef, setProfileSupportOwnerRef] = useState("");

  const profileQuery = useQuery({
    queryKey: ["connector-profiles", selectedConnector?.connector_id ?? null],
    queryFn: () =>
      api.listConnectorProfiles({
        limit: 20,
        ...(selectedConnector !== null ? { connector_id: selectedConnector.connector_id } : {}),
      }),
    enabled: selectedConnector !== null,
  });

  const selectedProfiles = useMemo(
    () => (profileQuery.data?.items ?? []).filter((item) => selectedConnector !== null && item.connector_id === selectedConnector.connector_id),
    [profileQuery.data?.items, selectedConnector],
  );
  const selectedConnectorCanCreateProfile = selectedConnector?.status === "available" || selectedConnector?.status === "requires_admin";

  const createProfileMutation = useMutation({
    mutationFn: () => {
      if (selectedConnector === null) throw new Error("connector not selected");
      return api.createConnectorProfile(
        {
          connector_id: selectedConnector.connector_id,
          profile_name: profileName.trim(),
          environment: "staging",
          secret_refs: splitMetadataLines(profileSecretRefs),
          allowed_hosts: splitMetadataLines(profileAllowedHosts),
          owner_ref: profileOwnerRef.trim(),
          support_owner_ref: profileSupportOwnerRef.trim() || null,
          metadata: { source: "connector_catalog_setup" },
        },
        crypto.randomUUID(),
      );
    },
    onSuccess: () => {
      setProfileName("");
      setProfileSecretRefs("");
      setProfileAllowedHosts("");
      setProfileOwnerRef("");
      setProfileSupportOwnerRef("");
      void profileQuery.refetch();
    },
  });

  return (
    <section className="panel catalog-detail" aria-label="선택한 커넥터 상세">
      <div className="panel-head">
        <h2>상세</h2>
        {selectedConnector !== null && <span className={`badge ${statusTone(selectedConnector.status)}`}>{STATUS_LABEL[selectedConnector.status]}</span>}
      </div>
      {selectedConnector === null ? (
        <p className="empty-state">커넥터를 선택하세요.</p>
      ) : (
        <div className="catalog-detail-body">
          <div>
            <h3>{selectedConnector.name}</h3>
            <p>{selectedConnector.summary}</p>
            <div className="inline-facts">
              <span className="badge blue">{KIND_LABEL[selectedConnector.kind]}</span>
              <span className="badge muted">{implementationLabel(selectedConnector.implementation_state)}</span>
              <span className={`badge ${priorityTone(selectedConnector.priority)}`}>{priorityLabel(selectedConnector.priority)}</span>
            </div>
          </div>
          <dl className="catalog-facts">
            <div>
              <dt>적합 업무</dt>
              <dd>{listLabel(selectedConnector.best_for)}</dd>
            </div>
            <div>
              <dt>지원 동작</dt>
              <dd>{actionsLabel(selectedConnector.supported_actions)}</dd>
            </div>
            <div>
              <dt>접속 허용 범위</dt>
              <dd>{listLabel(selectedConnector.allowed_domains)}</dd>
            </div>
            <div>
              <dt>필요 보안 연결</dt>
              <dd className="catalog-ref-list">{secretRefs(selectedConnector.required_secret_refs)}</dd>
            </div>
          </dl>
          <div className="catalog-permissions" aria-label="커넥터 권한 요약">
            <span className="badge amber">필요 권한 {selectedConnector.manifest_permissions.api.length}개</span>
            <span className="badge muted">{selectedConnector.manifest_permissions.network ? "네트워크 허용" : "네트워크 차단"}</span>
            <span className="badge blue">보안 연결 {selectedConnector.manifest_permissions.secret_refs.length}개</span>
          </div>
          <ul className="catalog-notes">
            {selectedConnector.security_notes.map((note) => (
              <li key={note}>{securityNoteLabel(note)}</li>
            ))}
          </ul>
          <div className="connector-profile-ledger" aria-label="커넥터 프로파일 원장">
            <div className="panel-head">
              <h3>프로파일 원장</h3>
              <button className="btn" type="button" onClick={() => void profileQuery.refetch()} disabled={profileQuery.isFetching}>
                새로고침
              </button>
            </div>
            {profileQuery.isLoading ? (
              <p className="subtle">불러오는 중</p>
            ) : selectedProfiles.length === 0 ? (
              <p className="subtle">등록된 프로파일 없음</p>
            ) : (
              <ul className="connector-profile-list">
                {selectedProfiles.map((profile) => (
                  <li key={profile.profile_id}>
                    <div>
                      <strong>{profile.profile_name}</strong>
                      <span className="subtle">{profile.owner_ref}</span>
                    </div>
                    <div className="inline-facts">
                      <span className={`badge ${profileStatusTone(profile.status)}`}>{profileStatusLabel(profile.status)}</span>
                      <span className="badge muted">{envLabel(profile.environment)}</span>
                      <span className="badge blue">보안 연결 {profile.secret_refs.length}개</span>
                      <span className="badge muted">호스트 {profile.allowed_hosts.length}개</span>
                    </div>
                    {profile.latest_certification !== null && (
                      <span className="subtle">
                        인증 증거: {profile.latest_certification.security_review_ref ?? profile.latest_certification.manifest_ref ?? profile.latest_certification.reason}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {selectedConnectorCanCreateProfile ? (
              <form
                className="connector-profile-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  createProfileMutation.mutate();
                }}
              >
                <label>
                  <span>프로파일 이름</span>
                  <input value={profileName} onChange={(event) => setProfileName(event.target.value)} placeholder={`${selectedConnector.name} 스테이징`} />
                </label>
                <label>
                  <span>보안 연결(SecretRef)</span>
                  <textarea value={profileSecretRefs} onChange={(event) => setProfileSecretRefs(event.target.value)} rows={2} placeholder="secret://tenant/connector/name/key" />
                </label>
                <label>
                  <span>허용 호스트</span>
                  <textarea value={profileAllowedHosts} onChange={(event) => setProfileAllowedHosts(event.target.value)} rows={2} placeholder="api.vendor.example" />
                </label>
                <label>
                  <span>업무 담당자</span>
                  <input value={profileOwnerRef} onChange={(event) => setProfileOwnerRef(event.target.value)} placeholder="team:business-owner" />
                </label>
                <label>
                  <span>지원 담당자</span>
                  <input value={profileSupportOwnerRef} onChange={(event) => setProfileSupportOwnerRef(event.target.value)} placeholder="team:rpa-ops" />
                </label>
                <button
                  className="btn primary"
                  type="submit"
                  disabled={profileName.trim() === "" || profileOwnerRef.trim() === "" || createProfileMutation.isPending}
                >
                  {createProfileMutation.isPending ? "저장 중" : "프로파일 저장"}
                </button>
                {createProfileMutation.isError && <span className="error-text">프로파일 저장 실패</span>}
              </form>
            ) : (
              <p className="subtle">후보 또는 차단 상태는 프로파일 생성 없이 검토용으로만 표시됩니다.</p>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
