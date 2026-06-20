import { useEffect, useRef } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";

// 비모달 사이드 드로어(.slide-over = position:fixed 우측 패널, 배경 차단/백드롭 없음).
// a11y: 열 때 패널로 포커스 진입(영역 라벨을 SR이 읽음)·Escape 닫기·닫을 때 트리거로 포커스 복원.
// ⚠ Tab 트랩은 두지 않는다 — 비모달 드로어에 트랩=키보드 트랩(WCAG 2.1.2 위반). 배경이 계속
//   상호작용 가능하므로 Tab은 자연스럽게 패널 밖으로 나갈 수 있어야 한다(모달 ConfirmDialog와 의도적으로 다름).
export function SlideOver({
  title,
  subtitle,
  onClose,
  children,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
}): JSX.Element {
  const asideRef = useRef<HTMLElement>(null);
  const restoreRef = useRef<Element | null>(null);

  useEffect(() => {
    // 패널 내부에 이미 포커스가 있으면 가로채지 않는다 — 하위 영역이 마운트 시 포커스를 잡는 경우
    //   (예: RunTrace focus=artifacts 딥링크가 산출물 영역을 포커스) 그 더-구체적 포커스를 보존.
    //   자식 effect는 부모보다 먼저 실행되므로, 여기서 내부 포커스 여부로 분기할 수 있다.
    const aside = asideRef.current;
    const active = document.activeElement;
    if (aside !== null && !aside.contains(active)) {
      // 패널 밖에서 열림(트리거 클릭) — 직전 포커스(트리거)를 저장 후 패널로 진입. 닫힐 때 트리거로 복원.
      restoreRef.current = active;
      aside.focus();
    }
    return () => {
      if (restoreRef.current instanceof HTMLElement) restoreRef.current.focus();
    };
  }, []);

  function onKeyDown(e: ReactKeyboardEvent<HTMLElement>): void {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  }

  return (
    <aside
      ref={asideRef}
      className="slide-over"
      role="region"
      aria-label={title.replace(/ — .+$/, "")}
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      <header className="slide-over-head">
        <div>
          <h2>{title}</h2>
          {subtitle !== undefined && <p className="subtle">{subtitle}</p>}
        </div>
        <button className="btn" type="button" onClick={onClose}>
          닫기
        </button>
      </header>
      <div className="slide-over-body">{children}</div>
    </aside>
  );
}
