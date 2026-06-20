import { useEffect, useState, type ReactNode } from "react";

import { ApiError } from "../api/types";

// 토큰 게이트 — Bearer 토큰(외부 발급 JWT)을 브라우저(localStorage)에만 저장. IdP 없음(토큰은 외부 공급).
// 토큰 없으면 입력 화면, 있으면 콘솔. 조용한 401 루프 대신 명시적 접속 화면.
const KEY = "rpa.token";

export function clearToken(): void {
  localStorage.removeItem(KEY);
  location.reload();
}

// 세션 만료/무효 토큰(401) 전역 알림 — main.tsx의 QueryClient onError가 호출하고 TokenGate가 구독한다.
// 리액트 밖(쿼리 캐시)에서 나는 이벤트라 모듈 스코프 단일 리스너로 전달(외부 스토어 패턴). 게이트가 유일 구독자.
let authExpiredListener: (() => void) | null = null;
export function notifyAuthExpired(): void {
  authExpiredListener?.();
}

// 세션을 끊어야 하는 인증 실패만 판정: 토큰 없음/만료/무효(401, UNAUTHENTICATED).
// 권한 부족(403 AUTHZ_FORBIDDEN)은 화면별로 처리하고 여기서 세션을 끊지 않는다(조용한 false 금지 ≠ 과잉 로그아웃).
export function isAuthExpiredError(err: unknown): boolean {
  return err instanceof ApiError && (err.httpStatus === 401 || err.code === "UNAUTHENTICATED");
}

export function TokenGate({ children }: { children: ReactNode }): JSX.Element {
  const [token, setToken] = useState<string | null>(() => localStorage.getItem(KEY));
  const [emptyTried, setEmptyTried] = useState(false);
  const [expired, setExpired] = useState(false);

  // 전역 401 구독: 세션 만료 시 토큰 제거 + 게이트 노출(전체 리로드 대신 SPA 유지 — 자식 언마운트로 폴링도 멈춘다).
  useEffect(() => {
    authExpiredListener = (): void => {
      localStorage.removeItem(KEY);
      setExpired(true);
      setToken(null);
    };
    return () => {
      authExpiredListener = null;
    };
  }, []);

  if (token !== null && token !== "") return <>{children}</>;

  return (
    <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", background: "var(--bg)" }}>
      <form
        className="panel"
        style={{ padding: 24, width: 440, maxWidth: "90vw", display: "flex", flexDirection: "column", gap: 12 }}
        onSubmit={(e) => {
          e.preventDefault();
          const t = String(new FormData(e.currentTarget).get("token") ?? "").trim();
          if (t === "") {
            setEmptyTried(true); // 빈 값 제출을 조용히 무시하지 않고 명시 피드백(조용한 false 금지)
            return;
          }
          localStorage.setItem(KEY, t);
          setEmptyTried(false);
          setExpired(false);
          setToken(t);
        }}
      >
        <h1 style={{ fontSize: 18, margin: 0 }}>RPA 운영 콘솔 접속</h1>
        {expired && (
          <p className="form-alert red" role="alert" style={{ margin: 0 }}>
            세션이 만료되었거나 토큰이 유효하지 않습니다. 새 토큰으로 다시 접속하세요.
          </p>
        )}
        <p style={{ color: "var(--muted)", fontSize: 13, margin: 0 }}>
          발급받은 Bearer 토큰(JWT)을 입력하세요. 토큰은 이 브라우저에만 저장되며 서버로 별도 전송되지 않습니다.
        </p>
        <p style={{ color: "var(--muted)", fontSize: 12, margin: 0 }}>
          토큰은 관리자/IT 담당자가 발급합니다. 토큰이 없으면 담당자에게 콘솔 접속 토큰을 요청하세요.
        </p>
        <textarea
          name="token"
          rows={4}
          placeholder="eyJhbGciOi..."
          aria-label="Bearer 토큰"
          aria-invalid={emptyTried}
          spellCheck={false}
          onChange={() => {
            if (emptyTried) setEmptyTried(false);
          }}
          style={{ padding: 10, borderRadius: 8, border: "1px solid var(--line-strong)", fontFamily: "monospace", fontSize: 12 }}
        />
        {emptyTried && (
          <span className="form-alert red" role="alert" style={{ margin: 0 }}>
            토큰을 입력하세요.
          </span>
        )}
        <button className="btn primary" type="submit">
          접속
        </button>
      </form>
    </div>
  );
}
