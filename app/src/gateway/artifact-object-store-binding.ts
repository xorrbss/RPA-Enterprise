import type { SecretRef, SecretStore } from "../../../ts/core-types";
import { S3ObjectStore, type S3HttpTransport } from "../artifacts/s3-object-store";
import type { GatewayConfig } from "../config/env";
import { FsObjectStore, type ObjectStore } from "./pg-gateway-artifact-sink";

export interface GatewayArtifactObjectStoreDeps {
  readonly secretStore?: SecretStore;
  readonly s3Transport?: S3HttpTransport;
}

export async function buildGatewayArtifactObjectStore(
  cfg: GatewayConfig,
  deps: GatewayArtifactObjectStoreDeps = {},
): Promise<ObjectStore> {
  if (cfg.artifactStore.mode === "fs") {
    return new FsObjectStore(cfg.artifactStore.artifactDir);
  }

  const secretStore = deps.secretStore;
  if (secretStore === undefined) {
    throw new Error("gateway S3 artifact store requires a SecretStore for GATEWAY_ARTIFACT_OBJECT_STORE_REF");
  }
  const secretAccessKey = await secretStore.resolve(cfg.artifactStore.secretAccessKeyRef as SecretRef);
  return new S3ObjectStore({
    endpoint: cfg.artifactStore.endpoint,
    region: cfg.artifactStore.region,
    bucket: cfg.artifactStore.bucket,
    accessKeyId: cfg.artifactStore.accessKeyId,
    secretAccessKey,
    forcePathStyle: cfg.artifactStore.forcePathStyle,
    ...(deps.s3Transport !== undefined ? { transport: deps.s3Transport } : {}),
  });
}
