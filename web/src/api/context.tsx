import { createContext, useContext, type ReactNode } from "react";

import type { ApiClient } from "./client";

const ApiClientContext = createContext<ApiClient | null>(null);

export function ApiClientProvider({ client, children }: { client: ApiClient; children: ReactNode }): JSX.Element {
  return <ApiClientContext.Provider value={client}>{children}</ApiClientContext.Provider>;
}

export function useApiClient(): ApiClient {
  const client = useContext(ApiClientContext);
  if (client === null) throw new Error("useApiClient: ApiClientProvider 누락");
  return client;
}
