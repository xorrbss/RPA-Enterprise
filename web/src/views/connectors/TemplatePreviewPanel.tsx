import { PlaySquare } from "lucide-react";

import type { ConnectorCatalogItem, TemplateCatalogItem } from "../../api/types";
import {
  KIND_LABEL,
  STATUS_LABEL,
  TEMPLATE_KIND_LABEL,
  actionsLabel,
  categoryLabel,
  connectorStartUrl,
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

function templateInputList(template: TemplateCatalogItem): JSX.Element {
  if (template.required_params.length === 0) return <span className="subtle">필요 입력 없음</span>;
  return (
    <ul className="template-preflight-list" aria-label="필요 입력 목록">
      {template.required_params.map((param) => (
        <li key={param}>
          <span>{paramsLabel([param])}</span>
          <code>{param}</code>
        </li>
      ))}
    </ul>
  );
}

function siteSessionHint(template: TemplateCatalogItem, connector: ConnectorCatalogItem | null): string {
  const isBrowserContext = template.kind === "browser_workflow" || connector?.kind === "browser";
  if (!isBrowserContext) {
    return "브라우저 세션 대신 승인된 연동 프로필과 SecretRef 준비 상태를 확인하세요.";
  }

  const startUrl = connectorStartUrl(connector);
  if (connector === null) {
    return "커넥터 메타데이터를 함께 로드해야 시작 사이트와 세션 필요 여부를 확인할 수 있습니다.";
  }
  if (startUrl === null) {
    return "시작 사이트 후보가 계약에 없어 Security에서 사이트를 먼저 선택해야 합니다.";
  }
  return `${startUrl} 후보 사이트를 등록하고, 로그인 필요 업무라면 session_ready 상태를 Security에서 확인하세요.`;
}

function metadataStepPreview(template: TemplateCatalogItem, connector: ConnectorCatalogItem | null): JSX.Element {
  return (
    <section className="template-step-preview" aria-label="메타데이터 기반 단계 미리보기">
      <div className="template-step-preview-head">
        <span className="badge blue">메타데이터 기반</span>
        <strong>{irPatternLabel(template.produced_ir_pattern)}</strong>
      </div>
      <ul className="template-step-preview-list">
        <li>
          <strong>산출 패턴</strong>
          <span>{irPatternLabel(template.produced_ir_pattern)}</span>
        </li>
        <li>
          <strong>가능 동작</strong>
          <span>{connector === null ? "커넥터 메타데이터를 함께 로드해야 확인할 수 있습니다." : actionsLabel(connector.supported_actions)}</span>
        </li>
        <li>
          <strong>Fail-closed</strong>
          <span>정확한 ordered step, 선택자, API 호출 순서는 현재 템플릿 계약에 없어 추측하지 않습니다.</span>
        </li>
      </ul>
    </section>
  );
}

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
      <div className="catalog-detail-body template-preflight-panel" aria-label="선택한 템플릿 미리보기">
        <div>
          <h3>템플릿 preflight</h3>
          <p className="subtle">템플릿을 선택하면 카탈로그 메타데이터로 입력값, 권한, SecretRef, 사이트·세션 준비 힌트와 초안 생성 가능 여부를 먼저 확인합니다.</p>
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
    <div className="catalog-detail-body template-preflight-panel" aria-label="선택한 템플릿 미리보기">
      <div className="template-preflight-hero">
        <div>
          <h3>{template.name} 미리보기</h3>
          <p>{template.summary}</p>
          <div className="inline-facts">
            <span className="badge blue">P0 preflight</span>
            <span className={`badge ${statusTone(template.status)}`}>{STATUS_LABEL[template.status]}</span>
            <span className="badge muted">{TEMPLATE_KIND_LABEL[template.kind]}</span>
            <span className={`badge ${priorityTone(template.priority)}`}>{priorityLabel(template.priority)}</span>
          </div>
        </div>
        <div className="template-preflight-cta">
          <button
            className="btn primary"
            type="button"
            disabled={createDisabledReason !== null}
            title={createDisabledReason ?? "생성 화면에서 입력값을 확인합니다"}
            onClick={() => onCreateDraft(template)}
          >
            <PlaySquare size={16} aria-hidden="true" />
            {canCreateScenario ? templateDraftButtonLabel(template, connector) : "권한 필요"}
          </button>
          <span className="catalog-status-note" role="status">
            {createDisabledReason ?? templateDraftNote(template, connector)}
          </span>
        </div>
      </div>

      <dl className="catalog-facts template-preflight-facts">
        <div>
          <dt>무엇을 만드는가</dt>
          <dd>{listLabel(template.best_for)}</dd>
        </div>
        <div>
          <dt>필요 입력</dt>
          <dd>{templateInputList(template)}</dd>
        </div>
        <div>
          <dt>필요 권한</dt>
          <dd>
            <span className={`badge ${canCreateScenario ? "green" : "amber"}`}>
              {canCreateScenario ? "scenario.create 확인됨" : "scenario.create 필요"}
            </span>
            <span className="template-preflight-line">
              {connector === null ? "커넥터 권한은 메타데이터를 함께 로드해야 확인할 수 있습니다." : rbacActionsLabel(connector.required_rbac_actions)}
            </span>
          </dd>
        </div>
        <div>
          <dt>필요 SecretRef</dt>
          <dd>
            <span>템플릿: </span>
            <span className="catalog-ref-list">{secretRefs(template.required_secret_refs)}</span>
            <span className="template-preflight-line">커넥터: {connector === null ? "메타데이터 확인 필요" : secretRefs(connector.required_secret_refs)}</span>
          </dd>
        </div>
        <div>
          <dt>사이트·세션 준비</dt>
          <dd>{siteSessionHint(template, connector)}</dd>
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
          <dt>자동화 산출 패턴</dt>
          <dd>{irPatternLabel(template.produced_ir_pattern)}</dd>
        </div>
      </dl>

      {metadataStepPreview(template, connector)}
    </div>
  );
}
