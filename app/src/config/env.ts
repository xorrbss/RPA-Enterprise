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

import {
  assertHttpsUrl,
  bool,
  loadVaultIdentity,
  num,
  opt,
  positiveInt,
  req,
  strictBool,
  type VaultIdentityConfig,
} from "./env-primitives";
import { loadArtifactLifecycleWorkerConfig } from "./env-artifact-lifecycle";
import { loadAiGovernanceReadinessEnvConfig, loadGatewayConfig, loadScenarioGenerationLlmV1Config } from "./env-gateway";
import { loadApiJwtConfig, type ApiJwtConfig } from "./env-auth";

export { loadAiGovernanceReadinessEnvConfig, loadGatewayConfig, loadScenarioGenerationLlmV1Config };
export type { AiGovernanceReadinessEnvConfig, GatewayConfig, ScenarioGenerationLlmV1Config } from "./env-gateway";

export type { ApiJwtConfig } from "./env-auth";
export { loadBrowserConfig, loadWorkerConfig } from "./env-worker";
export type { BrowserConfig, SinkDeliveryEgressConfig, WorkerConfig } from "./env-worker";

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
  readonly otlp?: OtlpTelemetryConfig;
}

export function loadCommonConfig(): CommonConfig {
  // node-pg (createPool) reads PGHOST/PGPORT/PGUSER/PGDATABASE/PGPASSWORD directly; graphile needs a URL.
  const connectionString = opt("DATABASE_URL") ?? buildPgConnString();
  const telemetryExporter = loadTelemetryExporter();
  return {
    rpaEnv: req("RPA_ENV"),
    connectionString,
    healthPort: num("HEALTH_PORT", 8081),
    telemetryExporter,
    ...(telemetryExporter === "otlp" ? { otlp: loadOtlpTelemetryConfig() } : {}),
  };
}

export type TelemetryExporter = "console" | "none" | "prometheus" | "otlp";

export interface OtlpTelemetryConfig {
  readonly tracesEndpoint: string;
  readonly metricsEndpoint: string;
}

/**
 * OTel exporter 선택(부트스트랩 호출측 위임, bootstrap.ts §). `console`=내장 exporter 로 stdout 표면화(수집 백엔드 무의존),
 * `none`(기본)=전역 Provider 미등록(span/metric no-op, 명시적 opt-out). OTLP(prod 수집)는 후속 — 별도 exporter 패키지로
 * 이 선택지를 확장한다. 미정의 값은 fail-closed throw("조용한 false/unknown 금지").
 */
export function loadTelemetryExporter(): TelemetryExporter {
  const e = (opt("OTEL_EXPORTER") ?? "none").toLowerCase();
  if (e !== "console" && e !== "none" && e !== "prometheus" && e !== "otlp") {
    throw new Error(`OTEL_EXPORTER must be one of console|none|prometheus|otlp, got ${JSON.stringify(e)}`);
  }
  return e;
}

export function loadOtlpTelemetryConfig(): OtlpTelemetryConfig {
  const base = opt("OTEL_EXPORTER_OTLP_ENDPOINT");
  const traces = opt("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT") ?? (base !== undefined ? joinOtlpEndpoint(base, "v1/traces") : undefined);
  const metrics = opt("OTEL_EXPORTER_OTLP_METRICS_ENDPOINT") ?? (base !== undefined ? joinOtlpEndpoint(base, "v1/metrics") : undefined);
  if (traces === undefined || metrics === undefined) {
    throw new Error(
      "OTEL_EXPORTER=otlp requires OTEL_EXPORTER_OTLP_ENDPOINT or both OTEL_EXPORTER_OTLP_TRACES_ENDPOINT and OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
    );
  }
  return {
    tracesEndpoint: assertHttpTelemetryUrl("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", traces),
    metricsEndpoint: assertHttpTelemetryUrl("OTEL_EXPORTER_OTLP_METRICS_ENDPOINT", metrics),
  };
}

