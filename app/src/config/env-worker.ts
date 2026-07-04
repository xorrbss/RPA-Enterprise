import { parseOpsAlertRoutes, type OpsAlertRoute } from "../runtime/ops-alert-routes";
import {
  bool,
  loadVaultIdentity,
  num,
  opt,
  positiveInt,
  req,
  strictBool,
  type VaultIdentityConfig,
} from "./env-primitives";
import type { CommonConfig } from "./env";

export interface WorkerConfig {
  /** Stable workers.id for run_claim/run_resume/lease ownership. Must already exist in the infra workers table. */
  readonly workerId: string;
  /** AppRole identity for the runtime-worker (least-privilege: resume_token_hmac, executor). */
  readonly vaultRuntimeWorker: VaultIdentityConfig;
  /** SecretRef for the active resume-token HMAC signing key (HmacResumeTokenCodec). */
  readonly resumeTokenRef: string;
  /** SecretRef for the active browser session AES-256-GCM data key (base64/base64url encoded 32 bytes). */
  readonly browserSessionKeyRef: string;
  readonly graphileSchema?: string;
  readonly graphileMigrationsMode: "runtime" | "external";
  readonly graphileConcurrency: number;
  readonly graphilePollIntervalMs: number;
  /** DG-3: 이 워커가 서비스하는 전용 풀 키(WORKER_POOL_KEYS, csv). 빈 값이면 'default' 풀만 서비스. */
  readonly workerPoolKeys: readonly string[];
  readonly maintenanceTenantIds: readonly string[];
  /** Dedicated non-superuser BYPASSRLS pool used only for cross-tenant maintenance/lifecycle discovery. */
  readonly maintenanceLifecycleDatabaseUrl?: string;
  /** S4a: env-sourced ops-alert auto-fire routing rules (OPS_ALERT_ROUTES). Empty = no automatic notifications. */
  readonly opsAlertRoutes: readonly OpsAlertRoute[];
  readonly sinkDeliveryMaxAttempts: number;
  readonly sinkDeliveryRetryAfterMs: number;
  readonly sinkDelivery?: SinkDeliveryEgressConfig;
  readonly videoRecordingEnabled: boolean;
  readonly videoFfmpegPath?: string;
  readonly videoFrameIntervalMs: number;
  readonly videoFrameRate: number;
}

export interface SinkDeliveryEgressConfig {
  readonly endpointSecretRef: string;
  readonly allowedHosts: readonly string[];
  readonly backendAlias: string;
  readonly timeoutMs: number;
  readonly maxRedirects: number;
}

