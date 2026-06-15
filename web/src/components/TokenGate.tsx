import { useState, type ReactNode } from "react";

// 토큰 게이트 — Bearer 토큰(외부 발급 JWT)을 브라우저(localStorage)에만 저장. IdP 없음(토큰은 외부 공급).
// 토큰 없으면 입력 화면, 있으면 콘솔. 조용한 401 루프 대신 명시적 접속 화면.
const KEY = "rpa.token";

export function clearToken(): void {
  localStorage.removeItem(KEY);
  location.reload();
}

export function TokenGate({ children }: { children: ReactNode }): JSX.Element {
  const [token, setToken] = useState<string | null>(() => localStorage.getItem(KEY));
  if (token !== null && token !== "") return <>{children}</>;
  return (
    <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", background: "var(--bg)" }}>
      <form
        className="panel"
        style={{ padding: 24, width: 440, maxWidth: "90vw", display: "flex", flexDirection: "column", gap: 12 }}
        onSubmit={(e) => {
          e.preventDefault();
          const t = String(new FormData(e.currentTarget).get("token") ?? "").trim();
          if (t !== "") {
            localStorage.setItem(KEY, t);
            setToken(t);
          }
        }}
      >
        <h1 style={{ fontSize: 18, margin: 0 }}>RPA 운영 콘솔 접속</h1>
        <p style={{ color: "var(--muted)", fontSize: 13, margin: 0 }}>
          발급받은 Bearer 토큰(JWT)을 입력하세요. 토큰은 이 브라우저에만 저장되며 서버로 별도 전송되지 않습니다.
        </p>
        <textarea
          name="token"
          rows={4}
          placeholder="eyJhbGciOi..."
          aria-label="Bearer 토큰"
          spellCheck={false}
          style={{ padding: 10, borderRadius: 8, border: "1px solid var(--line-strong)", fontFamily: "monospace", fontSize: 12 }}
        />
        <button className="btn primary" type="submit">
          접속
        </button>
      </form>
    </div>
  );
}
