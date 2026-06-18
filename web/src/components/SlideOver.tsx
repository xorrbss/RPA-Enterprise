import type { ReactNode } from "react";

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
  return (
    <aside className="slide-over" role="region" aria-label={title.replace(/ — .+$/, "")}>
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
