import { useEffect, useRef } from "react";

// 포커스 트랩 role=dialog aria-modal 확인 모달 — 목업(rpa_enterprise_console.html)의
// getFocusable/moveFocusInto/restoreFocus + Tab 순환 트랩을 React로 이식(native confirm/prompt 대체).
// 선택적 children으로 입력 폼 변형(예: 담당자 uuid)을 지원. Esc/배경 클릭=취소.
function getFocusable(root: HTMLElement): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'),
  ).filter((el) => !el.hasAttribute("disabled") && el.tabIndex !== -1);
}

export function ConfirmDialog(props: {
  title: string;
  confirmLabel?: string;
  confirmDisabled?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  children?: React.ReactNode;
  // 정보 전용 변형 — confirm 버튼 숨김(취소 단일=닫기). cancelLabel 로 라벨 변경(기본 "취소").
  hideConfirm?: boolean;
  cancelLabel?: string;
}): JSX.Element {
  const dialogRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<Element | null>(null);

  useEffect(() => {
    // 열기 시 직전 포커스 저장 → 다이얼로그 내부 첫 포커서블로 이동. 닫힐 때 복원.
    restoreRef.current = document.activeElement;
    const dialog = dialogRef.current;
    if (dialog !== null) {
      const focusables = getFocusable(dialog);
      (focusables[0] ?? dialog).focus();
    }
    return () => {
      if (restoreRef.current instanceof HTMLElement) restoreRef.current.focus();
    };
  }, []);

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>): void {
    if (e.key === "Escape") {
      e.preventDefault();
      props.onCancel();
      return;
    }
    if (e.key !== "Tab") return;
    const dialog = dialogRef.current;
    if (dialog === null) return;
    const f = getFocusable(dialog);
    const first = f[0];
    const last = f[f.length - 1];
    if (first === undefined || last === undefined) return;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  return (
    <div
      onClick={props.onCancel}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.45)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={props.title}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--surface)",
          border: "1px solid var(--line)",
          borderRadius: "var(--radius)",
          boxShadow: "var(--shadow)",
          padding: 20,
          maxWidth: 460,
          width: "90%",
          display: "grid",
          gap: 14,
        }}
      >
        <h3 style={{ margin: 0, fontSize: 14 }}>{props.title}</h3>
        {props.children}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button className="btn" type="button" onClick={props.onCancel}>
            {props.cancelLabel ?? "취소"}
          </button>
          {props.hideConfirm !== true && (
            <button className="btn" type="button" onClick={props.onConfirm} disabled={props.confirmDisabled === true}>
              {props.confirmLabel ?? "확인"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
