import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { useApiClient } from "../api/context";
import { useCan } from "../api/permissions";
import type {
  CatalogStatus,
  ConnectorCatalogKind,
  ConnectorCatalogItem,
  TemplateCatalogItem,
  TemplateCatalogKind,
} from "../api/types";
import { EmptyState, ErrorState, Loading, desktopStateForError } from "../components/states";
import { navigate, useHashParam } from "../router";
import { ConnectorDetailPanel } from "./connectors/ConnectorDetailPanel";
import { TemplatePreviewPanel } from "./connectors/TemplatePreviewPanel";
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
  connectorDraftBlocker,
  connectorDraftButtonLabel,
  connectorPrompt,
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
  const can = useCan();
  const canCreateScenario = can("scenario.create");
  const [connectorKind, setConnectorKind] = useState<"all" | ConnectorCatalogKind>("all");
  const [connectorStatus, setConnectorStatus] = useState<"all" | CatalogStatus>("all");
  const [templateKind, setTemplateKind] = useState<"all" | TemplateCatalogKind>("all");
  const [templateStatus, setTemplateStatus] = useState<"all" | CatalogStatus>("all");
  const [selectedConnectorId, setSelectedConnectorId] = useState<string | null>(null);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);
  const [connectorCursor, setConnectorCursor] = useState<string | null>(null);
  const [nextConnectorCursor, setNextConnectorCursor] = useState<string | null>(null);
  const [connectorItems, setConnectorItems] = useState<ConnectorCatalogItem[]>([]);
  const [templateCursor, setTemplateCursor] = useState<string | null>(null);
  const [nextTemplateCursor, setNextTemplateCursor] = useState<string | null>(null);
  const [templateItems, setTemplateItems] = useState<TemplateCatalogItem[]>([]);
  const focusParam = useHashParam("focus");
  const connectorSectionRef = useRef<HTMLElement | null>(null);
  const templateSectionRef = useRef<HTMLElement | null>(null);

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
  const selectedTemplate = useMemo(
    () => templates.find((item) => item.template_id === selectedTemplateId) ?? templates[0] ?? null,
    [selectedTemplateId, templates],
  );
  const selectedTemplateConnector = useMemo(() => {
    if (selectedTemplate === null) return null;
    return connectors.find((item) => item.connector_id === selectedTemplate.connector_id)
      ?? (selectedConnector?.connector_id === selectedTemplate.connector_id ? selectedConnector : null);
  }, [connectors, selectedConnector, selectedTemplate]);

  useEffect(() => {
    if (templateQuery.data === undefined) return;
    setNextTemplateCursor(templateQuery.data.next_cursor);
    setTemplateItems((current) =>
      templateCursor === null
        ? [...templateQuery.data.items]
        : appendUniqueTemplates(current, templateQuery.data.items),
    );
  }, [templateCursor, templateQuery.data]);
  useEffect(() => {
    const target =
      focusParam === "templates"
        ? templateSectionRef.current
        : focusParam === "connectors"
          ? connectorSectionRef.current
          : null;
    if (target === null) return;
    target.scrollIntoView?.({ block: "start" });
    target.focus({ preventScroll: true });
  }, [focusParam]);

  function resetConnectorPaging(): void {
    setConnectorCursor(null);
    setNextConnectorCursor(null);
    setConnectorItems([]);
  }

  function resetTemplatePaging(): void {
    setTemplateCursor(null);
    setNextTemplateCursor(null);
    setTemplateItems([]);
    setSelectedTemplateId(null);
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

  function resetConnectorFilters(): void {
    setConnectorKind("all");
    setConnectorStatus("all");
    resetSelection();
  }

  function resetTemplateFilters(): void {
    setTemplateKind("all");
    setTemplateStatus("all");
    resetTemplatePaging();
  }

  function openConnectorDraft(connector: ConnectorCatalogItem): void {
    if (!canCreateScenario || connectorDraftBlocker(connector) !== null) return;
    const startUrl = connectorStartUrl(connector);
    navigate("create", {
      creator: "ai",
      connector_id: connector.connector_id,
      name: `${connector.name} 자동화 초안`,
      prompt: connectorPrompt(connector),
      ...(startUrl !== null ? { start_url: startUrl } : {}),
    });
  }

  function openTemplateDraft(template: TemplateCatalogItem): void {
    const connector = connectors.find((item) => item.connector_id === template.connector_id)
      ?? (selectedConnector?.connector_id === template.connector_id ? selectedConnector : null);
    if (!canCreateScenario || templateDraftBlocker(template, connector) !== null) return;
    const params = defaultTemplateParams(template, connector);
    const startUrl = connectorStartUrl(connector);
    navigate("create", {
      creator: "ai",
      connector_id: template.connector_id,
      template_id: template.template_id,
      name: `${template.name} 자동화 초안`,
      prompt: templatePrompt(connector, template),
      params: JSON.stringify(params, null, 2),
      ...(startUrl !== null ? { start_url: startUrl } : {}),
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
          {canCreateScenario && <button className="btn" type="button" onClick={() => navigate("create")}>자동화 생성</button>}
          {can("trigger.manage") && <button className="btn" type="button" onClick={() => navigate("automationOps")}>운영 예약</button>}
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
        <section ref={connectorSectionRef} className="panel" aria-label="커넥터 목록" tabIndex={-1}>
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
            <ErrorState
              title={desktopStateForError(connectorQuery.error).title}
              message={`${desktopStateForError(connectorQuery.error).message} 커넥터 카탈로그를 불러오지 못했습니다.`}
              details={desktopStateForError(connectorQuery.error).details}
              onRetry={() => void connectorQuery.refetch()}
            />
          ) : connectors.length === 0 ? (
            <EmptyState
              title="조건에 맞는 커넥터 없음"
              message="현재 필터로 확인할 수 있는 커넥터가 없습니다. 전체 조건으로 다시 확인할 수 있습니다."
              action={<button className="btn" type="button" onClick={resetConnectorFilters}>필터 초기화</button>}
            />
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

        <ConnectorDetailPanel connector={selectedConnector} canCreateScenario={canCreateScenario} onCreateDraft={openConnectorDraft} />
      </div>

      <section ref={templateSectionRef} className="panel" aria-label="템플릿 목록" tabIndex={-1}>
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
            <button
              className="btn"
              type="button"
              disabled={selectedConnector === null || !canCreateScenario || connectorDraftBlocker(selectedConnector) !== null}
              title={
                !canCreateScenario
                  ? "scenario.create 권한이 있어야 초안을 만들 수 있습니다."
                  : selectedConnector === null
                    ? "커넥터를 먼저 선택하세요."
                    : (connectorDraftBlocker(selectedConnector) ?? "선택한 커넥터 문맥을 생성 화면으로 전달합니다")
              }
              onClick={() => {
                if (selectedConnector !== null) openConnectorDraft(selectedConnector);
              }}
            >
              {selectedConnector === null ? "커넥터 선택 필요" : canCreateScenario ? connectorDraftButtonLabel(selectedConnector) : "권한 필요"}
            </button>
          </div>
        </div>
        {templateQuery.isLoading && templateCursor === null ? (
          <Loading />
        ) : templateQuery.isError ? (
          <ErrorState
            title={desktopStateForError(templateQuery.error).title}
            message={`${desktopStateForError(templateQuery.error).message} 템플릿 카탈로그를 불러오지 못했습니다.`}
            details={desktopStateForError(templateQuery.error).details}
            onRetry={() => void templateQuery.refetch()}
          />
        ) : templates.length === 0 ? (
          <EmptyState
            title="조건에 맞는 템플릿 없음"
            message="현재 커넥터 또는 필터 조건으로 사용할 템플릿이 없습니다. 필터를 초기화하거나 전체 템플릿을 확인하세요."
            action={
              <div className="inline-actions">
                <button className="btn" type="button" onClick={resetTemplateFilters}>템플릿 필터 초기화</button>
                {selectedConnectorId !== null && (
                  <button className="btn" type="button" onClick={() => { setSelectedConnectorId(null); resetTemplatePaging(); }}>
                    전체 템플릿 보기
                  </button>
                )}
              </div>
            }
          />
        ) : (
          <>
            <TemplatePreviewPanel
              template={selectedTemplate}
              connector={selectedTemplateConnector}
              canCreateScenario={canCreateScenario}
              onCreateDraft={openTemplateDraft}
            />
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
                    const connector = connectors.find((item) => item.connector_id === template.connector_id)
                      ?? (selectedConnector?.connector_id === template.connector_id ? selectedConnector : null);
                    const blocker = templateDraftBlocker(template, connector);
                    const createDisabledReason = canCreateScenario ? blocker : "scenario.create 권한이 있어야 초안을 만들 수 있습니다.";
                    return (
                    <tr key={template.template_id} className={template.template_id === selectedTemplate?.template_id ? "selected-row" : undefined}>
                      <th scope="row">
                        <span>{template.name}</span>
                        <span className="subtle">{template.summary}</span>
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
                        <div className="inline-actions">
                          <button className="btn" type="button" onClick={() => setSelectedTemplateId(template.template_id)}>미리보기</button>
                          <button
                            className="btn"
                            type="button"
                            onClick={() => openTemplateDraft(template)}
                            disabled={createDisabledReason !== null}
                            title={createDisabledReason ?? "생성 화면에서 입력값을 확인합니다"}
                          >
                            {canCreateScenario ? templateDraftButtonLabel(template, connector) : "권한 필요"}
                          </button>
                        </div>
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
          </>
        )}
      </section>
    </div>
  );
}
