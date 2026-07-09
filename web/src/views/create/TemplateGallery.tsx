import { useQuery } from "@tanstack/react-query";

import { useApiClient } from "../../api/context";
import type { ConnectorCatalogItem, TemplateCatalogItem } from "../../api/types";
import { navigate } from "../../router";
import {
  connectorStartUrl,
  defaultTemplateParams,
  templateDraftBlocker,
  templatePrompt,
} from "../connectors/catalog-labels";

// E6: 만들기 홈 템플릿 갤러리 — 커넥터 카탈로그(관리 콘솔·admin 표준)가 업무 사용자의 유일한 템플릿
// 경로였던 것을 홈에서 직접 제공한다(단순화 검토 '갤러리 유지 확정'). 프리필 계약은 카탈로그의
// openTemplateDraft 와 동일(prompt/params/start_url/template_id — 기존 usePrefill 키 집합).
export function TemplateGallery({ canCreateScenario }: { readonly canCreateScenario: boolean }): JSX.Element | null {
  const api = useApiClient();
  const templates = useQuery({
    queryKey: ["templates", "create-gallery"],
    queryFn: () => api.listTemplates({ limit: 6 }),
    staleTime: 60_000,
  });
  const connectors = useQuery({
    queryKey: ["connectors", "create-gallery"],
    queryFn: () => api.listConnectors({ limit: 50 }),
    staleTime: 60_000,
  });
  const items = templates.data?.items ?? [];
  // 로딩·오류·빈 목록이면 섹션 자체를 렌더하지 않는다(홈은 입력이 주인공 — 빈 갤러리 스켈레톤 금지).
  if (!canCreateScenario || items.length === 0) return null;
  const connectorItems: readonly ConnectorCatalogItem[] = connectors.data?.items ?? [];

  function startFromTemplate(template: TemplateCatalogItem): void {
    const connector = connectorItems.find((item) => item.connector_id === template.connector_id) ?? null;
    if (templateDraftBlocker(template, connector) !== null) return;
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
    <section className="panel template-gallery" aria-label="템플릿에서 시작" id="create-template-start">
      <div className="panel-head">
        <div>
          <h2>템플릿에서 시작</h2>
          <p className="subtle">검토된 업무 템플릿을 골라 요청·입력값이 채워진 상태로 시작합니다.</p>
        </div>
      </div>
      <ul className="template-gallery-list">
        {items.map((template) => {
          const connector = connectorItems.find((item) => item.connector_id === template.connector_id) ?? null;
          const blocker = templateDraftBlocker(template, connector);
          return (
            <li key={template.template_id} className="template-gallery-card">
              <strong>{template.name}</strong>
              {template.summary !== undefined && template.summary !== null && template.summary !== "" && (
                <span className="subtle">{template.summary}</span>
              )}
              {blocker !== null ? (
                <span className="badge amber" title={blocker}>준비 필요</span>
              ) : (
                <button className="btn primary" type="button" onClick={() => startFromTemplate(template)}>
                  이대로 만들기
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
