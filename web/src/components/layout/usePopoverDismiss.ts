import { useEffect, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";

// 팝오버 공통 닫힘 규약(GlobalCreateMenu 가 확립한 T1 패턴): mousedown 바깥 닫기 + Escape 닫기 +
// 트리거 포커스 복원. GlobalCreateMenu·TopbarAlertBell 이 공유한다(F4 §4.3 — 3번째 복제 방지).
// onClose 는 참조 안정(useCallback 등)이어야 열림 중 리스너 재구독이 없다.
export function usePopoverDismiss({
  open,
  onClose,
  rootRef,
  triggerRef,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly rootRef: RefObject<HTMLElement | null>;
  readonly triggerRef: RefObject<HTMLElement | null>;
}): { onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => void } {
  useEffect(() => {
    if (!open) return;
    const onMouseDown = (event: MouseEvent): void => {
      const target = event.target;
      if (!(target instanceof Node) || rootRef.current?.contains(target) === true) return;
      onClose();
    };
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [open, onClose, rootRef]);
  return {
    onKeyDown: (event) => {
      if (event.key !== "Escape" || !open) return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
      triggerRef.current?.focus();
    },
  };
}
