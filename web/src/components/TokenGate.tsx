import { useEffect, useState, type ReactNode } from "react";

import { ApiError } from "../api/types";

// 토큰 게이트 — Bearer 토큰(외부 발급 JWT)을 브라우저(localStorage)에만 저장. IdP 없음(토큰은 외부 공급).
// 토큰 없으면 입력 화면, 있으면 콘솔. 조용한 401 루프 대신 명시적 접속 화면.
const KEY = "rpa.token";
const REDIRECT_TOKEN_KEYS = ["id_token", "access_token", "token"] as const;

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
  const oidcAuthUrl = oidcLoginUrl();

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

  useEffect(() => {
    const redirectedToken = readRedirectToken();
    if (redirectedToken === null) return;
    localStorage.setItem(KEY, redirectedToken);
    clearRedirectTokenFromUrl();
    setEmptyTried(false);
    setExpired(false);
    setToken(redirectedToken);
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
            세션이 만료되었거나 접속 권한을 확인할 수 없습니다. 새 접속 코드로 다시 접속하세요.
          </p>
        )}
        <p style={{ color: "var(--muted)", fontSize: 13, margin: 0 }}>
          발급받은 운영 콘솔 접속 코드를 입력하면 현재 권한을 확인합니다. 접속 코드는 이 브라우저에 저장되고 API 요청의 권한 확인에만 사용됩니다.
        </p>
        <p style={{ color: "var(--muted)", fontSize: 12, margin: 0 }}>
          접속 코드는 관리자 또는 IT 담당자가 발급합니다. 코드가 없으면 담당자에게 운영 콘솔 접속 권한을 요청하세요.
        </p>
        {oidcAuthUrl !== null && (
          <a className="btn primary" href={oidcAuthUrl}>
            SSO로 로그인
          </a>
        )}
        <textarea
          name="token"
          rows={4}
          placeholder="접속 코드를 붙여넣으세요"
          aria-label="접속 코드"
          aria-invalid={emptyTried}
          spellCheck={false}
          onChange={() => {
            if (emptyTried) setEmptyTried(false);
          }}
          style={{ padding: 10, borderRadius: 8, border: "1px solid var(--line-strong)", fontFamily: "monospace", fontSize: 12 }}
        />
        {emptyTried && (
          <span className="form-alert red" role="alert" style={{ margin: 0 }}>
            접속 코드를 입력하세요.
          </span>
        )}
        <button className="btn primary" type="submit">
          운영 콘솔 접속
        </button>
      </form>
    </div>
  );
}

function oidcLoginUrl(): string | null {
  const value = import.meta.env.VITE_OIDC_AUTH_URL;
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readRedirectToken(): string | null {
  // 보안(적대감사 #C1): 리디렉션 토큰은 **fragment(hash)만** 수용한다. 쿼리스트링 토큰은 GET request-line 으로 서버/프록시
  //   access-log·브라우저 히스토리에 평문 기록되고(RFC6750 §5.3·OWASP), URL 스크럽은 초기 GET 이후라 이미 늦다 → 쿼리 분기 제거.
  const rawHash = window.location.hash.startsWith("#") ? window.location.hash.slice(1) : window.location.hash;
  if (rawHash.length === 0) return null;
  return tokenFromParams(new URLSearchParams(rawHash));
}

function tokenFromParams(params: URLSearchParams): string | null {
  for (const key of REDIRECT_TOKEN_KEYS) {
    const value = params.get(key);
    if (value !== null && value.trim().length > 0) return value.trim();
  }
  return null;
}

function clearRedirectTokenFromUrl(): void {
  const url = new URL(window.location.href);
  let changed = false;

  for (const key of REDIRECT_TOKEN_KEYS) {
    if (url.searchParams.has(key)) {
      url.searchParams.delete(key);
      changed = true;
    }
  }

  const rawHash = url.hash.startsWith("#") ? url.hash.slice(1) : url.hash;
  if (rawHash.length > 0) {
    const hashParams = new URLSearchParams(rawHash);
    let hashChanged = false;
    for (const key of REDIRECT_TOKEN_KEYS) {
      if (hashParams.has(key)) {
        hashParams.delete(key);
        hashChanged = true;
      }
    }
    if (hashChanged) {
      const nextHash = hashParams.toString();
      url.hash = nextHash.length > 0 ? nextHash : "";
      changed = true;
    }
  }

  if (changed) {
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }
}
