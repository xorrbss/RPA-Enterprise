import { useQuery } from "@tanstack/react-query";

import { useApiClient } from "../../api/context";
import type { AuthReadiness } from "../../api/types";
import { ReadinessMetric } from "./shared";

export function AuthReadinessPanel(): JSX.Element {
  const api = useApiClient();
  const query = useQuery({
    queryKey: ["auth-readiness"],
    queryFn: () => api.getAuthReadiness(),
    refetchInterval: 60_000,
  });

  return (
    <section className="panel" aria-label="SSO/IdP 준비도" style={{ marginBottom: 12 }}>
      <div className="panel-head">
        <h2>SSO/IdP 준비도</h2>
        {query.data !== undefined && (
          <span className={`badge ${authReadinessTone(query.data)}`}>
            {query.data.enterprise_sso_ready ? "운영 SSO 준비됨" : "보강 필요"}
          </span>
        )}
      </div>
      {query.isLoading ? (
        <p className="subtle">인증 설정을 확인하는 중입니다.</p>
      ) : query.isError ? (
        <p className="form-alert red" role="alert">인증 준비도를 불러오지 못했습니다.</p>
      ) : query.data !== undefined ? (
        <div className="auth-readiness">
          <div className="summary-grid">
            <ReadinessMetric label="서명 검증" value={providerModeLabel(query.data)} tone={query.data.provider.mode === "jwks" ? "green" : "amber"} />
            <ReadinessMetric label="발급자 검증" value={configuredLabel(query.data.provider.issuer_configured)} tone={query.data.provider.issuer_configured ? "green" : "amber"} />
            <ReadinessMetric label="대상 검증" value={configuredLabel(query.data.provider.audience_configured)} tone={query.data.provider.audience_configured ? "green" : "amber"} />
            <ReadinessMetric label="현재 역할" value={query.data.current_principal.roles.join(", ") || "역할 없음"} tone="blue" />
            <ReadinessMetric label="역할 매핑" value={roleMappingLabel(query.data)} tone={query.data.role_mapping.configured ? "green" : "blue"} />
          </div>

          {query.data.operational_gaps.length > 0 && (
            <ul className="notice-list" aria-label="SSO 보강 항목">
              {query.data.operational_gaps.map((gap) => <li key={gap}>{gap}</li>)}
            </ul>
          )}

          <div className="table-wrap">
            <table className="ops-table">
              <thead>
                <tr>
                  <th scope="col">필수 매핑</th>
                  <th scope="col">JWT 클레임</th>
                  <th scope="col">상태</th>
                  <th scope="col">사용 위치</th>
                </tr>
              </thead>
              <tbody>
                {query.data.required_claims.filter((claim) => claim.required).map((claim) => (
                  <tr key={claim.claim}>
                    <th scope="row">{claim.label}</th>
                    <td><code>{claim.claim}</code></td>
                    <td><span className={`badge ${claim.present ? "green" : "red"}`}>{claim.present ? "확인됨" : "누락"}</span></td>
                    <td>{claim.mapped_to}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <details className="audit-technical-details">
            <summary>인증 설정 세부 정보 보기</summary>
            <dl>
              <dt>JWKS 호스트</dt>
              <dd>{query.data.provider.jwks_host ?? "미설정"}</dd>
              <dt>Issuer</dt>
              <dd>{query.data.provider.issuer ?? "미설정"}</dd>
              <dt>Audience</dt>
              <dd>{query.data.provider.audience ?? "미설정"}</dd>
              <dt>현재 처리자</dt>
              <dd>{query.data.current_principal.display_name ?? query.data.current_principal.subject_id}</dd>
            </dl>
          </details>
        </div>
      ) : null}
    </section>
  );
}

function authReadinessTone(readiness: AuthReadiness): "green" | "amber" | "red" {
  if (readiness.status === "ok") return "green";
  if (readiness.status === "blocked") return "red";
  return "amber";
}

function providerModeLabel(readiness: AuthReadiness): string {
  if (readiness.provider.mode === "jwks") return "RS256 / JWKS";
  return "HS256 공유키";
}

function configuredLabel(configured: boolean): string {
  return configured ? "검증 중" : "미설정";
}

function roleMappingLabel(readiness: AuthReadiness): string {
  return readiness.role_mapping.configured ? `${readiness.role_mapping.mapped_values}개 적용` : "기본 역할명";
}
