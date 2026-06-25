import type { ConnectorCatalogItem, TemplateCatalogItem } from "../../api/types";

interface NotificationRoutingRow {
  readonly key: string;
  readonly name: string;
  readonly kind: "커넥터" | "템플릿";
  readonly status: ConnectorCatalogItem["status"];
  readonly action: string;
  readonly secretRefCount: number;
}

export function NotificationRoutingReadiness({
  connectors,
  templates,
  isLoading,
  isError,
}: {
  connectors: readonly ConnectorCatalogItem[];
  templates: readonly TemplateCatalogItem[];
  isLoading: boolean;
  isError: boolean;
}): JSX.Element {
  const rows: NotificationRoutingRow[] = [
    ...connectors.map((connector) => ({
      key: `connector-${connector.connector_id}`,
      name: connector.name,
      kind: "커넥터" as const,
      status: connector.status,
      action: connectorActionLabel(connector),
      secretRefCount: connector.required_secret_refs.length,
    })),
    ...templates.map((template) => ({
      key: `template-${template.template_id}`,
      name: template.name,
      kind: "템플릿" as const,
      status: template.status,
      action: templateActionLabel(template),
      secretRefCount: template.required_secret_refs.length,
    })),
  ];

  return (
    <div className="ops-column ops-notification-readiness">
      <div className="ops-alert-center-head">
        <h3>알림 라우팅</h3>
        <span className={`badge ${notificationRoutingTone(rows)}`}>{notificationRoutingBadge(rows, isLoading, isError)}</span>
      </div>
      {isError ? (
        <div className="ops-alert-empty" role="status">
          <strong>알림 라우팅 준비도를 불러오지 못했습니다.</strong>
          <span className="subtle">커넥터/템플릿 카탈로그 조회 권한과 네트워크 상태를 확인하세요.</span>
        </div>
      ) : isLoading ? (
        <div className="ops-alert-empty" role="status">
          <strong>알림 채널을 확인하는 중입니다.</strong>
          <span className="subtle">커넥터와 알림 템플릿 카탈로그를 동기화합니다.</span>
        </div>
      ) : rows.length === 0 ? (
        <div className="ops-alert-empty" role="status">
          <strong>등록된 알림 채널이 없습니다.</strong>
          <span className="subtle">실행 실패, SLA 위험, 사람 작업 에스컬레이션 알림은 커넥터 계약이 필요합니다.</span>
        </div>
      ) : (
        <ul>
          {rows.map((row) => (
            <li key={row.key}>
              <span>
                <strong>{row.name}</strong>
                <span className="subtle">{row.kind} · {row.action}</span>
                {row.secretRefCount > 0 && <span className="subtle">{secretRequirementLabel(row.secretRefCount)}</span>}
              </span>
              <span className={`badge ${catalogStatusTone(row.status)}`}>{catalogStatusLabel(row.status)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function catalogStatusTone(status: ConnectorCatalogItem["status"]): "green" | "blue" | "amber" | "red" {
  if (status === "available") return "green";
  if (status === "candidate") return "blue";
  if (status === "requires_admin") return "amber";
  return "red";
}

function catalogStatusLabel(status: ConnectorCatalogItem["status"]): string {
  if (status === "available") return "사용 가능";
  if (status === "candidate") return "검토 후보";
  if (status === "requires_admin") return "관리자 승인";
  return "차단";
}

function notificationRoutingTone(rows: readonly NotificationRoutingRow[]): "green" | "blue" | "amber" | "red" | "muted" {
  if (rows.length === 0) return "muted";
  if (rows.some((row) => row.status === "blocked")) return "red";
  if (rows.some((row) => row.status === "requires_admin")) return "amber";
  if (rows.some((row) => row.status === "candidate")) return "blue";
  return "green";
}

function notificationRoutingBadge(rows: readonly NotificationRoutingRow[], isLoading: boolean, isError: boolean): string {
  if (isError) return "조회 실패";
  if (isLoading) return "동기화 중";
  if (rows.length === 0) return "계약 필요";
  const adminRequired = rows.filter((row) => row.status === "requires_admin").length;
  if (adminRequired > 0) return `승인 필요 ${adminRequired}건`;
  return `${rows.length}개 경로`;
}

function connectorActionLabel(connector: ConnectorCatalogItem): string {
  if (connector.status === "available") return "알림 발송에 사용할 수 있습니다.";
  if (connector.status === "requires_admin") return "관리자 승인 후 알림 발송에 사용할 수 있습니다.";
  if (connector.status === "blocked") return "외부 발송은 아직 어댑터 계약이 필요합니다.";
  return "도입 후보로 검토 중입니다.";
}

function templateActionLabel(template: TemplateCatalogItem): string {
  if (template.status === "available") return "실패, SLA, 사람 작업 알림에 사용할 수 있습니다.";
  if (template.status === "requires_admin") return "관리자 승인 후 알림 워크플로로 사용할 수 있습니다.";
  if (template.status === "blocked") return "현재는 콘솔 알림 센터 기준으로만 확인합니다.";
  return "알림 워크플로 후보로 검토 중입니다.";
}

function secretRequirementLabel(count: number): string {
  return `보안 연결 ${count}개 필요`;
}
