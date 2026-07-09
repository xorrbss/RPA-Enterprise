import { Bot, FileSearch, Globe, ListChecks, MousePointerClick, PencilRuler, Plug, type LucideIcon } from "lucide-react";

export function AutomationStartChooser({
  onBrowserText,
  onBrowserRecord,
  onTemplate,
  onDocument,
  onConnector,
  onManual,
}: {
  onBrowserText: () => void;
  onBrowserRecord: () => void;
  onTemplate: () => void;
  onDocument: () => void;
  onConnector: () => void;
  onManual: () => void;
}): JSX.Element {
  return (
    <section className="panel automation-start-chooser" aria-label="자동화 시작 방식">
      <div className="automation-start-head">
        <div>
          <h2>어떤 자동화로 시작할까요?</h2>
          <p className="subtle">업무 유형을 먼저 고르면 필요한 준비 단계와 제작 화면으로 바로 이어집니다.</p>
        </div>
        <button className="btn" type="button" onClick={onBrowserRecord}>
          <MousePointerClick size={14} aria-hidden="true" />
          브라우저 녹화로 만들기
        </button>
      </div>
      <div className="automation-start-grid">
        <AutomationStartCard
          icon={Globe}
          title="브라우저 업무 자동화"
          description="웹 포털 조회, 입력, 다운로드처럼 화면을 보며 처리하는 반복 업무를 말로 시작합니다."
          badge="추천"
          primary
          actionLabel="말로 시작"
          actionAriaLabel="브라우저 업무 자동화"
          onAction={onBrowserText}
        />
        <AutomationStartCard
          id="create-template-start"
          icon={ListChecks}
          title="템플릿에서 시작"
          description="검토된 업무 템플릿을 골라 실행 입력값과 시작 주소를 미리 채웁니다."
          actionLabel="템플릿 보기"
          actionAriaLabel="템플릿에서 시작"
          onAction={onTemplate}
        />
        <AutomationStartCard
          icon={FileSearch}
          title="문서/IDP 자동화"
          description="문서 추출, 검증 큐, 증빙 연결이 중심인 업무는 문서 자동화에서 시작합니다."
          actionLabel="문서 자동화 열기"
          actionAriaLabel="문서/IDP 자동화"
          onAction={onDocument}
        />
        <AutomationStartCard
          icon={Plug}
          title="API/커넥터 자동화"
          description="브라우저보다 재사용 커넥터나 외부 연동 후보가 먼저인 업무를 확인합니다."
          actionLabel="커넥터 보기"
          actionAriaLabel="API/커넥터 자동화"
          onAction={onConnector}
        />
        <AutomationStartCard
          icon={PencilRuler}
          title="직접 설계"
          description="자연어 초안이 맞지 않는 예외 상황에서만 이름과 정의를 직접 입력합니다."
          actionLabel="양식 열기"
          actionAriaLabel="직접 설계"
          onAction={onManual}
        />
        <AutomationStartCard
          icon={Bot}
          title="AI Agent/MCP 자동화"
          description="Agent와 MCP 기반 자동화는 제품 계약과 보안 경계가 정해진 뒤 활성화합니다."
          badge="결정 필요"
          disabled
        />
      </div>
    </section>
  );
}

function AutomationStartCard({
  id,
  icon: Icon,
  title,
  description,
  badge,
  actionLabel,
  actionAriaLabel,
  onAction,
  primary = false,
  disabled = false,
}: {
  id?: string;
  icon: LucideIcon;
  title: string;
  description: string;
  badge?: string;
  actionLabel?: string;
  actionAriaLabel?: string;
  onAction?: () => void;
  primary?: boolean;
  disabled?: boolean;
}): JSX.Element {
  return (
    <article id={id} className={`automation-start-card${primary ? " primary" : ""}${disabled ? " disabled" : ""}`} aria-disabled={disabled || undefined}>
      <span className="automation-start-icon">
        <Icon size={18} aria-hidden="true" />
      </span>
      <div className="automation-start-copy">
        <span className="automation-start-title-row">
          <h3>{title}</h3>
          {badge !== undefined && <span className={`badge ${disabled ? "muted" : "blue"}`}>{badge}</span>}
        </span>
        <p className="subtle">{description}</p>
      </div>
      {disabled ? (
        <span className="automation-start-disabled-note">활성화 대기</span>
      ) : (
        <button className={primary ? "btn primary" : "btn"} type="button" onClick={onAction} aria-label={actionAriaLabel}>
          {actionLabel}
        </button>
      )}
    </article>
  );
}
