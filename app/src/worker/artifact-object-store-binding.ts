import { ArtifactRedactionContentTransform } from "../artifacts/artifact-redaction-content-transform";
import { FsArtifactRedactor, FsArtifactRetentionStore } from "../artifacts/fs-artifact-lifecycle-store";
import { S3ArtifactRedactor } from "../artifacts/s3-artifact-redactor";
import { S3ArtifactRetentionStore } from "../artifacts/s3-artifact-retention-store";
import { S3ObjectStore } from "../artifacts/s3-object-store";
import type { GatewayConfig, WorkerConfig } from "../config/env";
import { FsObjectStore, type ObjectStore } from "../gateway/pg-gateway-artifact-sink";
import type { PgRuntimeWorkerOptions } from "./runtime-worker";
import type { SecretRef, SecretStore } from "../../../ts/core-types";
import type { ArtifactRealObjectStorePortBinding } from "../../../ts/runtime-contract";

export type ArtifactLifecyclePorts = Required<Pick<PgRuntimeWorkerOptions, "artifactRedactor" | "artifactRetentionStore">>;

export interface RuntimeArtifactObjectStoreBinding extends ArtifactLifecyclePorts {
  readonly artifactStore: ObjectStore;
}

export async function buildRuntimeArtifactObjectStoreBinding(input: {
  readonly cfg: WorkerConfig;
  readonly gw: GatewayConfig;
  readonly secretStore: SecretStore;
  readonly binding: ArtifactRealObjectStorePortBinding;
}): Promise<RuntimeArtifactObjectStoreBinding> {
  if (input.cfg.artifactObjectStore.kind === "fs") {
    const store = new FsObjectStore(input.gw.artifactDir);
    return {
      artifactStore: store,
      artifactRedactor: new FsArtifactRedactor(
        store,
        input.binding,
        new ArtifactRedactionContentTransform(),
      ),
      artifactRetentionStore: new FsArtifactRetentionStore(store, input.binding),
    };
  }

  const secretAccessKey = await input.secretStore.resolve(input.cfg.artifactObjectStoreRef as SecretRef);
  const store = new S3ObjectStore({
    endpoint: input.cfg.artifactObjectStore.endpoint,
    region: input.cfg.artifactObjectStore.region,
    bucket: input.cfg.artifactObjectStore.bucket,
    accessKeyId: input.cfg.artifactObjectStore.accessKeyId,
    secretAccessKey,
    forcePathStyle: input.cfg.artifactObjectStore.forcePathStyle,
  });
  return {
    artifactStore: store,
    artifactRedactor: new S3ArtifactRedactor(
      store,
      input.binding,
      new ArtifactRedactionContentTransform(),
    ),
    artifactRetentionStore: new S3ArtifactRetentionStore(store, input.binding),
  };
}
