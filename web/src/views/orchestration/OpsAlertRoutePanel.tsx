// S4b 저장형 자동 알림 라우팅 관리 — 콘솔을 열지 않아도 조건에 맞는 운영 알림이 웹훅으로 자동 발송되도록
// 테넌트가 직접 경로를 저장/중지/삭제한다. 관리는 ops_alert.deliver(관리자), 조회는 ops_alert.read.
import { useState, type FormEvent } from "react";

import type {
  OpsAlertNotificationRoute,
  OpsAlertNotificationRouteSeverity,
  OpsAlertNotificationRouteSource,
} from "../../api/types";
import { formatDateTime } from "./format";
import { isDnsHost, isSecretRef, parseAllowedHosts } from "./trigger-helpers";

export interface OpsAlertRouteDraft {
  readonly source: OpsAlertNotificationRouteSource | null;
  readonly minSeverity: OpsAlertNotificationRouteSeverity;
  readonly providerAlias: string;
  readonly endpointSecretRef: string;
  readonly callbackSignatureSecretRef: string | null;
  readonly routePolicyRef: string;
  readonly recipientGroupRef: string | null;
  readonly allowedHosts: readonly string[];
}

const ROUTE_SOURCE_OPTIONS: readonly { readonly value: OpsAlertNotificationRouteSource | ""; readonly label: string }[] = [
  { value: "", label: "전체 유형" },
  { value: "run_sla", label: "실행 SLA" },
  { value: "human_task_sla", label: "사람 작업 SLA" },
  { value: "trigger_fire", label: "트리거 발화" },
  { value: "failure_spike", label: "실패 급증" },
  { value: "session_expiry", label: "로그인 세션 만료" },
];

export function routeSourceLabel(source: OpsAlertNotificationRouteSource | null): string {
  return ROUTE_SOURCE_OPTIONS.find((option) => option.value === (source ?? ""))?.label ?? "전체 유형";
}

export function routeSeverityLabel(minSeverity: OpsAlertNotificationRouteSeverity): string {
  return minSeverity === "critical" ? "위험만" : "주의 이상";
}

