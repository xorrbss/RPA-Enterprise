/**
 * Fail-closed environment config loader for the production composition root (app/src/main.ts).
 *
 * Honors the repo invariant "議곗슜??false/unknown 湲덉?": every required value (and every secret) MUST be
 * present or the process throws before constructing anything. There are NO silent defaults for secrets.
 * Non-secret operational knobs may carry an explicit documented default.
 *
 * This is the only place app code reads process.env for the production entrypoint (dev/serve.ts is dev-only).
 */
import { resolve } from "node:path";

import { DEFAULT_JWT_CLAIM_MAPPING, type JwtClaimMapping, type JwtRoleMap } from "../api/auth";
import {
  assertHttpsUrl,
  bool,
  loadVaultIdentity,
  num,
  opt,
  positiveInt,
  req,
  reqHttpsUrl,
  strictBool,
  type VaultIdentityConfig,
} from "./env-primitives";
import { loadArtifactLifecycleWorkerConfig } from "./env-artifact-lifecycle";
import { loadGatewayConfig, loadScenarioGenerationLlmV1Config } from "./env-gateway";

export { loadGatewayConfig, loadScenarioGenerationLlmV1Config };
export type { GatewayConfig, ScenarioGenerationLlmV1Config } from "./env-gateway";

export { loadArtifactLifecycleWorkerConfig };
export type {
  ArtifactLifecycleLocalObjectStoreConfig,
  ArtifactLifecycleObjectStoreConfig,
  ArtifactLifecycleObjectStoreMode,
  ArtifactLifecycleS3ObjectStoreConfig,
  ArtifactLifecycleWorkerConfig,
} from "./env-artifact-lifecycle";

export type RunMode = "api" | "worker" | "lifecycle-worker" | "all";

export function loadRunMode(): RunMode {
  const m = (opt("RUN_MODE") ?? "all").toLowerCase();
  if (m !== "api" && m !== "worker" && m !== "lifecycle-worker" && m !== "all") {
    throw new Error(`RUN_MODE must be one of api|worker|lifecycle-worker|all, got ${JSON.stringify(m)}`);
  }
  return m;
}

export type ArtifactLifecycleConsumer = "external" | "self";

/**
 * N1 fail-closed: RUN_MODE=worker 는 run-drive 가 artifact_redaction/artifact_retention job 을 인큐하지만 그 자체로는
 * 소비자가 없다(control task만 등록). 소비자 토폴로지를 명시 선언하게 강제한다 — `external`=별도 lifecycle-worker
 * (RUN_MODE=lifecycle-worker)가 배포됨(운영자 단언), `self`=이 프로세스가 lifecycle-worker 를 인-프로세스로 함께 기동
 * (전용 BYPASSRLS pool/ARTIFACT_LIFECYCLE_* config 필요). 미선언/오값은 throw(조용한 artifact 적체 금지).
 */
export function loadArtifactLifecycleConsumer(): ArtifactLifecycleConsumer {
  const v = (opt("ARTIFACT_LIFECYCLE_CONSUMER") ?? "").toLowerCase();
  if (v !== "external" && v !== "self") {
    throw new Error(
      `RUN_MODE=worker requires ARTIFACT_LIFECYCLE_CONSUMER=external|self — run-drive enqueues artifact_redaction/artifact_retention ` +
        `jobs that need a consumer; 'external'=a separate lifecycle-worker (RUN_MODE=lifecycle-worker) is deployed, ` +
        `'self'=this process also starts the lifecycle worker (requires ARTIFACT_LIFECYCLE_* config). got ${JSON.stringify(v || "(unset)")}`,
    );
  }
  return v;
}

export interface CommonConfig {
  /** RPA_ENV (e.g. staging|prod) ??templates every SecretRef path rpa/<env>/<runtime>/<purpose>/<name>. */
  readonly rpaEnv: string;
  /** Explicit connection string for graphile-worker run()/runMigrations() (needs a string, not libpq env). */
  readonly connectionString: string;
  /** Unauthenticated health probe port (separate http server ??bypasses the Fastify auth/RBAC chain). */
  readonly healthPort: number;
  /** OTel exporter 선택(부트스트랩 호출측 위임, observability/bootstrap.ts §). console=stdout 표면화, none=미등록(no-op). */
  readonly telemetryExporter: TelemetryExporter;
}

