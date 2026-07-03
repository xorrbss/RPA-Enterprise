import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useApiClient } from "../api/context";
import { useCan, useSubject } from "../api/permissions";
import type { OffboardingPurgeRequestItem } from "../api/types";
import { formatDateTime } from "../util/time";

// 보안 허브 '오프보딩' 섹션(설계 O5, admin 전용 표면) — ① 반출 안내(스크립트 명령 복사, CaptureGuide 패턴)
// ② 삭제 요청 폼(사유 필수, maker) ③ pending 승인/반려(SoD: 요청자 본인 버튼 비활성) ④ approved 카운트다운+취소
// ⑤ purged 처분 요약(held_rows = legal_hold 증거 잔존 보고). 서버 게이트(RBAC/SoD/UNIQUE)가 최종 판정 — UI 는 미러.
const STATUS_LABELS: Readonly<Record<OffboardingPurgeRequestItem["status"], string>> = {
  pending: "승인 대기",
  approved: "유예 중(영구 삭제 예정)",
  rejected: "반려됨",
  cancelled: "취소됨",
  purging: "삭제 진행 중",
  purged: "삭제 완료",
};

const STATUS_BADGE: Readonly<Record<OffboardingPurgeRequestItem["status"], string>> = {
  pending: "amber",
  approved: "red",
  rejected: "muted",
  cancelled: "muted",
  purging: "red",
  purged: "blue",
};

