import type { ReactNode } from "react";

import type { EasyGenerationPhase } from "../easy-create/useEasyGeneration";

// F3(§3.3): 원패스 셸의 입력 폼 래퍼 — IDLE=그대로, GENERATING=잠금(fieldset disabled)+진행 표시,
// PREVIEW/TESTING=접힌 요약(요청문 1줄 + "요청 고치기" 펼침). 접힘은 기존 <details> 관례
// (AdvancedSettings 동형) — 새 아코디언 컴포넌트·단계 칩·프로그레스 바 금지(확정 불변식).
// details/fieldset 은 phase 와 무관하게 항상 같은 요소로 유지한다 — phase 전환마다 폼 서브트리가
// 리마운트되면 인라인 사이트 등록 등 하위 상태가 유실된다(요소 정체성 보존).
export function GeneratorFormShell({
  phase,
  requestSummary,
  formOpen,
  onFormOpenChange,
  children,
}: {
  readonly phase: EasyGenerationPhase;
  readonly requestSummary: string;
  readonly formOpen: boolean;
  readonly onFormOpenChange: (open: boolean) => void;
  readonly children: ReactNode;
}): JSX.Element {
  const collapsed = phase === "PREVIEW" || phase === "TESTING";
  return (
    <details
      className={`generator-request-details${collapsed ? " developer-details" : ""}`}
      open={collapsed ? formOpen : true}
      onToggle={(event) => {
        if (collapsed) onFormOpenChange((event.currentTarget as HTMLDetailsElement).open);
      }}
    >
      {/* 접힘 요약은 PREVIEW/TESTING 에서만 노출 — IDLE/GENERATING 은 폼이 그대로 주인공. */}
      <summary className={collapsed ? undefined : "generator-summary-hidden"}>
        요청 고치기 — <span className="generator-request-line">{requestSummary}</span>
      </summary>
      <fieldset className="generator-locked generator-form-stack" disabled={phase === "GENERATING"}>
        {children}
      </fieldset>
      {phase === "GENERATING" && (
        <p className="subtle" role="status">
          초안을 만드는 중입니다 — 완료될 때까지 입력이 잠시 잠깁니다.
        </p>
      )}
    </details>
  );
}