export function loadCommonConfig(): CommonConfig {
  // node-pg (createPool) reads PGHOST/PGPORT/PGUSER/PGDATABASE/PGPASSWORD directly; graphile needs a URL.
  const connectionString = opt("DATABASE_URL") ?? buildPgConnString();
  return {
    rpaEnv: req("RPA_ENV"),
    connectionString,
    healthPort: num("HEALTH_PORT", 8081),
    telemetryExporter: loadTelemetryExporter(),
  };
}

export type TelemetryExporter = "console" | "none";

/**
 * OTel exporter 선택(부트스트랩 호출측 위임, bootstrap.ts §). `console`=내장 exporter 로 stdout 표면화(수집 백엔드 무의존),
 * `none`(기본)=전역 Provider 미등록(span/metric no-op, 명시적 opt-out). OTLP(prod 수집)는 후속 — 별도 exporter 패키지로
 * 이 선택지를 확장한다. 미정의 값은 fail-closed throw("조용한 false/unknown 금지").
 */
export function loadTelemetryExporter(): TelemetryExporter {
  const e = (opt("OTEL_EXPORTER") ?? "none").toLowerCase();
  if (e !== "console" && e !== "none") {
    throw new Error(`OTEL_EXPORTER must be one of console|none, got ${JSON.stringify(e)}`);
  }
  return e;
}

export type ApiLogLevel = "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";

const API_LOG_LEVELS: readonly ApiLogLevel[] = ["fatal", "error", "warn", "info", "debug", "trace", "silent"];

/**
 * 제어평면 API 구조화 로거 레벨(server.ts buildServer 의 Fastify/pino logger). 기본 `info` — authz 거부·라우트
 * 미설정 경고·미분류 에러 경로의 `request.log.warn/error`(correlation_id·code·reason 포함)가 실제로 방출된다.
 * `silent`=명시적 opt-out. 미정의 값은 fail-closed throw("조용한 false/unknown 금지").
 */
export function loadApiLogLevel(): ApiLogLevel {
  const e = (opt("API_LOG_LEVEL") ?? "info").toLowerCase();
  if (!API_LOG_LEVELS.includes(e as ApiLogLevel)) {
    throw new Error(`API_LOG_LEVEL must be one of ${API_LOG_LEVELS.join("|")}, got ${JSON.stringify(e)}`);
  }
  return e as ApiLogLevel;
}

