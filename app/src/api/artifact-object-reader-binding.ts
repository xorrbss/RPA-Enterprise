import type { ObjectRef, SecretRef } from "../../../ts/core-types";
import { S3ObjectStore } from "../artifacts/s3-object-store";
import type { ApiConfig } from "../config/env";
import { FsObjectStore } from "../gateway/pg-gateway-artifact-sink";
import { VaultSecretStore } from "../secrets/vault-secret-store";
import type { ArtifactObjectReader } from "./server";

interface SchemeRoutingArtifactObjectReaderOptions {
  readonly fs?: ArtifactObjectReader;
  readonly s3?: ArtifactObjectReader;
  readonly s3Bucket?: string;
}

export class SchemeRoutingArtifactObjectReader implements ArtifactObjectReader {
  constructor(private readonly options: SchemeRoutingArtifactObjectReaderOptions) {}

  async get(objectRef: ObjectRef): Promise<string | null> {
    const reader = this.selectReader(objectRef);
    return reader === null ? null : reader.get(objectRef);
  }

  async getBytes(objectRef: ObjectRef): Promise<Uint8Array | null> {
    const reader = this.selectReader(objectRef);
    return reader === null ? null : reader.getBytes(objectRef);
  }

  private selectReader(objectRef: ObjectRef): ArtifactObjectReader | null {
    const ref = String(objectRef);
    if (ref.startsWith("file://")) return this.options.fs ?? null;
    if (this.options.s3Bucket !== undefined && ref.startsWith(`s3://${this.options.s3Bucket}/`)) {
      return this.options.s3 ?? null;
    }
    if (ref.startsWith("s3://")) return null;
    return null;
  }
}

export async function buildApiArtifactObjectReader(
  cfg: Pick<ApiConfig, "artifactDir" | "artifactObjectStore">,
): Promise<ArtifactObjectReader | undefined> {
  const fs = cfg.artifactDir !== undefined ? new FsObjectStore(cfg.artifactDir) : undefined;
  const s3 = cfg.artifactObjectStore !== undefined ? await buildS3Reader(cfg.artifactObjectStore) : undefined;
  if (fs === undefined && s3 === undefined) return undefined;
  return new SchemeRoutingArtifactObjectReader({
    ...(fs !== undefined ? { fs } : {}),
    ...(s3 !== undefined ? { s3: s3.reader, s3Bucket: s3.bucket } : {}),
  });
}

async function buildS3Reader(cfg: NonNullable<ApiConfig["artifactObjectStore"]>): Promise<{
  readonly reader: S3ObjectStore;
  readonly bucket: string;
}> {
  const secretStore = new VaultSecretStore({
    baseUrl: cfg.vaultApi.addr,
    mount: cfg.vaultApi.mount,
    kvApiVersion: 2,
    appRole: { roleId: cfg.vaultApi.roleId, secretId: cfg.vaultApi.secretId },
  });
  const secretAccessKey = await secretStore.resolve(cfg.objectStoreRef as SecretRef);
  return {
    bucket: cfg.objectStore.bucket,
    reader: new S3ObjectStore({
      endpoint: cfg.objectStore.endpoint,
      region: cfg.objectStore.region,
      bucket: cfg.objectStore.bucket,
      accessKeyId: cfg.objectStore.accessKeyId,
      secretAccessKey,
      forcePathStyle: cfg.objectStore.forcePathStyle,
    }),
  };
}
