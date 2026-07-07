import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { useApiClient } from "../api/context";
import type {
  CatalogStatus,
  ConnectorCatalogKind,
  ConnectorCatalogItem,
  TemplateCatalogItem,
  TemplateCatalogKind,
} from "../api/types";
import { ErrorState, Loading } from "../components/states";
import { navigate } from "../router";
import { ConnectorDetailPanel } from "./connectors/ConnectorDetailPanel";
import {
  CONNECTOR_KIND_OPTIONS,
  KIND_LABEL,
  STATUS_LABEL,
  STATUS_OPTIONS,
  TEMPLATE_KIND_LABEL,
  TEMPLATE_KIND_OPTIONS,
  appendUniqueConnectors,
  appendUniqueTemplates,
  categoryLabel,
  connectorStartUrl,
  defaultTemplateParams,
  irPatternLabel,
  paramsLabel,
  priorityLabel,
  priorityTone,
  rbacActionsLabel,
  secretRefs,
  statusTone,
  templateDraftBlocker,
  templateDraftButtonLabel,
  templateDraftNote,
  templatePrompt,
} from "./connectors/catalog-labels";

export function ConnectorCatalogView(): JSX.Element {
  const api = useApiClient();
  const [connectorKind, setConnectorKind] = useState<"all" | ConnectorCatalogKind>("all");
  const [connectorStatus, setConnectorStatus] = useState<"all" | CatalogStatus>("all");
  const [templateKind, setTemplateKind] = useState<"all" | TemplateCatalogKind>("all");
  const [templateStatus, setTemplateStatus] = useState<"all" | CatalogStatus>("all");
  const [selectedConnectorId, setSelectedConnectorId] = useState<string | null>(null);
  const [connectorCursor, setConnectorCursor] = useState<string | null>(null);
  const [nextConnectorCursor, setNextConnectorCursor] = useState<string | null>(null);
  const [connectorItems, setConnectorItems] = useState<ConnectorCatalogItem[]>([]);
  const [templateCursor, setTemplateCursor] = useState<string | null>(null);
  const [nextTemplateCursor, setNextTemplateCursor] = useState<string | null>(null);
  const [templateItems, setTemplateItems] = useState<TemplateCatalogItem[]>([]);

  const connectorParams = useMemo(
    () => ({
      limit: 50,
      ...(connectorCursor !== null ? { cursor: connectorCursor } : {}),
      ...(connectorKind !== "all" ? { kind: connectorKind } : {}),
      ...(connectorStatus !== "all" ? { status: connectorStatus } : {}),
    }),
    [connectorCursor, connectorKind, connectorStatus],
  );

  const connectorQuery = useQuery({
    queryKey: ["connector-catalog", connectorParams],
    queryFn: () => api.listConnectors(connectorParams),
  });

  const connectors = connectorItems;
  const selectedConnector = useMemo(
    () => connectors.find((item) => item.connector_id === selectedConnectorId) ?? connectors[0] ?? null,
    [connectors, selectedConnectorId],
  );
  const connectorHasMore = nextConnectorCursor !== null;
  const connectorCountLabel = `${connectors.length}${connectorHasMore ? "+" : ""}`;
  const connectorCountHint = connectorHasMore ? "현재 로드된 결과" : "필터 적용 결과";

  useEffect(() => {
    if (connectorQuery.data === undefined) return;
    setNextConnectorCursor(connectorQuery.data.next_cursor);
    setConnectorItems((current) =>
      connectorCursor === null
        ? [...connectorQuery.data.items]
        : appendUniqueConnectors(current, connectorQuery.data.items),
    );
  }, [connectorCursor, connectorQuery.data]);

  const templateParams = useMemo(
    () => ({
      limit: 50,
      ...(templateCursor !== null ? { cursor: templateCursor } : {}),
      ...(selectedConnectorId !== null ? { connector_id: selectedConnectorId } : {}),
      ...(templateKind !== "all" ? { kind: templateKind } : {}),
      ...(templateStatus !== "all" ? { status: templateStatus } : {}),
    }),
    [selectedConnectorId, templateCursor, templateKind, templateStatus],
  );

  const templateQuery = useQuery({
    queryKey: ["template-catalog", templateParams],
    queryFn: () => api.listTemplates(templateParams),
    enabled: !connectorQuery.isLoading,
  });

  const templates = templateItems;
  const templateHasMore = nextTemplateCursor !== null;
  const templateCountLabel = `${templates.length}${templateHasMore ? "+" : ""}`;
  const templateScopeLabel = selectedConnectorId === null ? "전체" : (selectedConnector?.name ?? "선택한 커넥터");
  const templateCountHint = templateHasMore ? "현재 로드된 결과" : `${templateScopeLabel} 기준`;

  useEffect(() => {
    if (templateQuery.data === undefined) return;
    setNextTemplateCursor(templateQuery.data.next_cursor);
    setTemplateItems((current) =>
      templateCursor === null
        ? [...templateQuery.data.items]
        : appendUniqueTemplates(current, templateQuery.data.items),
    );
  }, [templateCursor, templateQuery.data]);

  function resetConnectorPaging(): void {
    setConnectorCursor(null);
    setNextConnectorCursor(null);
    setConnectorItems([]);
  }

  function resetTemplatePaging(): void {
    setTemplateCursor(null);
    setNextTemplateCursor(null);
    setTemplateItems([]);
  }

  function resetSelection(): void {
    setSelectedConnectorId(null);
    resetConnectorPaging();
    resetTemplatePaging();
  }

  function selectConnector(connectorId: string): void {
    setSelectedConnectorId(connectorId);
    resetTemplatePaging();
  }

  function openTemplateDraft(template: TemplateCatalogItem): void {
    const connector = connectors.find((item) => item.connector_id === template.connector_id) ?? selectedConnector;
    if (templateDraftBlocker(template, connector) !== null) return;
    const params = defaultTemplateParams(template, connector);
    const startUrl = typeof params.entry_url === "string" ? params.entry_url : typeof params.start_url === "string" ? params.start_url : connectorStartUrl(connector);
    navigate("scenarioStudio", {
      creator: "ai",
      connector_id: template.connector_id,
      template_id: template.template_id,
      name: `${template.name} 자동화 초안`,
      prompt: templatePrompt(connector, template),
      params: JSON.stringify(params, null, 2),
      start_url: startUrl,
    });
  }

  return (
    <div className="catalog-view">
      <section className="panel catalog-toolbar" aria-label="카탈로그 필터">
        <div>
          <h2>커넥터/템플릿 카탈로그</h2>
          <p className="subtle">브라우저 RPA 중심으로 재사용 가능한 연동 후보와 업무 템플릿을 검토합니다.</p>
        </div>
        <div className="inline-actions">
          <button className="btn" type="button" onClick={() => navigate("scenarioStudio")}>자동화 생성</button>
          <button className="btn" type="button" onClick={() => navigate("automationOps")}>운영 예약</button>
          <button className="btn" type="button" onClick={() => void connectorQuery.refetch()}>새로고침</button>
        </div>
      </section>

      <section className="metrics catalog-metrics" aria-label="카탈로그 요약">
        <div className="metric">
          <div className="label">커넥터</div>
          <div className="value">{connectorCountLabel}</div>
          <div className="subtle">{connectorCountHint}</div>
        </div>
        <div className="metric">
          <div className="label">템플릿</div>
          <div className="value">{templateCountLabel}</div>
          <div className="subtle">{templateCountHint}</div>
        </div>
        <div className="metric">
          <div className="label">보안 연결</div>
          <div className="value">{selectedConnector?.required_secret_refs.length ?? 0}</div>
          <div className="subtle">값 노출 없이 연결 개수만 표시</div>
        </div>
      </section>

      <div className="catalog-layout">
        <section className="panel" aria-label="커넥터 목록">
          <div className="panel-head">
            <h2>커넥터</h2>
            <div className="inline-actions">
              <label className="select-compact">
                <span>구분</span>
                <select value={connectorKind} onChange={(event) => { setConnectorKind(event.target.value as "all" | ConnectorCatalogKind); resetSelection(); }}>
                  <option value="all">전체</option>
                  {CONNECTOR_KIND_OPTIONS.map((kind) => (
                    <option key={kind} value={kind}>{KIND_LABEL[kind]}</option>
                  ))}
                </select>
              </label>
              <label className="select-compact">
                <span>상태</span>
                <select value={connectorStatus} onChange={(event) => { setConnectorStatus(event.target.value as "all" | CatalogStatus); resetSelection(); }}>
                  <option value="all">전체</option>
                  {STATUS_OPTIONS.map((status) => (
                    <option key={status} value={status}>{STATUS_LABEL[status]}</option>
                  ))}
                </select>
              </label>
            </div>
          </div>
          {connectorQuery.isLoading && connectorCursor === null ? (
            <Loading />
          ) : connectorQuery.isError ? (
            <ErrorState message="커넥터 카탈로그를 불러오지 못했습니다." onRetry={() => void connectorQuery.refetch()} />
          ) : connectors.length === 0 ? (
            <p className="empty-state">조건에 맞는 커넥터가 없습니다.</p>
          ) : (
            <div className="table-wrap">
              <table className="catalog-table">
                <thead>
                  <tr>
                    <th scope="col">커넥터</th>
                    <th scope="col">상태</th>
                    <th scope="col">권한/보안 연결</th>
                    <th scope="col">동작</th>
                  </tr>
                </thead>
                <tbody>
                  {connectors.map((connector) => (
                    <tr key={connector.connector_id} className={connector.connector_id === selectedConnector?.connector_id ? "selected-row" : undefined}>
                      <th scope="row">
                        <span>{connector.name}</span>
                        <span className="subtle">{KIND_LABEL[connector.kind]} · {categoryLabel(connector.category)}</span>
                      </th>
                      <td>
                        <span className={`badge ${statusTone(connector.status)}`}>{STATUS_LABEL[connector.status]}</span>
                        <span className={`badge ${priorityTone(connector.priority)}`}>{priorityLabel(connector.priority)}</span>
                      </td>
                      <td>
                        <span className="subtle">{rbacActionsLabel(connector.required_rbac_actions)}</span>
                        <span className="catalog-ref-list">{secretRefs(connector.required_secret_refs)}</span>
                      </td>
                      <td>
                        <button className="btn" type="button" onClick={() => selectConnector(connector.connector_id)}>템플릿 보기</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {connectorHasMore && (
                <div className="inline-actions" style={{ marginTop: 12 }}>
                  <button className="btn" type="button" onClick={() => setConnectorCursor(nextConnectorCursor)} disabled={connectorQuery.isFetching}>
                    {connectorQuery.isFetching && connectorCursor !== null ? "불러오는 중" : "더 보기"}
                  </button>
                  <span className="subtle">커넥터 수와 상세 선택은 현재까지 불러온 목록 기준입니다.</span>
                </div>
              )}
            </div>
          )}
        </section>

        <ConnectorDetailPanel connector={selectedConnector} />
      </div>

      <section className="panel" aria-label="템플릿 목록">
        <div className="panel-head">
          <h2>템플릿</h2>
          <div className="inline-actions">
            {selectedConnectorId === null ? (
              <span className="badge blue">전체 커넥터 기준</span>
            ) : (
              <button className="linklike" type="button" onClick={() => { setSelectedConnectorId(null); resetTemplatePaging(); }}>
                전체 템플릿 보기
              </button>
            )}
            <label className="select-compact">
              <span>구분</span>
              <select value={templateKind} onChange={(event) => { setTemplateKind(event.target.value as "all" | TemplateCatalogKind); resetTemplatePaging(); }}>
                <option value="all">전체</option>
                {TEMPLATE_KIND_OPTIONS.map((kind) => (
                  <option key={kind} value={kind}>{TEMPLATE_KIND_LABEL[kind]}</option>
                ))}
              </select>
            </label>
            <label className="select-compact">
              <span>상태</span>
              <select value={templateStatus} onChange={(event) => { setTemplateStatus(event.target.value as "all" | CatalogStatus); resetTemplatePaging(); }}>
                <option value="all">전체</option>
                {STATUS_OPTIONS.map((status) => (
                  <option key={status} value={status}>{STATUS_LABEL[status]}</option>
                ))}
              </select>
            </label>
            <button className="btn" type="button" disabled={selectedConnector === null} onClick={() => navigate("scenarioStudio")}>자동화 생성</button>
          </div>
        </div>
        {templateQuery.isLoading && templateCursor === null ? (
          <Loading />
        ) : templateQuery.isError ? (
          <ErrorState message="템플릿 카탈로그를 불러오지 못했습니다." onRetry={() => void templateQuery.refetch()} />
        ) : templates.length === 0 ? (
          <p className="empty-state">조건에 맞는 템플릿이 없습니다.</p>
        ) : (
          <div className="table-wrap">
            <table className="catalog-table">
              <thead>
                <tr>
                  <th scope="col">템플릿</th>
                  <th scope="col">상태</th>
                  <th scope="col">입력/보안 연결</th>
                  <th scope="col">성공 기준</th>
                  <th scope="col">동작</th>
                </tr>
              </thead>
              <tbody>
                {templates.map((template) => {
                  const connector = connectors.find((item) => item.connector_id === template.connector_id) ?? selectedConnector;
                  const blocker = templateDraftBlocker(template, connector);
                  return (
                  <tr key={template.template_id}>
                    <th scope="row">
                      <span>{template.name}</span>
                      <span className="subtle">{TEMPLATE_KIND_LABEL[template.kind]} · {irPatternLabel(template.produced_ir_pattern)}</span>
                    </th>
                    <td>
                      <span className={`badge ${statusTone(template.status)}`}>{STATUS_LABEL[template.status]}</span>
                      <span className={`badge ${priorityTone(template.priority)}`}>{priorityLabel(template.priority)}</span>
                      <span className="catalog-status-note">{templateDraftNote(template, connector)}</span>
                    </td>
                    <td>
                      <span className="subtle">{paramsLabel(template.required_params)}</span>
                      <span className="catalog-ref-list">{secretRefs(template.required_secret_refs)}</span>
                    </td>
                    <td>{template.success_criteria}</td>
                    <td>
                      <button
                        className="btn"
                        type="button"
                        onClick={() => openTemplateDraft(template)}
                        disabled={blocker !== null}
                        title={blocker ?? "생성 화면에서 입력값을 확인합니다"}
                      >
                        {templateDraftButtonLabel(template, connector)}
                      </button>
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
            {templateHasMore && (
              <div className="inline-actions" style={{ marginTop: 12 }}>
                <button className="btn" type="button" onClick={() => setTemplateCursor(nextTemplateCursor)} disabled={templateQuery.isFetching}>
                  {templateQuery.isFetching && templateCursor !== null ? "불러오는 중" : "더 보기"}
                </button>
                <span className="subtle">템플릿 수와 생성 후보는 현재까지 불러온 목록 기준입니다.</span>
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
