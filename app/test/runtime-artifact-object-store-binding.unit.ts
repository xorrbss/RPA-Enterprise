import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FsArtifactRedactor, FsArtifactRetentionStore } from "../src/artifacts/fs-artifact-lifecycle-store";
import { S3ArtifactRedactor } from "../src/artifacts/s3-artifact-redactor";
import { S3ArtifactRetentionStore } from "../src/artifacts/s3-artifact-retention-store";
import { S3ObjectStore } from "../src/artifacts/s3-object-store";
import { FsObjectStore } from "../src/gateway/pg-gateway-artifact-sink";
import { buildRuntimeArtifactObjectStoreBinding } from "../src/worker/artifact-object-store-binding";
import type { GatewayConfig, WorkerConfig } from "../src/config/env";
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
const SECRET_VALUE = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" as PlainSecret;
const BINDING: ArtifactRealObjectStorePortBinding = {
  kind: "real_object_store",
  backendAlias: "artifact-store",
  credentialRef: SECRET_REF,
  evidenceSchemaRef: ARTIFACT_OBJECT_IO_EVIDENCE_SCHEMA_REF,
};

const gw = (artifactDir: string): GatewayConfig => ({
  artifactDir,
  artifactRetentionDays: 90,
  codexBaseUrl: "http://127.0.0.1:1",
  codexApiKey: "test",
  codexModel: "test-model",
  codexMaxContextTokens: 1000,
  pricePer1kInputUsd: 0,
  pricePer1kOutputUsd: 0,
  idleTimeoutMs: 1000,
  wallTimeoutMs: 2000,
  retryMax: 0,
  fallbackAttempts: 0,
  repairAttempts: 0,
  promptTemplateVersion: "test",
  budget: { maxInputTokens: 1000, maxOutputTokens: 1000, maxCost: 0 },
});

function workerConfig(kind: "fs" | "s3"): WorkerConfig {
  return {
    vaultRuntimeWorker: { addr: "https://vault.local", mount: "secret", roleId: "role", secretId: "secret" },
    resumeTokenRef: "rpa/staging/runtime-worker/resume_token_hmac/active",
    browserSessionKeyRef: "rpa/staging/runtime-worker/browser_session/active",
    artifactObjectStoreRef: SECRET_REF,
    artifactObjectStore: kind === "fs"
      ? { kind: "fs" }
      : {
          kind: "s3",
          endpoint: "https://s3.us-east-1.amazonaws.com",
          region: "us-east-1",
          bucket: "examplebucket",
          accessKeyId: "AKIAIOSFODNN7EXAMPLE",
          forcePathStyle: true,
        },
    artifactObjectStoreBackendAlias: kind === "fs" ? "fs-local" : "s3-staging",
    graphileConcurrency: 1,
    graphilePollIntervalMs: 2000,
    maintenanceTenantIds: [],
    sinkDeliveryMaxAttempts: 3,
    sinkDeliveryRetryAfterMs: 5000,
    videoRecordingEnabled: false,
    videoFrameIntervalMs: 1000,
    videoFrameRate: 1,
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
    cfg: workerConfig("fs"),
    gw: gw(fsDir),
    secretStore: fsSecrets,
    binding: BINDING,
  });
  check("fs binding exposes the same FsObjectStore to producers", fsBinding.artifactStore instanceof FsObjectStore);
  check("fs binding wires FsArtifactRedactor", fsBinding.artifactRedactor instanceof FsArtifactRedactor);
  check("fs binding wires FsArtifactRetentionStore", fsBinding.artifactRetentionStore instanceof FsArtifactRetentionStore);
  check("fs binding does not resolve object-store secret", fsSecrets.refs.length === 0, fsSecrets.refs.join(","));
  const fsRef = await fsBinding.artifactStore.putBytes(new Uint8Array([1, 2, 3]));
  check("fs producer store writes file refs", fsRef.startsWith("file://"), String(fsRef));
} finally {
  rmSync(fsDir, { recursive: true, force: true });
}

const s3Secrets = new RecordingSecretStore();
const s3Binding = await buildRuntimeArtifactObjectStoreBinding({
  cfg: workerConfig("s3"),
  gw: gw(fsDir),
  secretStore: s3Secrets,
  binding: BINDING,
});
check("s3 binding exposes S3ObjectStore to producers", s3Binding.artifactStore instanceof S3ObjectStore);
check("s3 binding wires S3ArtifactRedactor", s3Binding.artifactRedactor instanceof S3ArtifactRedactor);
check("s3 binding wires S3ArtifactRetentionStore", s3Binding.artifactRetentionStore instanceof S3ArtifactRetentionStore);
check(
  "s3 binding resolves configured SecretRef exactly once",
  s3Secrets.refs.length === 1 && s3Secrets.refs[0] === SECRET_REF,
  s3Secrets.refs.join(","),
);

if (failures > 0) {
  console.error(`\nFAIL: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nPASS: runtime artifact object-store binding unit green");
