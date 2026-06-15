import { useQuery } from "@tanstack/react-query";

import { useApiClient } from "../api/context";
import { ErrorState, Loading } from "../components/states";
import { ApiError } from "../api/types";

export function GatewayView(): JSX.Element {
  const api = useApiClient();
  const query = useQuery({ queryKey: ["gateway-policy"], queryFn: () => api.getGatewayPolicy(), retry: false });

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>AI 모델 정책</h2>
      </div>
      <div className="panel-body" style={{ padding: 16 }}>
        {query.isLoading ? (
          <Loading />
        ) : query.isError ? (
          query.error instanceof ApiError && query.error.code === "IR_SCHEMA_INVALID" ? (
            <p style={{ color: "var(--muted)" }}>여러 모델 정책이 있습니다. 모델을 선택하면 상세가 표시됩니다.</p>
          ) : (
            <ErrorState message={messageOf(query.error)} onRetry={() => void query.refetch()} />
          )
        ) : (
          <dl className="metrics" style={{ margin: 0 }}>
            <div className="metric">
              <div className="label">모델</div>
              <div className="value" style={{ fontSize: 18 }}>{query.data?.model}</div>
            </div>
            <div className="metric">
              <div className="label">capabilities</div>
              <pre style={{ margin: 0, fontSize: 12 }}>{JSON.stringify(query.data?.capabilities ?? {}, null, 2)}</pre>
            </div>
            <div className="metric">
              <div className="label">budget</div>
              <pre style={{ margin: 0, fontSize: 12 }}>{JSON.stringify(query.data?.budget ?? {}, null, 2)}</pre>
            </div>
          </dl>
        )}
      </div>
    </section>
  );
}

function messageOf(err: unknown): string {
  if (err instanceof ApiError) return `${err.code} (${err.httpStatus})`;
  return err instanceof Error ? err.message : "오류";
}
