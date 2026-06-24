import { useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { useApiClient } from "../../api/context";
import { useCan } from "../../api/permissions";
import type { CaptureSessionItem, SiteItem } from "../../api/types";

export function SessionCaptureStatus({ site }: { site: SiteItem }): JSX.Element | null {
  const api = useApiClient();
  const can = useCan();
  const [open, setOpen] = useState(false);
  const query = useQuery({
    queryKey: ["capture-sessions", site.site_profile_id],
    queryFn: () => api.listSessionCaptures(site.site_profile_id),
    enabled: open && can("session.capture"),
    refetchInterval: open ? 5_000 : false,
  });

  if (!can("session.capture")) return null;
  const name = site.name ?? "사이트명 미정";
  return (
    <span className="capture-status">
      <button className="btn" type="button" onClick={() => setOpen((value) => !value)}>
        {open ? "상태 닫기" : "상태 보기"}
      </button>
      {open && (
        <span className="capture-status-panel" role="region" aria-label={`세션 등록 상태 — ${name}`}>
          <span className="capture-status-head">
            <strong>최근 세션 등록</strong>
            <button className="btn" type="button" onClick={() => void query.refetch()} disabled={query.isFetching}>
              새로고침
            </button>
          </span>
          {query.isLoading ? (
            <span className="subtle">상태를 불러오는 중…</span>
          ) : query.isError ? (
            <span className="badge red" role="alert">상태를 불러오지 못했습니다</span>
          ) : (query.data?.items.length ?? 0) === 0 ? (
            <span className="subtle">최근 세션 등록 이력이 없습니다.</span>
          ) : (
            <span className="capture-status-list">
              {(query.data?.items ?? []).slice(0, 5).map((item) => (
                <CaptureSessionRow key={item.capture_session_id} item={item} />
              ))}
            </span>
          )}
        </span>
      )}
    </span>
  );
}

function CaptureSessionRow({ item }: { item: CaptureSessionItem }): JSX.Element {
  const detailSummary = captureDetailSummary(item);
  return (
    <span className="capture-status-row">
      <span className={`badge ${captureStatusTone(item.status)}`}>{captureStatusLabel(item.status)}</span>
      <span className="subtle">등록 요청</span>
      <span className="subtle">{formatCaptureTime(item.updated_at)}</span>
      {detailSummary !== null && <span className="subtle" title={item.detail ?? undefined}>{detailSummary}</span>}
    </span>
  );
}

function captureDetailSummary(item: CaptureSessionItem): string | null {
  if (item.detail === null || item.detail.trim() === "") return null;
  switch (item.status) {
    case "launching":
      return "로그인 창을 여는 중입니다.";
    case "awaiting_login":
      return "운영자 로그인을 기다리는 중입니다.";
    case "capturing":
      return "로그인 세션을 저장하는 중입니다.";
    case "captured":
      return "저장된 세션을 실행에 사용할 수 있습니다.";
    case "failed":
      return "등록 실패 사유를 확인하세요.";
    case "expired":
      return "등록 시간이 만료됐습니다.";
  }
}

function captureStatusTone(status: CaptureSessionItem["status"]): "green" | "amber" | "red" | "blue" {
  if (status === "captured") return "green";
  if (status === "failed" || status === "expired") return "red";
  if (status === "awaiting_login") return "amber";
  return "blue";
}

function captureStatusLabel(status: CaptureSessionItem["status"]): string {
  switch (status) {
    case "launching":
      return "창 여는 중";
    case "awaiting_login":
      return "로그인 대기";
    case "capturing":
      return "저장 중";
    case "captured":
      return "등록 완료";
    case "failed":
      return "실패";
    case "expired":
      return "만료";
  }
}

function formatCaptureTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("ko-KR", { dateStyle: "short", timeStyle: "short" });
}
