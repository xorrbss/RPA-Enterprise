import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";

import { useApiClient } from "../api/context";
import { useCan } from "../api/permissions";
import { formatDateTime } from "../util/time";

// 오프보딩 전역 배너(설계 O3) — approved/purging 원장이 있으면 모든 화면 상단에 경고를 고정한다.
// 출처는 /v1/capabilities.offboarding(전 역할 가시) — 쓰기 명령 409(TENANT_OFFBOARDING)의 이유를 화면이 설명한다.
// 취소 버튼은 admin(tenant_data.purge.request)에게만, approved(유예 중)에서만 — purging 진입 후엔 취소 불가
// (서버 게이트와 같은 조건만 노출; pending 은 아직 잠금 전이라 배너 없음 — 승인 대기는 보안 허브에서 관리).
export function OffboardingBanner(): JSX.Element | null {
  const api = useApiClient();
  const can = useCan();
  const queryClient = useQueryClient();
  const capabilities = useQuery({ queryKey: ["capabilities"], queryFn: () => api.getCapabilities(), retry: false });
  const cancel = useMutation({
    mutationFn: (requestId: string) => api.cancelOffboardingPurgeRequest(requestId, crypto.randomUUID()),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["capabilities"] });
      void queryClient.invalidateQueries({ queryKey: ["offboarding-purge-requests"] });
    },
  });
  const offboarding = capabilities.data?.offboarding;
  if (offboarding?.active !== true) return null;
  if (offboarding.status !== "approved" && offboarding.status !== "purging") return null;
  const purgeAfter = offboarding.purge_after ?? null;
  const requestId = offboarding.request_id ?? null;
  const canCancel = offboarding.status === "approved" && requestId !== null && can("tenant_data.purge.request");
  return (
    <div className="arrival-banner badge red" role="alert">
      <AlertTriangle size={16} aria-hidden="true" />
      <span>
        {offboarding.status === "purging"
          ? "이 테넌트는 오프보딩 영구 삭제가 진행 중입니다. 새 작업은 만들 수 없습니다."
          : purgeAfter !== null
            ? `이 테넌트는 오프보딩 진행 중입니다 — ${formatDateTime(purgeAfter)} 이후 데이터가 영구 삭제됩니다. 새 작업은 만들 수 없습니다.`
            : "이 테넌트는 오프보딩 진행 중입니다 — 유예기간 경과 후 데이터가 영구 삭제됩니다. 새 작업은 만들 수 없습니다."}
      </span>
      {canCancel && (
        <button
          type="button"
          className="btn"
          onClick={() => cancel.mutate(requestId)}
          disabled={cancel.isPending}
        >
          {cancel.isPending ? "취소 처리 중…" : "오프보딩 취소"}
        </button>
      )}
      {cancel.isError && <span role="status">취소가 실패했습니다 — 보안·개인정보 화면에서 원장 상태를 확인하세요.</span>}
    </div>
  );
}
