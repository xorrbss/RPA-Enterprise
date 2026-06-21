/**
 * Artifact lifecycle 워커 config 로딩(object-store 모드/credential/ref). 분해 전 env.ts 내부였음 — CLAUDE.md #7.
 * env-primitives 외 의존 없는 단방향 모듈. topology 정합 검사(assert*)는 gateway config 결합 때문에 env.ts 에 잔류.
 */
import { num, opt, req, strictBool, reqHttpsUrl, loadVaultIdentity, type VaultIdentityConfig } from "./env-primitives";

export type ArtifactLifecycleObjectStoreMode = "s3" | "local_fs";

export interface ArtifactLifecycleS3ObjectStoreConfig {
  readonly mode: "s3";
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  /** SecretRef for the S3-compatible secret access key. The PlainSecret value is resolved only in main.ts. */
  readonly secretAccessKeyRef: string;
  /** Non-secret object-store backend alias used in lifecycle evidence. */
  readonly backendAlias: string;
  readonly forcePathStyle: boolean;
}

export interface ArtifactLifecycleLocalObjectStoreConfig {
  readonly mode: "local_fs";
  /** Shared artifact object root used by the producer and local lifecycle worker. */
  readonly artifactDir: string;
  /** SecretRef identifier for the local artifact-lifecycle object_store port binding evidence. */
  readonly credentialRef: string;
  /** Non-secret object-store backend alias used in lifecycle evidence. */
  readonly backendAlias: string;
}

export type ArtifactLifecycleObjectStoreConfig =
  | ArtifactLifecycleS3ObjectStoreConfig
  | ArtifactLifecycleLocalObjectStoreConfig;

export interface ArtifactLifecycleWorkerConfig {
  /** Dedicated BYPASSRLS operational connection string. Do not reuse API/runtime-worker credentials here. */
  readonly connectionString: string;
  /** Stable workers.id for artifact lifecycle CAS claim ownership. Should be a sweeper worker row. */
  readonly workerId: string;
  /** AppRole identity for artifact-lifecycle object_store SecretRef resolution. Required for S3-compatible mode. */
  readonly vaultArtifactLifecycle?: VaultIdentityConfig;
  readonly objectStore: ArtifactLifecycleObjectStoreConfig;
  readonly artifactRetentionDays: number;
  readonly graphileSchema?: string;
  readonly graphileConcurrency: number;
  readonly graphilePollIntervalMs: number;
}

export function loadArtifactLifecycleWorkerConfig(): ArtifactLifecycleWorkerConfig {
  const objectStore = loadArtifactLifecycleObjectStoreConfig();
  const artifactRetentionDays = num("GATEWAY_ARTIFACT_RETENTION_DAYS", 90);
  if (!Number.isInteger(artifactRetentionDays) || artifactRetentionDays <= 0) {
    throw new Error(`GATEWAY_ARTIFACT_RETENTION_DAYS must be a positive integer, got ${artifactRetentionDays}`);
  }
  return {
    connectionString: req("ARTIFACT_LIFECYCLE_DATABASE_URL"),
    workerId: req("ARTIFACT_LIFECYCLE_WORKER_ID"),
    ...(objectStore.mode === "s3" ? { vaultArtifactLifecycle: loadVaultIdentity("ARTIFACT_LIFECYCLE") } : {}),
    objectStore,
    artifactRetentionDays,
    graphileSchema: opt("GRAPHILE_WORKER_SCHEMA"),
    graphileConcurrency: num("ARTIFACT_LIFECYCLE_GRAPHILE_CONCURRENCY", num("GRAPHILE_CONCURRENCY", 1)),
    graphilePollIntervalMs: num("ARTIFACT_LIFECYCLE_GRAPHILE_POLL_INTERVAL_MS", num("GRAPHILE_POLL_INTERVAL_MS", 2000)),
  };
}

function loadArtifactLifecycleObjectStoreConfig(): ArtifactLifecycleObjectStoreConfig {
  const mode = artifactLifecycleObjectStoreMode();
  const credentialRef = reqArtifactObjectStoreRef("ARTIFACT_OBJECT_STORE_REF");
  if (mode === "local_fs") {
    assertArtifactLifecycleLocalModeAllowed();
    return {
      mode,
      artifactDir: req("GATEWAY_ARTIFACT_DIR"),
      credentialRef,
      backendAlias: opt("ARTIFACT_OBJECT_STORE_BACKEND_ALIAS") ?? "fs-local",
    };
  }
  return {
    mode,
    endpoint: reqHttpsUrl("ARTIFACT_OBJECT_STORE_S3_ENDPOINT"),
    region: req("ARTIFACT_OBJECT_STORE_S3_REGION"),
    bucket: req("ARTIFACT_OBJECT_STORE_S3_BUCKET"),
    accessKeyId: req("ARTIFACT_OBJECT_STORE_S3_ACCESS_KEY_ID"),
    secretAccessKeyRef: credentialRef,
    backendAlias: opt("ARTIFACT_OBJECT_STORE_BACKEND_ALIAS") ?? "s3-compatible",
    forcePathStyle: strictBool("ARTIFACT_OBJECT_STORE_S3_FORCE_PATH_STYLE", true),
  };
}

function artifactLifecycleObjectStoreMode(): ArtifactLifecycleObjectStoreMode {
  const raw = opt("ARTIFACT_LIFECYCLE_OBJECT_STORE_MODE") ?? "s3";
  const normalized = raw.toLowerCase().replace(/-/g, "_");
  if (normalized === "s3" || normalized === "s3_compatible") return "s3";
  if (normalized === "local_fs") return "local_fs";
  throw new Error(
    `ARTIFACT_LIFECYCLE_OBJECT_STORE_MODE must be one of s3|s3-compatible|local_fs, got ${JSON.stringify(raw)}`,
  );
}

function reqArtifactObjectStoreRef(name: string): string {
  const ref = req(name);
  const parts = ref.split("/");
  const rpaEnv = req("RPA_ENV").toLowerCase();
  if (
    parts.length < 5 ||
    parts.some((part) => part.length === 0) ||
    parts[0] !== "rpa" ||
    parts[2] !== "artifact-lifecycle" ||
    parts[3] !== "object_store"
  ) {
    throw new Error(
      `env ${name} must be a SecretRef under rpa/<env>/artifact-lifecycle/object_store/<name>, got ${JSON.stringify(ref)}`,
    );
  }
  if (parts[1] !== rpaEnv) {
    throw new Error(
      `env ${name} SecretRef env segment must match RPA_ENV=${JSON.stringify(rpaEnv)}, got ${JSON.stringify(parts[1])}`,
    );
  }
  return ref;
}

function assertArtifactLifecycleLocalModeAllowed(): void {
  const rpaEnv = req("RPA_ENV").toLowerCase();
  if (rpaEnv !== "dev" && rpaEnv !== "local") {
    throw new Error("ARTIFACT_LIFECYCLE_OBJECT_STORE_MODE=local_fs is allowed only when RPA_ENV is dev|local");
  }
}
