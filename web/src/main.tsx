import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { App } from "./App";
import { ApiClientProvider } from "./api/context";
import { createHttpApiClient } from "./api/client";
import { isAuthExpiredError, notifyAuthExpired } from "./components/TokenGate";
import "./styles.css";

// 전역 인증 실패(401/만료·무효 토큰) 처리 — 모든 read/명령 쿼리의 401을 한 곳에서 잡아 세션 만료를 알린다
// (각 화면이 '인증이 필요합니다'만 반복 노출하던 것 → 접속 화면으로 단일 유도). 권한부족(403)은 영향 없음.
function handleAuthError(err: unknown): void {
  if (isAuthExpiredError(err)) notifyAuthExpired();
}

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 5_000, refetchOnWindowFocus: false, retry: 1 } },
  queryCache: new QueryCache({ onError: handleAuthError }),
  mutationCache: new MutationCache({ onError: handleAuthError }),
});

// 실시간 갱신은 v1=outbox tail 폴링(architecture §6) — 각 read 쿼리가 refetchInterval로 주기 폴링.
const apiClient = createHttpApiClient({
  baseUrl: import.meta.env.VITE_API_BASE_URL ?? "/api",
  getToken: () => localStorage.getItem("rpa.token"),
});

const rootEl = document.getElementById("root");
if (rootEl === null) throw new Error("root element missing");

createRoot(rootEl).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ApiClientProvider client={apiClient}>
        <App />
      </ApiClientProvider>
    </QueryClientProvider>
  </StrictMode>,
);
