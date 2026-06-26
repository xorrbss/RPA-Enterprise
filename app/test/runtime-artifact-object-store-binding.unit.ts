import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FsArtifactRedactor, FsArtifactRetentionStore } from "../src/artifacts/fs-artifact-lifecycle-store";
import { S3ArtifactRedactor } from "../src/artifacts/s3-artifact-redactor";
import { S3ArtifactRetentionStore } from "../src/artifacts/s3-artifact-retention-store";
import { S3ObjectStore } from "../src/artifacts/s3-object-store";
import { buildGatewayArtifactObjectStore } from "../src/gateway/artifact-object-store-binding";
import { FsObjectStore } from "../src/gateway/pg-gateway-artifact-sink";
import { buildRuntimeArtifactObjectStoreBinding } from "../src/worker/artifact-object-store-binding";
import type { ArtifactLifecycleWorkerConfig, GatewayConfig } from "../src/config/env";
import type { PlainSecret, SecretRef, SecretStore } from "../../ts/core-types";
import {
  ARTIFACT_OBJECT_IO_EVIDENCE_SCHEMA_REF,
  type ArtifactRealObjectStorePortBinding,
} from "../../ts/runtime-contract";

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail !== undefined ? ` -- ${detail}` : ""}`);
  }
}

const SECRET_REF = "rpa/staging/artifact-lifecycle/object_store/s3" as SecretRef;
const GATEWAY_SECRET_REF = "rpa/staging/runtime-worker/object_store/s3-producer" as SecretRef;
const SECRET_VALUE = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" as PlainSecret;
const FS_BINDING: ArtifactRealObjectStorePortBinding = {
  kind: "real_object_store",
  backendAlias: "fs-local",
  credentialRef: SECRET_REF,
  evidenceSchemaRef: ARTIFACT_OBJECT_IO_EVIDENCE_SCHEMA_REF,
  mayBeUsedAsStagingEvidence: false,
};
const S3_BINDING: ArtifactRealObjectStorePortBinding = {
  kind: "real_object_store",
  backendAlias: "artifact-store",
  credentialRef: SECRET_REF,
  evidenceSchemaRef: ARTIFACT_OBJECT_IO_EVIDENCE_SCHEMA_REF,
  mayBeUsedAsStagingEvidence: true,
};

function lifecycleConfig(kind: "local_fs" | "s3", artifactDir: string): ArtifactLifecycleWorkerConfig {
  return {
    connectionString: "postgresql://artifact-lifecycle@db/rpa",
    workerId: "20000000-0000-4000-8000-0000000000aa",
    vaultArtifactLifecycle: kind === "s3" ? { addr: "https://vault.local", mount: "secret", roleId: "role", secretId: "secret" } : undefined,
    objectStore: kind === "local_fs"
      ? { mode: "local_fs", artifactDir, credentialRef: SECRET_REF, backendAlias: "fs-local" }
      : {
          mode: "s3",
          endpoint: "https://s3.us-east-1.amazonaws.com",
          region: "us-east-1",
          bucket: "examplebucket",
          accessKeyId: "test-s3-access-key-id",
          secretAccessKeyRef: SECRET_REF,
          backendAlias: "s3-staging",
          forcePathStyle: true,
        },
    artifactRetentionDays: 90,
    graphileConcurrency: 1,
    graphilePollIntervalMs: 2000,
  };
}

function gatewayConfig(kind: "fs" | "s3", artifactDir: string): GatewayConfig {
  return {
    codexBaseUrl: "https://api.example/v1",
    codexApiKey: "sk-test",
    codexModel: "model-a",
    codexMaxContextTokens: 8192,
    pricePer1kInputUsd: 0,
    pricePer1kOutputUsd: 0,
    idleTimeoutMs: 20_000,
    wallTimeoutMs: 120_000,
    retryMax: 2,
    fallbackAttempts: 1,
    repairAttempts: 1,
    artifactStore: kind === "fs"
      ? { mode: "fs", artifactDir }
      : {
          mode: "s3",
          endpoint: "https://s3.us-east-1.amazonaws.com",
          region: "us-east-1",
          bucket: "examplebucket",
          accessKeyId: "test-s3-access-key-id",
          secretAccessKeyRef: GATEWAY_SECRET_REF,
          backendAlias: "s3-producer",
          forcePathStyle: true,
        },
    ...(kind === "fs" ? { artifactDir } : {}),
    artifactRetentionDays: 90,
    budget: { maxInputTokens: 7372, maxOutputTokens: 4096, maxCost: 0.85 },
    promptTemplateVersion: "dom-executor@1",
  };
}

class RecordingSecretStore implements SecretStore {
  readonly refs: SecretRef[] = [];

  async resolve(ref: SecretRef): Promise<PlainSecret> {
    this.refs.push(ref);
    return SECRET_VALUE;
  }
}

const fsDir = mkdtempSync(join(tmpdir(), "rpa-runtime-artifact-store-"));
try {
  const fsSecrets = new RecordingSecretStore();
  const fsBinding = await buildRuntimeArtifactObjectStoreBinding({
    cfg: lifecycleConfig("local_fs", fsDir),
    secretStore: fsSecrets,
    binding: FS_BINDING,
  });
  check("fs binding exposes the same FsObjectStore to producers", fsBinding.artifactStore instanceof FsObjectStore);
  check("fs binding wires FsArtifactRedactor", fsBinding.artifactRedactor instanceof FsArtifactRedactor);
  check("fs binding wires FsArtifactRetentionStore", fsBinding.artifactRetentionStore instanceof FsArtifactRetentionStore);
  check("fs binding does not resolve object-store secret", fsSecrets.refs.length === 0, fsSecrets.refs.join(","));
  check("fs binding evidence is not staging-qualified", fsBinding.artifactRedactor.binding.kind === "real_object_store" && fsBinding.artifactRedactor.binding.mayBeUsedAsStagingEvidence === false);
  const fsRef = await fsBinding.artifactStore.putBytes(new Uint8Array([1, 2, 3]));
  check("fs producer store writes file refs", fsRef.startsWith("file://"), String(fsRef));
  const gatewayFsStore = await buildGatewayArtifactObjectStore(gatewayConfig("fs", fsDir), { secretStore: fsSecrets });
  check("gateway fs artifact store composes FsObjectStore", gatewayFsStore instanceof FsObjectStore);
  check("gateway fs artifact store does not resolve object-store secret", fsSecrets.refs.length === 0, fsSecrets.refs.join(","));
} finally {
  rmSync(fsDir, { recursive: true, force: true });
}

const s3Secrets = new RecordingSecretStore();
const s3Binding = await buildRuntimeArtifactObjectStoreBinding({
  cfg: lifecycleConfig("s3", fsDir),
  secretStore: s3Secrets,
  binding: S3_BINDING,
});
check("s3 binding exposes S3ObjectStore to producers", s3Binding.artifactStore instanceof S3ObjectStore);
check("s3 binding wires S3ArtifactRedactor", s3Binding.artifactRedactor instanceof S3ArtifactRedactor);
check("s3 binding wires S3ArtifactRetentionStore", s3Binding.artifactRetentionStore instanceof S3ArtifactRetentionStore);
check(
  "s3 binding resolves configured SecretRef exactly once",
  s3Secrets.refs.length === 1 && s3Secrets.refs[0] === SECRET_REF,
  s3Secrets.refs.join(","),
);
check("s3 binding evidence is staging-qualified", s3Binding.artifactRedactor.binding.kind === "real_object_store" && s3Binding.artifactRedactor.binding.mayBeUsedAsStagingEvidence === true);

const gatewayS3Secrets = new RecordingSecretStore();
const gatewayS3Store = await buildGatewayArtifactObjectStore(gatewayConfig("s3", fsDir), {
  secretStore: gatewayS3Secrets,
});
check("gateway s3 artifact store composes S3ObjectStore", gatewayS3Store instanceof S3ObjectStore);
check(
  "gateway s3 artifact store resolves configured producer SecretRef exactly once",
  gatewayS3Secrets.refs.length === 1 && gatewayS3Secrets.refs[0] === GATEWAY_SECRET_REF,
  gatewayS3Secrets.refs.join(","),
);

if (failures > 0) {
  console.error(`\nFAIL: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nPASS: runtime artifact object-store binding unit green");