export function loadWorkerConfig(common: CommonConfig): WorkerConfig {
  const videoRecordingEnabled = strictBool("VISUAL_EVIDENCE_VIDEO_ENABLED", false);
  const videoFrameIntervalMs = num("VISUAL_EVIDENCE_VIDEO_FRAME_INTERVAL_MS", 1000);
  if (!Number.isInteger(videoFrameIntervalMs) || videoFrameIntervalMs <= 0) {
    throw new Error(`VISUAL_EVIDENCE_VIDEO_FRAME_INTERVAL_MS must be a positive integer, got ${videoFrameIntervalMs}`);
  }
  const videoFrameRate = num("VISUAL_EVIDENCE_VIDEO_FPS", Math.max(1, Math.round(1000 / videoFrameIntervalMs)));
  if (!Number.isInteger(videoFrameRate) || videoFrameRate <= 0) {
    throw new Error(`VISUAL_EVIDENCE_VIDEO_FPS must be a positive integer, got ${videoFrameRate}`);
  }
  const maintenanceTenantIds = csvUuidList("MAINTENANCE_TENANT_IDS");
  const maintenanceLifecycleDatabaseUrl =
    maintenanceTenantIds.length === 0 ? req("MAINTENANCE_LIFECYCLE_DATABASE_URL") : opt("MAINTENANCE_LIFECYCLE_DATABASE_URL");
  const graphileMigrationsMode = graphileMigrationMode();
  const sinkDelivery = loadSinkDeliveryEgressConfig(common.rpaEnv);
  return {
    workerId: req("WORKER_ID"),
    vaultRuntimeWorker: loadVaultIdentity("RUNTIME_WORKER"),
    resumeTokenRef: `rpa/${common.rpaEnv}/runtime-worker/resume_token_hmac/active`,
    browserSessionKeyRef: `rpa/${common.rpaEnv}/runtime-worker/browser_session/active`,
    graphileSchema: opt("GRAPHILE_WORKER_SCHEMA"),
    graphileMigrationsMode,
    graphileConcurrency: num("GRAPHILE_CONCURRENCY", 1),
    graphilePollIntervalMs: num("GRAPHILE_POLL_INTERVAL_MS", 2000),
    workerPoolKeys: (opt("WORKER_POOL_KEYS") ?? "")
      .split(",")
      .map((key) => key.trim())
      .filter((key) => key.length > 0),
    maintenanceTenantIds,
    ...(maintenanceLifecycleDatabaseUrl !== undefined ? { maintenanceLifecycleDatabaseUrl } : {}),
    opsAlertRoutes: parseOpsAlertRoutes(opt("OPS_ALERT_ROUTES")),
    sinkDeliveryMaxAttempts: positiveInt("SINK_DELIVERY_MAX_ATTEMPTS", 3),
    sinkDeliveryRetryAfterMs: positiveInt("SINK_DELIVERY_RETRY_AFTER_MS", 5_000),
    ...(sinkDelivery !== undefined ? { sinkDelivery } : {}),
    videoRecordingEnabled,
    ...(videoRecordingEnabled ? { videoFfmpegPath: req("VISUAL_EVIDENCE_FFMPEG_PATH") } : {}),
    videoFrameIntervalMs,
    videoFrameRate,
  };
}

function loadSinkDeliveryEgressConfig(rpaEnv: string): SinkDeliveryEgressConfig | undefined {
  const endpointSecretRef = opt("SINK_DELIVERY_ENDPOINT_SECRET_REF");
  const allowedHostsRaw = opt("SINK_DELIVERY_ALLOWED_HOSTS");
  const hasPartial =
    allowedHostsRaw !== undefined ||
    opt("SINK_DELIVERY_BACKEND_ALIAS") !== undefined ||
    opt("SINK_DELIVERY_TIMEOUT_MS") !== undefined ||
    opt("SINK_DELIVERY_MAX_REDIRECTS") !== undefined;
  if (endpointSecretRef === undefined) {
    if (hasPartial) {
      throw new Error("SINK_DELIVERY_ENDPOINT_SECRET_REF is required when configuring sink delivery egress");
    }
    return undefined;
  }
  const refDenial = sinkDeliveryEndpointSecretRefDenial(endpointSecretRef, rpaEnv);
  if (refDenial !== null) {
    throw new Error(`env SINK_DELIVERY_ENDPOINT_SECRET_REF ${refDenial}`);
  }
  if (allowedHostsRaw === undefined) {
    throw new Error("SINK_DELIVERY_ALLOWED_HOSTS is required when SINK_DELIVERY_ENDPOINT_SECRET_REF is set");
  }
  const backendAlias = opt("SINK_DELIVERY_BACKEND_ALIAS") ?? "secretref-sink";
  if (!/^[A-Za-z0-9._:-]{1,100}$/.test(backendAlias)) {
    throw new Error("env SINK_DELIVERY_BACKEND_ALIAS must be 1-100 chars of A-Z a-z 0-9 . _ : -");
  }
  const maxRedirects = num("SINK_DELIVERY_MAX_REDIRECTS", 3);
  if (!Number.isInteger(maxRedirects) || maxRedirects < 0) {
    throw new Error(`env SINK_DELIVERY_MAX_REDIRECTS must be a non-negative integer, got ${maxRedirects}`);
  }
  return {
    endpointSecretRef,
    allowedHosts: csvAllowedDnsHosts("SINK_DELIVERY_ALLOWED_HOSTS", allowedHostsRaw),
    backendAlias,
    timeoutMs: positiveInt("SINK_DELIVERY_TIMEOUT_MS", 5_000),
    maxRedirects,
  };
}