function buildPgConnString(): string {
  const host = req("PGHOST");
  const port = opt("PGPORT") ?? "5432";
  const user = req("PGUSER");
  const password = req("PGPASSWORD");
  const database = req("PGDATABASE");
  return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${encodeURIComponent(database)}`;
}

/**
 * JWT verification config. `JWKS_URL` selects the production RS256/JWKS verifier (keys fetched from the IdP);
 * absent ??the v1 HS256 shared-secret default (dev/tests). Each mode is fail-closed on its own required value;
 * the algorithm/issuer/JWKS endpoint are deploy-config (auth-rbac.md fixes only the claims, not the algorithm).
 */
export type ApiJwtConfig =
  | ({ readonly mode: "hs256"; readonly secret: string } & ApiJwtCommonConfig)
  | ({ readonly mode: "jwks"; readonly jwksUrl: string; readonly issuer?: string; readonly audience?: string } & ApiJwtCommonConfig);

interface ApiJwtCommonConfig {
  readonly claimMapping: JwtClaimMapping;
  readonly roleMap: JwtRoleMap;
}

export interface ApiConfig {
  readonly port: number;
  readonly jwt: ApiJwtConfig;
  readonly signedCommandRegistry:
    | { readonly mode: "vault"; readonly vaultApi: VaultIdentityConfig; readonly sourceRef: string }
    | { readonly mode: "deny_all" };
  /** Console origin allowlist for CORS; omit for same-origin (no CORS registered). No wildcard. */
  readonly corsOrigins?: readonly string[];
  readonly hsts: boolean;
  /** Optional object-store root the API may read for audited artifact body/blob disclosure. */
  readonly artifactDir?: string;
  /** Optional S3 object-store reader for runtime visual evidence stored outside the local FS. */
  readonly artifactObjectStore?: ApiArtifactObjectStoreConfig;
  /** Enables natural-language scenario generation to request run-level masked WebM capture. */
  readonly videoRecordingEnabled: boolean;
  /** Optional live browser selector probe for Object Repository validation. */
  readonly selectorProbe?: {
    readonly chromeExecutablePath: string;
    readonly headless: boolean;
    readonly timeoutMs: number;
  };
}

export interface ApiArtifactObjectStoreConfig {
  readonly objectStoreRef: string;
  readonly objectStore: Extract<ArtifactObjectStoreConfig, { readonly kind: "s3" }>;
  readonly vaultApi: VaultIdentityConfig;
}

function loadApiJwtConfig(): ApiJwtConfig {
  const claimMapping = loadJwtClaimMapping();
  const roleMap = loadJwtRoleMap();
  const jwksUrl = opt("JWKS_URL");
  if (jwksUrl !== undefined) {
    // RS256/JWKS mode: https-forced (IdP keys must not be fetched over cleartext).
    const issuer = opt("JWT_ISSUER");
    const audience = opt("JWT_AUDIENCE");
    return {
      mode: "jwks",
      jwksUrl: assertHttpsUrl("JWKS_URL", jwksUrl),
      claimMapping,
      roleMap,
      ...(issuer !== undefined ? { issuer } : {}),
      ...(audience !== undefined ? { audience } : {}),
    };
  }
  // HS256 shared-secret mode (v1 default). Env-sourced ??no `jwt` SecretRef purpose exists in the
  // least-privilege matrix yet (mirrors the gateway key gap, release-decisions D8-A16). Fail-closed required.
  const secret = req("JWT_HS256_SECRET");
  if (secret.length < 32) {
    throw new Error("JWT_HS256_SECRET must be at least 32 characters (HS256 key strength)");
  }
  return { mode: "hs256", secret, claimMapping, roleMap };
}

function loadJwtClaimMapping(): JwtClaimMapping {
  return {
    subjectClaim: opt("JWT_SUBJECT_CLAIM") ?? DEFAULT_JWT_CLAIM_MAPPING.subjectClaim,
    tenantClaim: opt("JWT_TENANT_CLAIM") ?? DEFAULT_JWT_CLAIM_MAPPING.tenantClaim,
    rolesClaim: opt("JWT_ROLES_CLAIM") ?? DEFAULT_JWT_CLAIM_MAPPING.rolesClaim,
    expiryClaim: DEFAULT_JWT_CLAIM_MAPPING.expiryClaim,
    displayNameClaim: opt("JWT_DISPLAY_NAME_CLAIM") ?? DEFAULT_JWT_CLAIM_MAPPING.displayNameClaim,
    emailClaim: opt("JWT_EMAIL_CLAIM") ?? DEFAULT_JWT_CLAIM_MAPPING.emailClaim,
  };
}

const API_JWT_ROLES: ReadonlySet<string> = new Set(["viewer", "operator", "reviewer", "approver", "admin"]);

function loadJwtRoleMap(): JwtRoleMap {
  const raw = opt("JWT_ROLE_MAP");
  if (raw === undefined) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("JWT_ROLE_MAP must be a JSON object mapping IdP role/group values to RPA roles");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("JWT_ROLE_MAP must be a JSON object mapping IdP role/group values to RPA roles");
  }
  const out: Record<string, JwtRoleMap[string]> = {};
  for (const [source, target] of Object.entries(parsed as Record<string, unknown>)) {
    if (source.trim().length === 0) {
      throw new Error("JWT_ROLE_MAP must not contain empty IdP role keys");
    }
    if (typeof target !== "string" || !API_JWT_ROLES.has(target)) {
      throw new Error(`JWT_ROLE_MAP target for ${JSON.stringify(source)} must be one of viewer|operator|reviewer|approver|admin`);
    }
    out[source] = target as JwtRoleMap[string];
  }
  return out;
}

function loadSignedCommandRegistryConfig(common: CommonConfig): ApiConfig["signedCommandRegistry"] {
  const mode = req("SIGNED_COMMAND_REGISTRY_MODE").toLowerCase();
  if (mode === "deny_all") {
    return { mode };
  }
  if (mode !== "vault") {
    throw new Error(`SIGNED_COMMAND_REGISTRY_MODE must be one of vault|deny_all, got ${JSON.stringify(mode)}`);
  }
  return {
    mode,
    vaultApi: loadVaultIdentity("API"),
    sourceRef: opt("SIGNED_COMMAND_REGISTRY_REF") ?? `rpa/${common.rpaEnv}/api/signed_command/registry`,
  };
}

export function loadApiConfig(common: CommonConfig, options: { readonly runMode?: RunMode } = {}): ApiConfig {
  const origins = opt("CORS_ORIGINS");
  const videoRecordingEnabled = strictBool("VISUAL_EVIDENCE_VIDEO_ENABLED", false);
  const artifactObjectStore = loadApiArtifactObjectStoreConfig();
  const selectorProbe = loadSelectorProbeConfig();
  if (videoRecordingEnabled) {
    req("VISUAL_EVIDENCE_FFMPEG_PATH");
    if (options.runMode === "api" && !strictBool("VISUAL_EVIDENCE_VIDEO_WORKER_CONFIRMED", false)) {
      throw new Error("VISUAL_EVIDENCE_VIDEO_WORKER_CONFIRMED must be true when API-only mode advertises video recording");
    }
  }
  return {
    port: num("PORT", 8080),
    jwt: loadApiJwtConfig(),
    signedCommandRegistry: loadSignedCommandRegistryConfig(common),
    corsOrigins: origins
      ? origins.split(",").map((s) => s.trim()).filter((s) => s.length > 0)
      : undefined,
    hsts: bool("ENABLE_HSTS", true),
    artifactDir: resolveApiArtifactDir(),
    ...(artifactObjectStore !== undefined ? { artifactObjectStore } : {}),
    videoRecordingEnabled,
    ...(selectorProbe !== undefined ? { selectorProbe } : {}),
  };
}

function loadSelectorProbeConfig(): ApiConfig["selectorProbe"] {
  const chromeExecutablePath = opt("SELECTOR_PROBE_CHROME_EXECUTABLE_PATH") ?? opt("CHROME_EXECUTABLE_PATH");
  if (chromeExecutablePath === undefined) return undefined;
  const timeoutMs = positiveInt("SELECTOR_PROBE_TIMEOUT_MS", 15_000);
  return {
    chromeExecutablePath,
    headless: bool("SELECTOR_PROBE_HEADLESS", true),
    timeoutMs,
  };
}

function loadApiArtifactObjectStoreConfig(): ApiArtifactObjectStoreConfig | undefined {
  const rawKind = opt("ARTIFACT_OBJECT_STORE_KIND");
  const kind = (rawKind ?? "fs").toLowerCase();
  if (kind === "fs") return undefined;
  if (kind !== "s3") {
    throw new Error(`ARTIFACT_OBJECT_STORE_KIND must be one of fs|s3, got ${JSON.stringify(kind)}`);
  }
  const objectStore = loadArtifactObjectStoreConfig();
  if (objectStore.kind !== "s3") {
    throw new Error("API artifact object-store expected s3 config");
  }
  return {
    objectStoreRef: req("ARTIFACT_OBJECT_STORE_REF"),
    objectStore,
    vaultApi: loadVaultIdentity("API"),
  };
}

function resolveApiArtifactDir(): string | undefined {
  const apiArtifactDir = opt("API_ARTIFACT_DIR");
  const gatewayArtifactDir = opt("GATEWAY_ARTIFACT_DIR");
  if (
    apiArtifactDir !== undefined &&
    gatewayArtifactDir !== undefined &&
    resolve(apiArtifactDir) !== resolve(gatewayArtifactDir)
  ) {
    throw new Error("API_ARTIFACT_DIR must match GATEWAY_ARTIFACT_DIR when both are set (shared artifact store required)");
  }
  return apiArtifactDir ?? gatewayArtifactDir;
}

export type ArtifactObjectStoreConfig =
  | { readonly kind: "fs" }
  | {
      readonly kind: "s3";
      readonly endpoint: string;
      readonly region: string;
      readonly bucket: string;
      readonly accessKeyId: string;
      readonly forcePathStyle: boolean;
    };

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
  readonly graphileConcurrency: number;
  readonly graphilePollIntervalMs: number;
  /** DG-3: 이 워커가 서비스하는 전용 풀 키(WORKER_POOL_KEYS, csv). 빈 값이면 'default' 풀만 서비스. */
  readonly workerPoolKeys: readonly string[];
  readonly maintenanceTenantIds: readonly string[];
  readonly sinkDeliveryMaxAttempts: number;
  readonly sinkDeliveryRetryAfterMs: number;
  readonly videoRecordingEnabled: boolean;
  readonly videoFfmpegPath?: string;
  readonly videoFrameIntervalMs: number;
  readonly videoFrameRate: number;
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
  return {
    workerId: req("WORKER_ID"),
    vaultRuntimeWorker: loadVaultIdentity("RUNTIME_WORKER"),
    resumeTokenRef: `rpa/${common.rpaEnv}/runtime-worker/resume_token_hmac/active`,
    browserSessionKeyRef: `rpa/${common.rpaEnv}/runtime-worker/browser_session/active`,
    graphileSchema: opt("GRAPHILE_WORKER_SCHEMA"),
    graphileConcurrency: num("GRAPHILE_CONCURRENCY", 1),
    graphilePollIntervalMs: num("GRAPHILE_POLL_INTERVAL_MS", 2000),
    workerPoolKeys: (opt("WORKER_POOL_KEYS") ?? "")
      .split(",")
      .map((key) => key.trim())
      .filter((key) => key.length > 0),
    maintenanceTenantIds: csvUuidList("MAINTENANCE_TENANT_IDS"),
    sinkDeliveryMaxAttempts: positiveInt("SINK_DELIVERY_MAX_ATTEMPTS", 3),
    sinkDeliveryRetryAfterMs: positiveInt("SINK_DELIVERY_RETRY_AFTER_MS", 5_000),
    videoRecordingEnabled,
    ...(videoRecordingEnabled ? { videoFfmpegPath: req("VISUAL_EVIDENCE_FFMPEG_PATH") } : {}),
    videoFrameIntervalMs,
    videoFrameRate,
  };
}

function loadArtifactObjectStoreConfig(): ArtifactObjectStoreConfig {
  const kind = (opt("ARTIFACT_OBJECT_STORE_KIND") ?? "fs").toLowerCase();
  if (kind === "fs") return { kind };
  if (kind !== "s3") {
    throw new Error(`ARTIFACT_OBJECT_STORE_KIND must be one of fs|s3, got ${JSON.stringify(kind)}`);
  }
  return {
    kind,
    endpoint: reqHttpsUrl("S3_ENDPOINT"),
    region: req("S3_REGION"),
    bucket: req("S3_BUCKET"),
    accessKeyId: req("S3_ACCESS_KEY_ID"),
    forcePathStyle: strictBool("S3_FORCE_PATH_STYLE", true),
  };
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

export type ArtifactStoreTopology = "in_process" | "split_worker_lifecycle";

export function assertArtifactStoreTopologyCompatibility(topology: ArtifactStoreTopology): void {
  const gateway = loadGatewayConfig();
  const lifecycle = loadArtifactLifecycleWorkerConfig();
  const label = topology === "in_process" ? "RUN_MODE=all" : "split worker/lifecycle deployment";
  if (gateway.artifactStore.mode === "fs") {
    if (lifecycle.objectStore.mode !== "local_fs") {
      throw new Error(
        `${label} cannot combine FsObjectStore artifact producers with ARTIFACT_LIFECYCLE_OBJECT_STORE_MODE=s3`,
      );
    }
    if (resolve(gateway.artifactStore.artifactDir) !== resolve(lifecycle.objectStore.artifactDir)) {
      throw new Error(`${label} requires runtime artifact producers and local artifact lifecycle worker to share GATEWAY_ARTIFACT_DIR`);
    }
    return;
  }

  if (lifecycle.objectStore.mode !== "s3") {
    throw new Error(`${label} cannot combine S3 artifact producers with ARTIFACT_LIFECYCLE_OBJECT_STORE_MODE=local_fs`);
  }
  if (
    gateway.artifactStore.endpoint !== lifecycle.objectStore.endpoint ||
    gateway.artifactStore.region !== lifecycle.objectStore.region ||
    gateway.artifactStore.bucket !== lifecycle.objectStore.bucket ||
    gateway.artifactStore.forcePathStyle !== lifecycle.objectStore.forcePathStyle
  ) {
    throw new Error(`${label} requires runtime artifact producers and artifact lifecycle worker to target the same S3-compatible object store`);
  }
}

/**
 * Boot 시점 artifact store topology fail-closed 가드. FS artifact producer 와 artifact lifecycle worker 가
 * 같은 프로세스에 공존하는 모드만 in_process 정합을 강제한다:
 *  - RUN_MODE=all: API+worker+lifecycle 단일 프로세스(항상 공존).
 *  - RUN_MODE=worker + consumer=self: lifecycle worker 를 인-프로세스로 동반(main 의 startArtifactLifecycleWorker).
 * worker + external / lifecycle-worker / api 는 이 프로세스에 co-resident lifecycle 이 없다 — split 토폴로지는
 * 이 프로세스에 lifecycle 설정이 없어 startup 가드가 false-positive 이므로 deploy 시 preflight:artifact-store CLI 가 검증한다.
 * 공존 모드에서 정합이 깨지면(FS producer + s3 lifecycle, 또는 비공유 artifactDir) artifact 가 조용히 redaction_status='pending'
 * 으로 영구잔류하므로 boot 에서 throw 한다(조용한 false 금지).
 */
export function assertArtifactStoreStartupCompatibility(
  runMode: RunMode,
  workerLifecycleConsumer: ArtifactLifecycleConsumer | undefined,
): void {
  const lifecycleCoResident = runMode === "all" || (runMode === "worker" && workerLifecycleConsumer === "self");
  if (!lifecycleCoResident) return;
  assertArtifactStoreTopologyCompatibility("in_process");
}


/** API ?몄뀡 罹≪쿂 遊됲닾?뷀샇???ㅼ젙 ??api AppRole(Vault) + ?쒖꽦 KEK SecretRef. */
export interface ApiSessionEncryptionConfig {
  readonly vault: VaultIdentityConfig;
  readonly kekRef: string;
}

/**
 * ?몄뀡 罹≪쿂(POST .../session/capture/complete) 遊됲닾?뷀샇???ㅼ젙 ??`VAULT_API_ROLE_ID` 媛 ?덉쓣 ?뚮쭔 ?쒖꽦(誘몄꽕???? * undefined ???붾뱶?ъ씤??誘몃벑濡? fail-closed). KEK ??api identity ??browser_session purpose namespace ?먯꽌 1???댁냼.
 */
export function loadApiSessionEncryption(common: CommonConfig): ApiSessionEncryptionConfig | undefined {
  if (opt("VAULT_API_ROLE_ID") === undefined) return undefined;
  return {
    vault: loadVaultIdentity("API"),
    kekRef: `rpa/${common.rpaEnv}/api/browser_session/active`,
  };
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
