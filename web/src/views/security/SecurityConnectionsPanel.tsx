import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { useApiClient } from "../../api/context";
import type { ConnectorCatalogItem, RunTriggerItem, TemplateCatalogItem } from "../../api/types";

type SecurityConnectionStatus = "required" | "in_use";

interface SecurityConnectionSummary {
  readonly key: string;
  readonly label: string;
  readonly purpose: string;
  readonly status: SecurityConnectionStatus;
  readonly sources: readonly string[];
  readonly technicalRefs: readonly string[];
}

export function SecurityConnectionsPanel(): JSX.Element {
  const api = useApiClient();
  const connectors = useQuery({ queryKey: ["security-connections", "connectors"], queryFn: () => api.listConnectors({ limit: 100 }), refetchInterval: 60_000 });
  const templates = useQuery({ queryKey: ["security-connections", "templates"], queryFn: () => api.listTemplates({ limit: 100 }), refetchInterval: 60_000 });
  const triggers = useQuery({ queryKey: ["security-connections", "run-triggers"], queryFn: () => api.listRunTriggers({ limit: 100 }), refetchInterval: 60_000 });
  const connections = useMemo(
    () => collectSecurityConnections(connectors.data?.items ?? [], templates.data?.items ?? [], triggers.data?.items ?? []),
    [connectors.data?.items, templates.data?.items, triggers.data?.items],
  );
  const hasMoreConnections =
    (connectors.data?.next_cursor ?? null) !== null ||
    (templates.data?.next_cursor ?? null) !== null ||
    (triggers.data?.next_cursor ?? null) !== null;
  const isLoading = connectors.isLoading || templates.isLoading || triggers.isLoading;
  const isError = connectors.isError || templates.isError || triggers.isError;

  return (
    <section className="panel" aria-label="보안 연결 사용 현황" style={{ marginBottom: 12 }}>
      <div className="panel-head">
        <h2>보안 연결 사용 현황</h2>
        <span className="badge blue">{connections.length}{hasMoreConnections ? "+" : ""}개 연결</span>
      </div>
      {hasMoreConnections && <p className="subtle security-connection-state">현재 로드된 100건 단위 목록 기준입니다.</p>}
      {isLoading ? (
        <p className="subtle security-connection-state">보안 연결 참조를 확인하는 중입니다.</p>
      ) : isError ? (
        <p className="form-alert red" role="alert">보안 연결 사용 현황을 불러오지 못했습니다.</p>
      ) : connections.length === 0 ? (
        <p className="empty-state">등록된 보안 연결 참조가 없습니다.</p>
      ) : (
        <div className="table-wrap">
          <table className="ops-table">
            <thead>
              <tr>
                <th scope="col">연결</th>
                <th scope="col">용도</th>
                <th scope="col">상태</th>
                <th scope="col">사용처</th>
              </tr>
            </thead>
            <tbody>
              {connections.map((connection) => (
                <tr key={connection.key}>
                  <th scope="row">{connection.label}</th>
                  <td>{connection.purpose}</td>
                  <td>
                    <span className={`badge ${connection.status === "in_use" ? "green" : "amber"}`}>
                      {connection.status === "in_use" ? "운영 사용 중" : "템플릿 요구"}
                    </span>
                  </td>
                  <td>
                    <span>{connection.sources.join(", ")}</span>
                    <details className="audit-technical-details">
                      <summary>참조 세부 정보 보기</summary>
                      <ul>
                        {connection.technicalRefs.map((ref) => <li key={ref}><code>{ref}</code></li>)}
                      </ul>
                    </details>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function collectSecurityConnections(
  connectors: readonly ConnectorCatalogItem[],
  templates: readonly TemplateCatalogItem[],
  triggers: readonly RunTriggerItem[],
): SecurityConnectionSummary[] {
  const map = new Map<string, {
    label: string;
    purpose: string;
    status: SecurityConnectionStatus;
    sources: Set<string>;
    technicalRefs: Set<string>;
  }>();

  function add(ref: string, source: string, status: SecurityConnectionStatus): void {
    const normalized = normalizeSecretRef(ref);
    const existing = map.get(normalized);
    if (existing === undefined) {
      map.set(normalized, {
        label: securityConnectionLabel(normalized),
        purpose: securityConnectionPurpose(normalized),
        status,
        sources: new Set([source]),
        technicalRefs: new Set([ref]),
      });
      return;
    }
    existing.sources.add(source);
    existing.technicalRefs.add(ref);
    if (status === "in_use") existing.status = "in_use";
  }

  for (const connector of connectors) {
    for (const ref of connector.required_secret_refs) add(ref, `커넥터 ${connector.name}`, "required");
    for (const ref of connector.manifest_permissions.secret_refs) add(ref, `커넥터 ${connector.name}`, "required");
  }
  for (const template of templates) {
    for (const ref of template.required_secret_refs) add(ref, `템플릿 ${template.name}`, "required");
  }
  for (const trigger of triggers) {
    if (trigger.webhook_secret_ref !== null) add(trigger.webhook_secret_ref, `외부 이벤트 ${trigger.trigger_id.slice(0, 8)}`, "in_use");
  }

  return [...map.entries()]
    .map(([key, value]) => ({
      key,
      label: value.label,
      purpose: value.purpose,
      status: value.status,
      sources: [...value.sources].sort(),
      technicalRefs: [...value.technicalRefs].sort(),
    }))
    .sort((a, b) => statusRank(a.status) - statusRank(b.status) || a.label.localeCompare(b.label, "ko-KR"));
}

function normalizeSecretRef(ref: string): string {
  return ref.trim().replace(/^secret:\/\//, "").replace(/\/+$/g, "");
}

function securityConnectionLabel(ref: string): string {
  const parts = ref.split("/").filter((part) => part.length > 0 && part !== "*");
  if (parts.includes("run-triggers")) return "외부 이벤트 서명 키";
  const siteIndex = parts.indexOf("sites");
  const sitePart = siteIndex >= 0 ? parts[siteIndex + 1] : undefined;
  if (sitePart !== undefined) return `${humanizeRefPart(sitePart)} 로그인 세션`;
  const connectorIndex = parts.indexOf("connectors");
  const connectorPart = connectorIndex >= 0 ? parts[connectorIndex + 1] : undefined;
  if (connectorPart !== undefined) return `${humanizeRefPart(connectorPart)} 보안 연결`;
  const last = parts[parts.length - 1];
  return last !== undefined ? `${humanizeRefPart(last)} 보안 연결` : "보안 연결";
}

function securityConnectionPurpose(ref: string): string {
  if (ref.includes("run-triggers") || ref.includes("webhook")) return "외부 이벤트 서명 검증";
  if (ref.includes("sites") || ref.includes("session")) return "브라우저 로그인 세션";
  if (ref.includes("connectors")) return "커넥터 인증";
  return "자동화 보안 연결";
}

function humanizeRefPart(part: string): string {
  const acronyms = new Set(["api", "erp", "http", "idp", "ocr", "sap", "sso"]);
  return part
    .split(/[-_]+/g)
    .filter((word) => word.length > 0)
    .map((word) => acronyms.has(word.toLowerCase()) ? word.toUpperCase() : `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`)
    .join(" ");
}

function statusRank(status: SecurityConnectionStatus): number {
  return status === "in_use" ? 0 : 1;
}