function sinkDeliveryEndpointSecretRefDenial(ref: string, rpaEnv: string): string | null {
  const parts = ref.split("/");
  if (
    parts.length < 5 ||
    parts[0] !== "rpa" ||
    parts[2] !== "connector-runtime" ||
    parts[3] !== "connector" ||
    parts.some((part) => part.length === 0 || part === "." || part === "..")
  ) {
    return `must follow rpa/<env>/connector-runtime/connector/<name>, got ${JSON.stringify(ref)}`;
  }
  if (parts[1] !== rpaEnv) {
    return `env segment must match RPA_ENV=${JSON.stringify(rpaEnv)}, got ${JSON.stringify(parts[1])}`;
  }
  return null;
}

function csvAllowedDnsHosts(name: string, raw: string): string[] {
  const values = raw.split(",").map((part) => part.trim().toLowerCase());
  if (values.length === 0 || values.some((value) => value.length === 0)) {
    throw new Error(`env ${name} must be a comma-separated list of DNS hostnames without empty entries`);
  }
  const seen = new Set<string>();
  for (const value of values) {
    const denial = allowedDnsHostDenial(value);
    if (denial !== null) throw new Error(`env ${name} host ${JSON.stringify(value)} ${denial}`);
    if (seen.has(value)) throw new Error(`env ${name} contains duplicate host ${JSON.stringify(value)}`);
    seen.add(value);
  }
  return values;
}

function allowedDnsHostDenial(host: string): string | null {
  if (host.includes("://") || host.includes("/") || host.includes("\\") || host.includes("?") || host.includes("#") || host.includes("@")) {
    return "must be a hostname, not a URL";
  }
  if (host === "localhost" || host.endsWith(".localhost")) return "must not be localhost";
  if (/^[0-9.]+$/.test(host) || host.includes(":")) return "must not be an IP literal";
  const label = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
  const hostRe = new RegExp(`^${label}(?:\\.${label})*$`);
  if (!hostRe.test(host)) return "must be a DNS hostname";
  return null;
}

function graphileMigrationMode(): "runtime" | "external" {
  const value = (opt("GRAPHILE_MIGRATIONS_MODE") ?? "runtime").toLowerCase();
  if (value === "runtime" || value === "external") return value;
  throw new Error(`GRAPHILE_MIGRATIONS_MODE must be runtime|external, got ${JSON.stringify(value)}`);
}

function csvUuidList(name: string): string[] {
  const raw = opt(name);
  if (raw === undefined) return [];
  const values = raw.split(",").map((part) => part.trim());
  if (values.length === 0 || values.some((value) => value.length === 0)) {
    throw new Error(`env ${name} must be a comma-separated list of UUIDs without empty entries`);
  }
  const seen = new Set<string>();
  for (const value of values) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
      throw new Error(`env ${name} contains non-UUID value ${JSON.stringify(value)}`);
    }
    const normalized = value.toLowerCase();
    if (seen.has(normalized)) {
      throw new Error(`env ${name} contains duplicate tenant id ${JSON.stringify(value)}`);
    }
    seen.add(normalized);
  }
  return values;
}

/**
 * Browser session provider config for the worker (backlog item 2 ??activates the assembled executorFactory).
 *
 * The StagehandBrowserSessionProvider launches a fresh real Chrome per lease at bind() time, so the only
 * deploy-varying fact is the Chrome executable path (required, fail-closed ??never a silent default for a
 * binary that must exist for any run to drive). headless + download root are operational knobs with defaults.
 */
export interface BrowserConfig {
  /** Real Chrome executable path (deploy-time; bind() launches it per lease). */
  readonly chromeExecutablePath: string;
  readonly headless: boolean;
  /** Per-lease download directory root (defaults to OS tmp inside the provider when unset). */
  readonly downloadRootDir?: string;
}

export function loadBrowserConfig(): BrowserConfig {
  const downloadRootDir = opt("BROWSER_DOWNLOAD_ROOT_DIR");
  return {
    chromeExecutablePath: req("CHROME_EXECUTABLE_PATH"),
    headless: bool("BROWSER_HEADLESS", true),
    ...(downloadRootDir !== undefined ? { downloadRootDir } : {}),
  };
}
