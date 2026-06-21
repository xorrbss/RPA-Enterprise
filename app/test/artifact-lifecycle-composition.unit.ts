/**
 * Unit test - artifact lifecycle worker object-store composition.
 *
 * Verifies the production composition root can assemble either explicit local_fs
 * lifecycle ports or the default S3-compatible ports without live network I/O.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { markPlainSecretFromStore } from "../../security/compliance-scaffold";
import type { PlainSecret, SecretRef, SecretStore } from "../../ts/core-types";
import { FsArtifactRedactor, FsArtifactRetentionStore } from "../src/artifacts/fs-artifact-lifecycle-store";
import { S3ArtifactRedactor } from "../src/artifacts/s3-artifact-redactor";
import { S3ArtifactRetentionStore } from "../src/artifacts/s3-artifact-retention-store";
import type { S3HttpTransport } from "../src/artifacts/s3-object-store";
import type { ArtifactLifecycleWorkerConfig } from "../src/config/env";
import { buildArtifactLifecycleWorkerOptions } from "../src/main-worker";

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail !== undefined ? ` - ${detail}` : ""}`);
  }
}

async function expectThrow(label: string, fn: () => Promise<unknown>): Promise<void> {
  let threw = false;
  try {
    await fn();
  } catch {
    threw = true;
  }
  check(label, threw, "expected throw, got none");
}

class RecordingSecretStore implements SecretStore {
  readonly refs: string[] = [];

  async resolve(ref: SecretRef): Promise<PlainSecret> {
    this.refs.push(String(ref));
    return markPlainSecretFromStore("resolved-s3-secret-access-key");
  }
}

const S3_SECRET_REF = "rpa/staging/artifact-lifecycle/object_store/s3";
const WORKER_ID = "20000000-0000-4000-8000-0000000000aa";

function s3Config(): ArtifactLifecycleWorkerConfig {
  return {
    connectionString: "postgresql://lifecycle@db/rpa",
    workerId: WORKER_ID,
    vaultArtifactLifecycle: {
      addr: "https://vault.example.internal",
      mount: "secret",
      roleId: "artifact-role",
      secretId: "artifact-secret",
    },
    objectStore: {
      mode: "s3",
      endpoint: "https://s3.example.internal",
      region: "ap-northeast-2",
      bucket: "rpa-artifacts",
      accessKeyId: "artifact-lifecycle-access-key-id",
      secretAccessKeyRef: S3_SECRET_REF,
      backendAlias: "s3-compatible",
      forcePathStyle: true,
    },
    artifactRetentionDays: 90,
    graphileConcurrency: 1,
    graphilePollIntervalMs: 2000,
  };
}

function localConfig(artifactDir: string): ArtifactLifecycleWorkerConfig {
  return {
    connectionString: "postgresql://lifecycle@db/rpa",
    workerId: WORKER_ID,
    objectStore: {
      mode: "local_fs",
      artifactDir,
      credentialRef: "rpa/local/artifact-lifecycle/object_store/fs",
      backendAlias: "fs-local",
    },
    artifactRetentionDays: 30,
    graphileConcurrency: 1,
    graphilePollIntervalMs: 2000,
  };
}

async function main(): Promise<void> {
  {
    const secretStore = new RecordingSecretStore();
    let transportCalls = 0;
    const transport: S3HttpTransport = async () => {
      transportCalls += 1;
      throw new Error("composition test must not perform S3 network I/O");
    };
    const cfg = s3Config();
    const options = await buildArtifactLifecycleWorkerOptions(cfg, { secretStore, s3Transport: transport });

    check("s3 workerId carried", options.workerId === WORKER_ID);
    check("s3 audit retention carried", options.artifactLifecycleAuditRetentionDays === 90);
    check("s3 redactor composed", options.artifactRedactor instanceof S3ArtifactRedactor);
    check("s3 retention store composed", options.artifactRetentionStore instanceof S3ArtifactRetentionStore);
    check("s3 SecretStore resolves exactly ARTIFACT_OBJECT_STORE_REF", secretStore.refs.length === 1 && secretStore.refs[0] === S3_SECRET_REF, secretStore.refs.join(","));
    check("s3 composition performs no object-store network I/O", transportCalls === 0, String(transportCalls));
    check("s3 evidence binding uses SecretRef identifier", options.artifactRedactor?.binding.kind === "real_object_store" && options.artifactRedactor.binding.credentialRef === S3_SECRET_REF);
    check("s3 evidence binding uses backend alias", options.artifactRetentionStore?.binding.kind === "real_object_store" && options.artifactRetentionStore.binding.backendAlias === "s3-compatible");
    check("s3 evidence binding is staging-qualified", options.artifactRedactor?.binding.kind === "real_object_store" && options.artifactRedactor.binding.mayBeUsedAsStagingEvidence === true);
    check("s3 env/config shape has no secret value", !JSON.stringify(cfg).includes("resolved-s3-secret-access-key"));
  }

  await expectThrow("s3 composition without SecretStore throws", () => buildArtifactLifecycleWorkerOptions(s3Config()));

  {
    const dir = mkdtempSync(join(tmpdir(), "rpa-artifact-lifecycle-"));
    try {
      const options = await buildArtifactLifecycleWorkerOptions(localConfig(dir));
      check("local workerId carried", options.workerId === WORKER_ID);
      check("local audit retention carried", options.artifactLifecycleAuditRetentionDays === 30);
      check("local redactor composed", options.artifactRedactor instanceof FsArtifactRedactor);
      check("local retention store composed", options.artifactRetentionStore instanceof FsArtifactRetentionStore);
      check("local evidence binding uses explicit SecretRef", options.artifactRedactor?.binding.kind === "real_object_store" && options.artifactRedactor.binding.credentialRef === "rpa/local/artifact-lifecycle/object_store/fs");
      check("local evidence binding uses fs alias", options.artifactRetentionStore?.binding.kind === "real_object_store" && options.artifactRetentionStore.binding.backendAlias === "fs-local");
      check("local evidence binding is not staging-qualified", options.artifactRedactor?.binding.kind === "real_object_store" && options.artifactRedactor.binding.mayBeUsedAsStagingEvidence === false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  console.log(`\nartifact-lifecycle-composition.unit: ${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

void main();
