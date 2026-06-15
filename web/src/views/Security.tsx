import { useQuery } from "@tanstack/react-query";

import { useApiClient } from "../api/context";
import { QueryPanel } from "../components/QueryPanel";
import { StatusBadge } from "../components/badges";
import type { SiteItem } from "../api/types";

export function SecurityView(): JSX.Element {
  const api = useApiClient();
  const query = useQuery({ queryKey: ["sites"], queryFn: () => api.listSites({ limit: 50 }), refetchInterval: 10_000 });
  return (
    <QueryPanel<SiteItem>
      title="사이트 접근 정책"
      query={query}
      rowKey={(r) => r.site_profile_id}
      emptyMessage="등록된 사이트 프로파일이 없습니다."
      columns={[
        { header: "사이트", render: (r) => r.name ?? r.site_profile_id.slice(0, 8) },
        { header: "위험도", render: (r) => <StatusBadge status={r.risk} /> },
        { header: "승인", render: (r) => <StatusBadge status={r.approval_status} /> },
        { header: "서킷", render: (r) => <StatusBadge status={r.circuit_status} /> },
      ]}
    />
  );
}