function resolveApiBase(): string {
  const raw = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "/api";
  const trimmed = raw.replace(/\/+$/, "");
  if (/^https?:\/\//.test(trimmed)) return trimmed;
  return `${location.origin}${trimmed.startsWith("/") ? "" : "/"}${trimmed}`;
}

const codeBlockStyle = {
  display: "block",
  whiteSpace: "pre-wrap" as const,
  wordBreak: "break-all" as const,
  background: "var(--panel-2, rgba(0,0,0,0.06))",
  borderRadius: 6,
  padding: "8px 10px",
  fontSize: 12,
};

function daysUntil(iso: string | null): number | null {
  if (iso === null) return null;
  const ms = Date.parse(iso) - Date.now();
  if (Number.isNaN(ms)) return null;
  return Math.max(0, Math.ceil(ms / (24 * 60 * 60 * 1000)));
}

function heldRowsSummary(held: Readonly<Record<string, number>>): string {
  const entries = Object.entries(held).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return "잔존 없음(전량 삭제)";
  return entries.map(([table, count]) => `${table} ${count}행`).join(" · ");
}

export function OffboardingPanel(): JSX.Element {
  const api = useApiClient();
  const can = useCan();
  const subject = useSubject();
  const queryClient = useQueryClient();
  const [reason, setReason] = useState("");
  const [copied, setCopied] = useState(false);

  const ledger = useQuery({
    queryKey: ["offboarding-purge-requests"],
    queryFn: () => api.listOffboardingPurgeRequests(),
    retry: false,
  });
  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: ["offboarding-purge-requests"] });
    void queryClient.invalidateQueries({ queryKey: ["capabilities"] });
  };
  const request = useMutation({
    mutationFn: (requestReason: string) => api.createOffboardingPurgeRequest(requestReason, crypto.randomUUID()),
    onSuccess: () => {
      setReason("");
      invalidate();
    },
  });
  const decide = useMutation({
    mutationFn: (input: { requestId: string; decision: "approved" | "rejected" }) =>
      api.decideOffboardingPurgeRequest(input.requestId, input.decision, crypto.randomUUID()),
    onSuccess: invalidate,
  });
  const cancel = useMutation({
    mutationFn: (requestId: string) => api.cancelOffboardingPurgeRequest(requestId, crypto.randomUUID()),
    onSuccess: invalidate,
  });

  const items = ledger.data?.items ?? [];
  const graceDays = ledger.data?.grace_days ?? 7;
  const active = items.find((item) => item.status === "pending" || item.status === "approved" || item.status === "purging") ?? null;
  const canRequest = can("tenant_data.purge.request");
  const canApprove = can("tenant_data.purge.approve");

  const downloadCommandPs = `$env:RPA_OPERATOR_TOKEN="<본인 접속 코드>"; node scripts/offboarding-download.mjs --api ${resolveApiBase()} --out .\\offboarding-package`;
  const downloadCommandSh = `RPA_OPERATOR_TOKEN="<본인 접속 코드>" node scripts/offboarding-download.mjs --api ${resolveApiBase()} --out ./offboarding-package`;

  async function copyCommand(): Promise<void> {
    try {
      await navigator.clipboard.writeText(downloadCommandPs);
      setCopied(true);
    } catch {
      setCopied(false); // 클립보드 미허용 환경 — 아래 코드 블록에서 직접 선택·복사.
    }
  }

  return (
    <section className="panel" aria-label="오프보딩(데이터 반출·삭제)">
      <div className="panel-head">
        <div>
          <h2>오프보딩 — 데이터 반출과 영구 삭제</h2>
          <p className="subtle">
            나갈 때 업무 원문을 돌려받고(반출), 승인 2인(요청자≠승인자) 게이트를 거쳐 유예 {graceDays}일 후
            테넌트 데이터를 영구 삭제합니다. 유예 중에는 새 작업이 잠기고, 언제든 취소할 수 있습니다.
          </p>
        </div>
      </div>

      <details style={{ marginBottom: 12 }}>
        <summary>① 데이터 반출 안내 — 삭제 전에 원문 패키지를 내려받으세요</summary>
        <div style={{ padding: "8px 4px" }}>
          <ol className="subtle" style={{ paddingLeft: 18, marginBottom: 8 }}>
            <li>관리자 접속 코드(admin)를 준비합니다.</li>
            <li>운영자 PC(Node 18+)의 저장소 폴더에서 아래 명령을 실행합니다 — 실행 목록 CSV, 실행 입력·사람 확인 원문(JSON Lines), 첨부 파일 전량과 목록(manifest)이 저장됩니다.</li>
            <li>결과 폴더(offboarding-package)의 manifest.json 으로 건수·누락을 확인합니다. 실패가 있으면 명령이 실패 코드로 끝납니다.</li>
          </ol>
          <button className="btn" type="button" onClick={() => void copyCommand()}>
            {copied ? "복사됨" : "PowerShell 명령 복사"}
          </button>
          <code style={codeBlockStyle}>{downloadCommandPs}</code>
          <p className="subtle" style={{ margin: "6px 0 2px" }}>macOS/Linux:</p>
          <code style={codeBlockStyle}>{downloadCommandSh}</code>
          <p className="subtle" style={{ marginTop: 6 }}>
            자격증명·쿠키·실행 재개용 내부 데이터는 어떤 반출에도 포함되지 않으며, 첨부 파일은 마스킹 완료본만
            내려받을 수 있습니다(원본 불가).
          </p>
        </div>
      </details>

      {active === null ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const trimmed = reason.trim();
            if (trimmed.length === 0) return;
            request.mutate(trimmed);
          }}
          style={{ marginBottom: 12 }}
          aria-label="삭제 요청 폼"
        >
          <label htmlFor="offboarding-reason"><strong>② 영구 삭제 요청(사유 필수)</strong></label>
          <p className="subtle" style={{ margin: "2px 0 6px" }}>
            다른 관리자 1인의 승인 후 유예 {graceDays}일이 지나면 되돌릴 수 없습니다. 반출을 먼저 완료하세요.
          </p>
          <textarea
            id="offboarding-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            rows={2}
            style={{ width: "100%", marginBottom: 6 }}
            placeholder="예: 계약 종료에 따른 테넌트 철수"
            disabled={!canRequest || request.isPending}
          />
          <button className="btn danger" type="submit" disabled={!canRequest || request.isPending || reason.trim().length === 0}>
            {request.isPending ? "요청 중…" : "영구 삭제 요청"}
          </button>
          {!canRequest && <p className="subtle">삭제 요청은 관리자만 할 수 있습니다.</p>}
          {request.isError && <p role="status" className="subtle">요청이 거부되었습니다 — 이미 진행 중인 요청이 있는지 확인하세요.</p>}
        </form>
      ) : (
        <p className="subtle" style={{ marginBottom: 12 }} role="status">
          진행 중인 요청이 있어 새 요청을 만들 수 없습니다(테넌트당 1건).
        </p>
      )}

      <table className="table" aria-label="오프보딩 원장">
        <thead>
          <tr>
            <th>상태</th>
            <th>사유</th>
            <th>요청자</th>
            <th>결정</th>
            <th>처분</th>
            <th>동작</th>
          </tr>
        </thead>
        <tbody>
          {ledger.isLoading && (
            <tr><td colSpan={6} className="subtle">불러오는 중…</td></tr>
          )}
          {!ledger.isLoading && items.length === 0 && (
            <tr><td colSpan={6} className="subtle">오프보딩 요청이 없습니다.</td></tr>
          )}
          {items.map((item) => {
            const isRequester = subject !== null && item.requested_by === subject;
            const remainingDays = daysUntil(item.purge_after);
            return (
              <tr key={item.request_id}>
                <td><span className={`badge ${STATUS_BADGE[item.status]}`}>{STATUS_LABELS[item.status]}</span></td>
                <td>{item.reason}</td>
                <td>{item.requested_by}</td>
                <td className="subtle">
                  {item.decided_by !== null
                    ? `${item.decided_by} · ${formatDateTime(item.decided_at)}${item.decision_reason !== null ? ` · ${item.decision_reason}` : ""}`
                    : "—"}
                </td>
                <td className="subtle">
                  {item.status === "approved" && item.purge_after !== null && (
                    <span>
                      {formatDateTime(item.purge_after)} 영구 삭제
                      {remainingDays !== null ? ` (약 ${remainingDays}일 남음)` : ""}
                    </span>
                  )}
                  {item.status === "purging" && <span>영구 삭제 작업이 진행 중입니다.</span>}
                  {item.status === "purged" && (
                    <span>
                      {formatDateTime(item.purged_at)} 완료 · 잔존: {heldRowsSummary(item.held_rows)}
                      {Object.keys(item.held_rows).length > 0 ? " (보존 의무 잠금 증거)" : ""}
                    </span>
                  )}
                  {(item.status === "pending" || item.status === "rejected" || item.status === "cancelled") && "—"}
                </td>
                <td>
                  {item.status === "pending" && (
                    <span style={{ display: "inline-flex", gap: 6 }}>
                      <button
                        className="btn"
                        type="button"
                        disabled={!canApprove || isRequester || decide.isPending}
                        title={isRequester ? "요청자 본인은 승인/반려할 수 없습니다(2인 원칙)." : undefined}
                        onClick={() => decide.mutate({ requestId: item.request_id, decision: "approved" })}
                      >
                        승인
                      </button>
                      <button
                        className="btn"
                        type="button"
                        disabled={!canApprove || isRequester || decide.isPending}
                        title={isRequester ? "요청자 본인은 승인/반려할 수 없습니다(2인 원칙)." : undefined}
                        onClick={() => decide.mutate({ requestId: item.request_id, decision: "rejected" })}
                      >
                        반려
                      </button>
                    </span>
                  )}
                  {item.status === "approved" && (
                    <button
                      className="btn"
                      type="button"
                      disabled={!canRequest || cancel.isPending}
                      onClick={() => cancel.mutate(item.request_id)}
                    >
                      {cancel.isPending ? "취소 중…" : "오프보딩 취소"}
                    </button>
                  )}
                  {(item.status === "purging" || item.status === "purged" || item.status === "rejected" || item.status === "cancelled") && (
                    <span className="subtle">—</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {(decide.isError || cancel.isError) && (
        <p role="status" className="subtle" style={{ marginTop: 6 }}>
          처리에 실패했습니다 — 권한(2인 원칙)과 요청 상태를 확인하세요.
        </p>
      )}
      <p className="subtle" style={{ marginTop: 8 }}>
        승인·반려·취소·삭제는 모두 감사 로그에 남습니다. 보존 의무(legal hold)가 걸린 증거는 삭제에서 제외되고
        잔존 목록으로 보고됩니다.
      </p>
    </section>
  );
}
