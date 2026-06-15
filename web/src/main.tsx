import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { App } from "./App";
import { ApiClientProvider } from "./api/context";
import { createHttpApiClient } from "./api/client";
import "./styles.css";

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 5_000, refetchOnWindowFocus: false, retry: 1 } },
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
