import { ActionButton } from "../../components/ActionButton";
import type { SiteItem } from "../../api/types";

type SessionRenewalStatus = "missing" | "expiring" | "expired";

export interface SessionRenewalQueueItem {
  readonly site: SiteItem;
  readonly status: SessionRenewalStatus;
  readonly detail: string;
}

export function SessionRenewalQueue({
  items,
  canCapture,
  onOpenGuide,
  captureSession,
}: {
  items: readonly SessionRenewalQueueItem[];
  canCapture: boolean;
  onOpenGuide: (site: SiteItem) => void;
  captureSession: (siteId: string, key: string) => Promise<unknown>;
}): JSX.Element {
  return (
    <section className="panel session-renewal-queue" aria-label="로그인 세션 갱신 큐">
      <div className="panel-head">
        <h2>로그인 세션 갱신 큐</h2>
        <span className="badge amber">{items.length}건 확인 필요</span>
      </div>
      <div className="session-renewal-list">
        {items.map((item) => {
          const label = item.site.name ?? "사이트명 미정";
          return (
            <article key={item.site.site_profile_id} className="session-renewal-item">
              <div>
                <strong>{label}</strong>
                <span className="subtle">{item.detail}</span>
              </div>
              <span className={`badge ${item.status === "expired" ? "red" : "amber"}`}>{sessionRenewalStatusLabel(item.status)}</span>
              <div className="inline-actions">
                <ActionButton
                  label="세션 등록"
                  action="session.capture"
                  confirmText={`${label}에 로그인 창을 엽니다. 창에서 직접 로그인하시면 세션이 저장되어 이후 자동 실행이 재사용합니다.`}
                  run={(key) => captureSession(item.site.site_profile_id, key)}
                  invalidateKeys={[["sites"], ["capture-sessions", item.site.site_profile_id]]}
                />
                {canCapture && (
                  <button className="btn" type="button" onClick={() => onOpenGuide(item.site)}>
                    운영자 PC 등록
                  </button>
                )}
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

export function collectSessionRenewalQueue(sites: readonly SiteItem[]): SessionRenewalQueueItem[] {
  return sites
    .map((site) => sessionRenewalItem(site))
    .filter((item): item is SessionRenewalQueueItem => item !== null)
    .sort((a, b) => sessionRenewalRank(a.status) - sessionRenewalRank(b.status) || siteLabel(a.site).localeCompare(siteLabel(b.site), "ko-KR"));
}

function sessionRenewalItem(site: SiteItem): SessionRenewalQueueItem | null {
  if (site.login_capable !== true) return null;
  if (site.session_ready !== true) {
    return { site, status: "missing", detail: "로그인 세션이 없어 브라우저 실행 전에 등록이 필요합니다." };
  }
  if (site.session_expires_at === null || site.session_expires_at === undefined) return null;

  const expiresAt = Date.parse(site.session_expires_at);
  if (Number.isNaN(expiresAt)) return null;
  const remainingMs = expiresAt - Date.now();
  const thresholdMs = 24 * 60 * 60 * 1000;
  if (remainingMs <= 0) return { site, status: "expired", detail: `세션이 만료되었습니다. 만료 시각 ${formatDateTime(site.session_expires_at)}` };
  if (remainingMs <= thresholdMs) return { site, status: "expiring", detail: `세션 만료 임박 · ${formatDateTime(site.session_expires_at)}` };
  return null;
}

function sessionRenewalStatusLabel(status: SessionRenewalStatus): string {
  if (status === "missing") return "세션 미등록";
  if (status === "expired") return "세션 만료";
  return "만료 임박";
}

function sessionRenewalRank(status: SessionRenewalStatus): number {
  if (status === "expired") return 0;
  if (status === "missing") return 1;
  return 2;
}

function siteLabel(site: SiteItem): string {
  return site.name ?? site.url_pattern ?? site.site_profile_id;
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("ko-KR", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Seoul",
  }).format(date);
}