function joinOtlpEndpoint(base: string, suffix: "v1/traces" | "v1/metrics"): string {
  return `${base.replace(/\/+$/, "")}/${suffix}`;
}

function assertHttpTelemetryUrl(name: string, value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`env ${name} must be an absolute http(s) URL, got ${JSON.stringify(value)}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`env ${name} must use http or https, got protocol ${JSON.stringify(parsed.protocol)}`);
  }
  if (parsed.username !== "" || parsed.password !== "" || parsed.search !== "" || parsed.hash !== "") {
    throw new Error(`env ${name} must not include credentials, query, or fragment`);
  }
  return value;
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

export interface ApiConfig {
  readonly port: number;
  readonly jwt: ApiJwtConfig;
  readonly signedCommandRegistry:
    | { readonly mode: "vault"; readonly vaultApi: VaultIdentityConfig; readonly sourceRef: string }
    | { readonly mode: "deny_all" };
  /** Console origin allowlist for CORS; omit for same-origin (no CORS registered). No wildcard. */
  readonly corsOrigins?: readonly string[];
  readonly hsts: boolean;
  /** 오프보딩 purge 유예기간(일) — ops-defaults offboarding.purge_grace_default(7d). */
  readonly offboardingPurgeGraceDays: number;
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
    jwt: loadApiJwtConfig(common.rpaEnv),
    signedCommandRegistry: loadSignedCommandRegistryConfig(common),
    corsOrigins: origins
      ? origins.split(",").map((s) => s.trim()).filter((s) => s.length > 0)
      : undefined,
    hsts: bool("ENABLE_HSTS", true),
    offboardingPurgeGraceDays: positiveInt("OFFBOARDING_PURGE_GRACE_DAYS", 7),
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

function loadArtifactObjectStoreConfig(): ArtifactObjectStoreConfig {
  const kind = (opt("ARTIFACT_OBJECT_STORE_KIND") ?? "fs").toLowerCase();
  if (kind === "fs") return { kind };
  if (kind !== "s3") {
    throw new Error(`ARTIFACT_OBJECT_STORE_KIND must be one of fs|s3, got ${JSON.stringify(kind)}`);
  }
  // API 전용 `S3_*` 가 있으면 그대로 쓰고(기존 배포 동작 보존), 없으면 플랫폼 정규 계열
  // `ARTIFACT_OBJECT_STORE_S3_*` 로 폴백한다 — artifact lifecycle 워커(env-artifact-lifecycle.ts)와 게이트웨이
  // 폴백(env-gateway.ts)이 이미 그 이름을 쓰고, 배포 매니페스트(ConfigMap)는 **그 이름만** 제공한다. 폴백이
  // 없던 탓에 ARTIFACT_OBJECT_STORE_KIND=s3 인 프로덕션 설정에서 API 가 부팅조차 못 했다
  // (missing required env S3_ENDPOINT — 아티팩트는 한 스토어를 공유하므로 값이 갈릴 이유가 없다).
  return {
    kind,
    endpoint: assertHttpsUrl(
      "S3_ENDPOINT",
      opt("S3_ENDPOINT") ?? req("ARTIFACT_OBJECT_STORE_S3_ENDPOINT"),
    ),
    region: opt("S3_REGION") ?? req("ARTIFACT_OBJECT_STORE_S3_REGION"),
    bucket: opt("S3_BUCKET") ?? req("ARTIFACT_OBJECT_STORE_S3_BUCKET"),
    accessKeyId: opt("S3_ACCESS_KEY_ID") ?? req("ARTIFACT_OBJECT_STORE_S3_ACCESS_KEY_ID"),
    forcePathStyle: strictBool(
      "S3_FORCE_PATH_STYLE",
      strictBool("ARTIFACT_OBJECT_STORE_S3_FORCE_PATH_STYLE", true),
    ),
  };
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
