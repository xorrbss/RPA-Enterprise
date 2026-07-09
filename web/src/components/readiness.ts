import type { Paginated, RunItem, SiteItem } from "../api/types";

export type ReadinessStatus = "ready" | "needs" | "blocked" | "checking" | "deferred";
export type ReadinessTone = "green" | "amber" | "red" | "blue" | "muted";

export interface ReadinessDecision {
  readonly status: ReadinessStatus;
  readonly tone: ReadinessTone;
  readonly detail: string;
  readonly count?: number;
  readonly siteId?: string;
}

export interface ReadinessQuery<T> {
  readonly isLoading?: boolean;
  readonly isFetching?: boolean;
  readonly isError?: boolean;
  readonly data?: T;
}

export const READINESS_LABELS: Readonly<Record<ReadinessStatus, string>> = {
  ready: "준비됨",
  needs: "확인 필요",
  blocked: "차단",
  checking: "확인 중",
  deferred: "보류",
};

export function readinessTone(status: ReadinessStatus): ReadinessTone {
  switch (status) {
    case "ready":
      return "green";
    case "blocked":
      return "red";
    case "checking":
      return "blue";
    case "deferred":
      return "muted";
    case "needs":
      return "amber";
  }
}

export function originOf(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}

export function assessSiteCollectionReadiness(sites: readonly SiteItem[]): ReadinessDecision {
  const approved = sites.filter((site) => site.approval_status === "approved");
  if (approved.length > 0) {
    return {
      status: "ready",
      tone: "green",
      detail: `${approved.length}개 승인된 실행 대상 사이트가 있습니다.`,
      count: approved.length,
    };
  }
  if (sites.length > 0) {
    return {
      status: "blocked",
      tone: "red",
      detail: "등록된 사이트가 있지만 아직 승인된 실행 대상은 없습니다.",
      count: sites.length,
    };
  }
  return {
    status: "needs",
    tone: "amber",
    detail: "첫 자동화를 실행할 대상 사이트를 먼저 등록하세요.",
    count: 0,
  };
}

export function assessLoginSessionReadiness(sites: readonly SiteItem[]): ReadinessDecision {
  const loginSites = sites.filter((site) => site.approval_status === "approved" && site.login_capable === true);
  if (loginSites.length === 0) {
    return {
      status: "deferred",
      tone: "muted",
      detail: "로그인 세션이 필요한 승인 사이트가 아직 없습니다.",
      count: 0,
    };
  }
  const missingSession = loginSites.find((site) => site.session_ready !== true);
  if (missingSession !== undefined) {
    return {
      status: "needs",
      tone: "amber",
      detail: `${missingSession.name ?? "대상 사이트"} 세션 등록이 필요합니다.`,
      siteId: missingSession.site_profile_id,
    };
  }
  return {
    status: "ready",
    tone: "green",
    detail: "로그인이 필요한 승인 사이트의 세션이 준비되어 있습니다.",
    count: loginSites.length,
  };
}

export function assessTargetSiteReadiness(
  targetUrls: readonly string[],
  sites: ReadinessQuery<Paginated<SiteItem>>,
): ReadinessDecision {
  if (targetUrls.length === 0) {
    return { status: "ready", tone: "blue", detail: "대상 사이트 이동이 없는 자동화입니다." };
  }

  const origins = targetUrls.map(originOf);
  if (origins.some((origin) => origin === null)) {
    return { status: "blocked", tone: "red", detail: "실행 대상 주소를 확인할 수 없습니다." };
  }
  if (sites.isError === true) {
    return { status: "needs", tone: "amber", detail: "사이트 목록을 불러오지 못했습니다. 실행 시 서버가 최종 판정합니다." };
  }
  if (sites.isLoading === true || sites.data === undefined) {
    return { status: "checking", tone: "blue", detail: "등록 사이트와 세션 상태를 확인하는 중입니다." };
  }

  const siteItems = sites.data.items;
  const matched = origins.map((origin) => siteItems.find((site) => originOf(site.url_pattern ?? "") === origin));
  if (matched.some((site) => site === undefined)) {
    return {
      status: "needs",
      tone: "amber",
      detail: "등록된 사이트와 매칭되지 않는 실행 주소가 있습니다. 사이트/세션 설정에서 대상 사이트를 등록하세요.",
    };
  }

  const concrete = matched.filter((site): site is SiteItem => site !== undefined);
  const unapproved = concrete.find((site) => site.approval_status !== "approved");
  if (unapproved !== undefined) {
    return {
      status: "blocked",
      tone: "red",
      detail: `${unapproved.name ?? "대상 사이트"} 승인 전에는 실행할 수 없습니다.`,
    };
  }

  const openCircuit = concrete.find((site) => site.circuit_status !== "closed");
  if (openCircuit !== undefined) {
    return {
      status: "blocked",
      tone: "red",
      detail: `${openCircuit.name ?? "대상 사이트"} 자동 차단 상태가 ${circuitStatusLabel(openCircuit.circuit_status)}입니다.`,
    };
  }

  const needsSession = concrete.find((site) => site.login_capable === true && site.session_ready !== true);
  if (needsSession !== undefined) {
    return {
      status: "needs",
      tone: "amber",
      detail: `${needsSession.name ?? "대상 사이트"}은 로그인이 필요합니다. 세션을 등록하세요.`,
      siteId: needsSession.site_profile_id,
    };
  }

  return { status: "ready", tone: "green", detail: "대상 사이트 승인, 자동 차단, 세션 상태가 준비되어 있습니다." };
}

export function assessTestRunReadiness(runs: readonly RunItem[]): ReadinessDecision {
  const testRuns = runs.filter((run) => run.run_mode === "test");
  const completed = testRuns.filter((run) => run.status === "completed");
  if (completed.length > 0) {
    return {
      status: "ready",
      tone: "green",
      detail: `${completed.length}개 성공한 테스트 실행 이력이 있습니다.`,
      count: completed.length,
    };
  }

  const latest = testRuns[0];
  if (latest === undefined) {
    return {
      status: "needs",
      tone: "amber",
      detail: "저장된 초안으로 계획을 확인하고 테스트하세요.",
      count: 0,
    };
  }
  if (latest.status === "failed_business" || latest.status === "failed_system") {
    return {
      status: "blocked",
      tone: "red",
      detail: `최근 테스트가 ${runStatusLabel(latest.status)} 상태입니다. 실패 원인을 확인한 뒤 다시 테스트하세요.`,
    };
  }
  if (latest.status === "cancelled") {
    return {
      status: "needs",
      tone: "amber",
      detail: "최근 테스트가 취소되었습니다. 성공한 테스트 실행이 필요합니다.",
    };
  }
  return {
    status: "checking",
    tone: "blue",
    detail: `최근 테스트가 ${runStatusLabel(latest.status)} 상태입니다. 완료 후 결과를 확인하세요.`,
  };
}

export function circuitStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    closed: "정상",
    open: "차단 중",
    half_open: "복구 확인 중",
  };
  return labels[status] ?? "확인 필요";
}

export function runStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    queued: "대기 중",
    claimed: "할당됨",
    running: "실행 중",
    suspended: "일시 중지",
    resume_requested: "재개 요청",
    resuming: "재개 중",
    completing: "완료 처리 중",
    completed: "완료",
    aborting: "취소 중",
    cancelled: "취소됨",
    failed_business: "업무 실패",
    failed_system: "시스템 실패",
  };
  return labels[status] ?? status;
}
