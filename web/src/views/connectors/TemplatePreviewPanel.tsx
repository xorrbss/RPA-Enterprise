import type { ConnectorCatalogItem, TemplateCatalogItem } from "../../api/types";
import {
  KIND_LABEL,
  STATUS_LABEL,
  TEMPLATE_KIND_LABEL,
  actionsLabel,
  categoryLabel,
  irPatternLabel,
  listLabel,
  paramsLabel,
  priorityLabel,
  priorityTone,
  rbacActionsLabel,
  secretRefs,
  statusTone,
  templateDraftBlocker,
  templateDraftButtonLabel,
  templateDraftNote,
} from "./catalog-labels";

export function TemplatePreviewPanel({
  template,
  connector,
  canCreateScenario,
  onCreateDraft,
}: {
  template: TemplateCatalogItem | null;
  connector: ConnectorCatalogItem | null;
  canCreateScenario: boolean;
  onCreateDraft: (template: TemplateCatalogItem) => void;
}): JSX.Element {
  if (template === null) {
  return (
    <div className="catalog-detail-body" aria-label="선택한 템플릿 미리보기">
      <div>
        <h3>만들 수 있는 자동화</h3>
        <p className="subtle">템플릿을 불러오면 실제 카탈로그 메타데이터로 입력값, 산출 패턴, 성공 기준을 먼저 확인할 수 있습니다.</p>
      </div>
      </div>
    );
  }

  const blocker = templateDraftBlocker(template, connector);
  const createDisabledReason = canCreateScenario ? blocker : "scenario.create 권한이 있어야 초안을 만들 수 있습니다.";
  const connectorLabel = connector === null
    ? `${template.connector_id} (현재 로드된 커넥터 메타데이터 없음)`
    : `${connector.name} · ${KIND_LABEL[connector.kind]} · ${categoryLabel(connector.category)}`;

  return (
    <div className="catalog-detail-body" aria-label="선택한 템플릿 미리보기">
      <div>
        <h3>{template.name} 미리보기</h3>
        <p>{template.summary}</p>
        <div className="inline-facts">
          <span className={`badge ${statusTone(template.status)}`}>{STATUS_LABEL[template.status]}</span>
          <span className="badge blue">{TEMPLATE_KIND_LABEL[template.kind]}</span>
          <span className={`badge ${priorityTone(template.priority)}`}>{priorityLabel(template.priority)}</span>
        </div>
      </div>

      <dl className="catalog-facts">
        <div>
          <dt>무엇을 만들 수 있나</dt>
          <dd>{listLabel(template.best_for)}</dd>
        </div>
        <div>
          <dt>필요 입력</dt>
          <dd>{paramsLabel(template.required_params)}</dd>
        </div>
        <div>
          <dt>자동화 산출 패턴</dt>
          <dd>{irPatternLabel(template.produced_ir_pattern)}</dd>
        </div>
        <div>
          <dt>성공 기준</dt>
          <dd>{template.success_criteria}</dd>
        </div>
        <div>
          <dt>커넥터</dt>
          <dd>{connectorLabel}</dd>
        </div>
        <div>
          <dt>지원 동작</dt>
          <dd>{connector === null ? "커넥터 메타데이터를 함께 로드해야 확인할 수 있습니다." : actionsLabel(connector.supported_actions)}</dd>
        </div>
        <div>
          <dt>필요 권한</dt>
          <dd>{connector === null ? "커넥터 메타데이터를 함께 로드해야 확인할 수 있습니다." : rbacActionsLabel(connector.required_rbac_actions)}</dd>
        </div>
        <div>
          <dt>보안 연결</dt>
          <dd className="catalog-ref-list">{secretRefs(template.required_secret_refs)}</dd>
        </div>
      </dl>

      <div className="inline-actions">
        <button
          className="btn primary"
          type="button"
          disabled={createDisabledReason !== null}
          title={createDisabledReason ?? "생성 화면에서 입력값을 확인합니다"}
          onClick={() => onCreateDraft(template)}
        >
          {canCreateScenario ? templateDraftButtonLabel(template, connector) : "권한 필요"}
        </button>
        <span className="catalog-status-note" role="status">
          {createDisabledReason ?? templateDraftNote(template, connector)}
        </span>
      </div>
    </div>
  );
}
