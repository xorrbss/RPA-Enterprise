import { useQuery } from "@tanstack/react-query";

import { useApiClient } from "../../api/context";

// 자격증명 동시성 정책 가시화(D5) — 사이트·자격증명별 max_concurrency 와 현재 사용 슬롯(active_leases).
// 정책 미설정 시 빈 표기(기본 동시성 1). ops_alert.read 게이트는 SecurityView 에서 적용.
export function ConcurrencyPolicyPanel(): JSX.Element | null {
  const api = useApiClient();
  const q = useQuery({
    queryKey: ["concurrency-policies"],
    queryFn: () => api.listConcurrencyPolicies(),
    refetchInterval: 15_000,
  });
  if (q.isLoading || q.data === undefined) return null;
  const items = q.data.items;
  return (
    <section className="panel" aria-label="자격증명 동시성 정책" style={{ marginBottom: 12 }}>
      <div className="panel-head">
        <h2>자격증명 동시성 정책</h2>
        <span className="badge blue">{items.length}개 정책</span>
      </div>
      <p className="subtle">
        사이트·자격증명별 동시 실행 한도와 현재 사용 중인 슬롯입니다. 정책이 없으면 기본 동시성 1이 적용됩니다.
      </p>
      {items.length === 0 ? (
        <p className="subtle">설정된 동시성 정책이 없습니다(모든 자격증명에 기본 동시성 1 적용).</p>
      ) : (
        <div className="table-wrap">
          <table className="ops-table">
            <thead>
              <tr>
                <th scope="col">사이트</th>
                <th scope="col">자격증명</th>
                <th scope="col">최대 동시 실행</th>
                <th scope="col">현재 사용</th>
                <th scope="col">여유</th>
              </tr>
            </thead>
            <tbody>
              {items.map((p) => {
                const free = p.max_concurrency - p.active_leases;
                const saturated = free <= 0;
                return (
                  <tr key={`${p.credential_ref}:${p.site_profile_id}`}>
                    <td>{p.site_name ?? <code className="subtle">{p.site_profile_id}</code>}</td>
                    <td>
                      <code className="subtle">{p.credential_ref}</code>
                    </td>
                    <td>{p.max_concurrency}</td>
                    <td>{p.active_leases}</td>
                    <td>
                      <span className={`badge ${saturated ? "amber" : "green"}`}>
                        {saturated ? "포화" : `${free} 여유`}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