export function OpsAlertRoutePanel({
  routes,
  isLoading,
  isError,
  canManage,
  isCreating,
  createError,
  onCreate,
  togglingRouteId,
  toggleErrorRouteId,
  onToggle,
  deletingRouteId,
  deleteErrorRouteId,
  onDelete,
}: {
  routes: readonly OpsAlertNotificationRoute[];
  isLoading: boolean;
  isError: boolean;
  canManage: boolean;
  isCreating: boolean;
  createError: boolean;
  onCreate: (draft: OpsAlertRouteDraft) => void;
  togglingRouteId: string | null;
  toggleErrorRouteId: string | null;
  onToggle: (route: OpsAlertNotificationRoute) => void;
  deletingRouteId: string | null;
  deleteErrorRouteId: string | null;
  onDelete: (route: OpsAlertNotificationRoute) => void;
}): JSX.Element {
  const enabledCount = routes.filter((route) => route.enabled).length;
  return (
    <div className="ops-column ops-alert-route-panel">
      <div className="ops-alert-center-head">
        <h3>자동 알림 경로</h3>
        <span className={`badge ${enabledCount > 0 ? "green" : "muted"}`}>
          {isLoading ? "동기화 중" : enabledCount > 0 ? `자동 발송 ${enabledCount}건` : "자동 발송 꺼짐"}
        </span>
      </div>
      <p className="subtle">
        콘솔을 열지 않아도 조건에 맞는 운영 알림이 저장된 경로의 웹훅으로 자동 발송됩니다. 발송 결과는 알림 센터의 전달 증빙에서 확인합니다.
      </p>
      {isError ? (
        <div className="ops-alert-empty" role="status">
          <strong>자동 알림 경로를 불러오지 못했습니다.</strong>
          <span className="subtle">알림 API와 콘솔 네트워크 상태를 확인하세요.</span>
        </div>
      ) : routes.length === 0 && !isLoading ? (
        <div className="ops-alert-empty" role="status">
          <strong>저장된 자동 알림 경로가 없습니다.</strong>
          <span className="subtle">경로를 추가하기 전에는 알림 센터에서 건별 웹훅 발송만 가능합니다.</span>
        </div>
      ) : (
        <ul className="ops-alert-list">
          {routes.map((route) => (
            <li key={route.route_id}>
              <div className="ops-alert-main">
                <div className="ops-alert-badges">
                  <span className={`badge ${route.enabled ? "green" : "muted"}`}>{route.enabled ? "자동 발송 중" : "중지됨"}</span>
                  <span className="subtle">{routeSourceLabel(route.source)} · {routeSeverityLabel(route.min_severity)}</span>
                </div>
                <strong>{route.provider_alias}</strong>
                <span className="subtle">보안 연결 {route.endpoint_secret_ref}</span>
                <span className="subtle">허용 호스트 {route.allowed_hosts.join(", ")}</span>
                {route.recipient_group_ref !== null && <span className="subtle">수신 그룹 {route.recipient_group_ref}</span>}
                <span className="subtle">최근 변경 {formatDateTime(route.updated_at)} · {route.updated_by}</span>
              </div>
              {canManage && (
                <div className="inline-actions">
                  <button
                    className="btn"
                    type="button"
                    disabled={togglingRouteId === route.route_id}
                    onClick={() => onToggle(route)}
                  >
                    {togglingRouteId === route.route_id ? "변경 중" : route.enabled ? "중지" : "다시 사용"}
                  </button>
                  <button
                    className="linklike"
                    type="button"
                    disabled={deletingRouteId === route.route_id}
                    onClick={() => onDelete(route)}
                  >
                    {deletingRouteId === route.route_id ? "삭제 중" : "삭제"}
                  </button>
                  {toggleErrorRouteId === route.route_id && (
                    <span className="form-alert red" role="alert">상태 변경 실패</span>
                  )}
                  {deleteErrorRouteId === route.route_id && (
                    <span className="form-alert red" role="alert">삭제 실패</span>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {canManage && (
        <details className="ops-alert-route-create">
          <summary>새 자동 알림 경로 추가</summary>
          <RouteCreateForm isCreating={isCreating} hasError={createError} onCreate={onCreate} />
        </details>
      )}
    </div>
  );
}

function RouteCreateForm({
  isCreating,
  hasError,
  onCreate,
}: {
  isCreating: boolean;
  hasError: boolean;
  onCreate: (draft: OpsAlertRouteDraft) => void;
}): JSX.Element {
  const [source, setSource] = useState<OpsAlertNotificationRouteSource | "">("");
  const [minSeverity, setMinSeverity] = useState<OpsAlertNotificationRouteSeverity>("critical");
  const [providerAlias, setProviderAlias] = useState("webhook-primary");
  const [endpointSecretRef, setEndpointSecretRef] = useState("");
  const [callbackSignatureSecretRef, setCallbackSignatureSecretRef] = useState("");
  const [routePolicyRef, setRoutePolicyRef] = useState("ops-alerts-primary");
  const [recipientGroupRef, setRecipientGroupRef] = useState("");
  const [allowedHosts, setAllowedHosts] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const endpoint = endpointSecretRef.trim();
    const callbackRef = callbackSignatureSecretRef.trim();
    const provider = providerAlias.trim();
    const routePolicy = routePolicyRef.trim();
    const hosts = parseAllowedHosts(allowedHosts);
    if (provider.length === 0) {
      setValidationError("제공자 별칭을 입력하세요.");
      return;
    }
    if (!isSecretRef(endpoint)) {
      setValidationError("발송 주소는 secret:// 보안 연결로만 입력하세요.");
      return;
    }
    if (callbackRef.length > 0 && !isSecretRef(callbackRef)) {
      setValidationError("회신 서명 키도 secret:// 보안 연결로만 입력하세요.");
      return;
    }
    if (routePolicy.length === 0) {
      setValidationError("라우팅 정책 이름을 입력하세요.");
      return;
    }
    if (hosts.length === 0) {
      setValidationError("허용 호스트를 하나 이상 입력하세요.");
      return;
    }
    if (hosts.some((host) => !isDnsHost(host))) {
      setValidationError("허용 호스트는 DNS 호스트명만 입력하세요.");
      return;
    }
    setValidationError(null);
    onCreate({
      source: source === "" ? null : source,
      minSeverity,
      providerAlias: provider,
      endpointSecretRef: endpoint,
      callbackSignatureSecretRef: callbackRef === "" ? null : callbackRef,
      routePolicyRef: routePolicy,
      recipientGroupRef: recipientGroupRef.trim() === "" ? null : recipientGroupRef.trim(),
      allowedHosts: hosts,
    });
  }

  return (
    <form className="ops-webhook-form" onSubmit={submit}>
      <div className="form-grid ops-webhook-grid">
        <label className="field">
          알림 유형
          <select aria-label="자동 발송 알림 유형" value={source} onChange={(event) => setSource(event.target.value as OpsAlertNotificationRouteSource | "")}>
            {ROUTE_SOURCE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
        <label className="field">
          발송 기준
          <select aria-label="자동 발송 최소 심각도" value={minSeverity} onChange={(event) => setMinSeverity(event.target.value as OpsAlertNotificationRouteSeverity)}>
            <option value="critical">위험만</option>
            <option value="warning">주의 이상</option>
          </select>
        </label>
        <label className="field">
          제공자 별칭
          <input
            aria-label="자동 발송 제공자 별칭"
            value={providerAlias}
            onChange={(event) => setProviderAlias(event.target.value)}
            placeholder="webhook-primary"
          />
        </label>
        <label className="field">
          발송 주소 보안 연결
          <input
            aria-label="자동 발송 Endpoint SecretRef"
            value={endpointSecretRef}
            onChange={(event) => setEndpointSecretRef(event.target.value)}
            placeholder="secret://rpa/prod/notification-sender/notification/webhook/ops-primary"
          />
        </label>
        <label className="field">
          허용 호스트
          <input
            aria-label="자동 발송 허용 호스트"
            value={allowedHosts}
            onChange={(event) => setAllowedHosts(event.target.value)}
            placeholder="hooks.example.com"
          />
        </label>
        <label className="field">
          라우팅 정책 이름
          <input
            aria-label="자동 발송 라우팅 정책"
            value={routePolicyRef}
            onChange={(event) => setRoutePolicyRef(event.target.value)}
            placeholder="ops-alerts-primary"
          />
        </label>
        <label className="field">
          수신 그룹 (선택)
          <input
            aria-label="자동 발송 수신 그룹"
            value={recipientGroupRef}
            onChange={(event) => setRecipientGroupRef(event.target.value)}
            placeholder="ops-primary-oncall"
          />
        </label>
        <label className="field">
          회신 서명 키 (선택)
          <input
            aria-label="자동 발송 회신 서명 SecretRef"
            value={callbackSignatureSecretRef}
            onChange={(event) => setCallbackSignatureSecretRef(event.target.value)}
            placeholder="secret://rpa/prod/notification-sender/signing/webhook-callback"
          />
        </label>
      </div>
      <div className="inline-actions">
        <button className="btn" type="submit" disabled={isCreating}>
          {isCreating ? "저장 중" : "경로 저장"}
        </button>
        {validationError !== null && <span className="form-alert red" role="alert">{validationError}</span>}
        {hasError && <span className="form-alert red" role="alert">경로 저장 실패</span>}
      </div>
    </form>
  );
}
