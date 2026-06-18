import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ArtifactRef, ObjectRef, SecretRef } from "../../ts/core-types";
import type { CorrelationId, TenantId } from "../../ts/security-middleware-contract";
import type {
  ArtifactLifecycleOperationalAudit,
  ArtifactLifecycleTarget,
  ArtifactRealObjectStorePortBinding,
  ArtifactRedactionRequest,
  ArtifactRetentionDeleteRequest,
} from "../../ts/runtime-contract";
import { ArtifactRedactionContentTransform } from "../src/artifacts/artifact-redaction-content-transform";
import {
  FsArtifactRedactor,
  FsArtifactRetentionStore,
} from "../src/artifacts/fs-artifact-lifecycle-store";
import { FsObjectStore } from "../src/gateway/pg-gateway-artifact-sink";

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` - ${detail}` : ""}`);
  }
}

const TENANT_ID = "tenant-1" as TenantId;
const CORRELATION_ID = "corr-fs-artifact" as CorrelationId;
const CREDENTIAL_REF = "rpa/staging/artifact-lifecycle/object_store/fs" as SecretRef;
const BACKEND_ALIAS = "fs-local";

const REAL_BINDING: ArtifactRealObjectStorePortBinding = {
  kind: "real_object_store",
  backendAlias: BACKEND_ALIAS,
  credentialRef: CREDENTIAL_REF,
  evidenceSchemaRef: "artifact/object-io-evidence@1",
};

function redactionAudit(): ArtifactLifecycleOperationalAudit & { useCase: "artifact_redaction_job" } {
  return {
    useCase: "artifact_redaction_job",
    action: "bypassrls.use",
    failClosed: true,
    correlationId: CORRELATION_ID,
    reasonCode: "artifact_lifecycle.redaction.object_io",
  };
}

function retentionAudit(): ArtifactLifecycleOperationalAudit & { useCase: "artifact_retention_sweeper" } {
  return {
    useCase: "artifact_retention_sweeper",
    action: "bypassrls.use",
    failClosed: true,
    correlationId: CORRELATION_ID,
    reasonCode: "artifact_lifecycle.retention.object_delete",
  };
}

function target(input: { artifactRef: ArtifactRef; objectRef: ObjectRef; type: string }): ArtifactLifecycleTarget {
  return {
    tenantId: TENANT_ID,
    artifactRef: input.artifactRef,
    objectRef: input.objectRef,
    type: input.type,
    redactionStatus: "pending",
    redactionAttempts: 0,
    legalHold: false,
    quarantine: false,
  };
}

function redactionRequest(input: { artifactRef: ArtifactRef; objectRef: ObjectRef; type: string }): ArtifactRedactionRequest {
  return {
    tenantId: TENANT_ID,
    correlationId: CORRELATION_ID,
    artifact: target(input),
    policy: { maxAttempts: 3 },
    portBinding: REAL_BINDING,
    audit: redactionAudit(),
  };
}

function retentionRequest(input: { artifactRef: ArtifactRef; objectRef: ObjectRef; type?: string }): ArtifactRetentionDeleteRequest {
  return {
    tenantId: TENANT_ID,
    correlationId: CORRELATION_ID,
    artifact: {
      ...target({
        artifactRef: input.artifactRef,
        objectRef: input.objectRef,
        type: input.type ?? "llm_output",
      }),
      redactionStatus: "redacted",
    },
    jobId: "job-fs-retention",
    policy: { deleteReason: "retention_expired" },
    portBinding: REAL_BINDING,
    audit: retentionAudit(),
  };
}

function assertNoForbidden(label: string, value: unknown, forbidden: readonly string[]): void {
  const text = JSON.stringify(value) ?? "";
  const leaks = forbidden.filter((item) => text.includes(item));
  if (/"objectRef"\s*:/.test(text)) leaks.push("objectRef-key");
  check(`${label}: evidence hides ObjectRef/private values`, leaks.length === 0, leaks.join(","));
}

function isPng(bytes: Uint8Array | null): boolean {
  return (
    bytes !== null &&
    bytes.length > 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  );
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "rpa-fs-artifact-lifecycle-"));
  try {
    const store = new FsObjectStore(dir);
    const redactor = new FsArtifactRedactor(store, REAL_BINDING, new ArtifactRedactionContentTransform());
    const retention = new FsArtifactRetentionStore(store, REAL_BINDING);

    {
      const sourcePng = new Uint8Array([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
        0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
        0xff, 0xd8, 0xff, 0xe0,
      ]);
      const sourceRef = await store.putBytes(sourcePng);
      const artifactRef = "artifact-fs-screenshot" as ArtifactRef;
      const result = await redactor.redact(redactionRequest({ artifactRef, objectRef: sourceRef, type: "screenshot" }));
      check("screenshot redaction returns redacted", result.kind === "redacted", result.kind);
      if (result.kind === "redacted") {
        const redactedBytes = await store.getBytes(result.redactedObjectRef);
        check("screenshot redaction writes a PNG placeholder", isPng(redactedBytes));
        check("screenshot redaction writes a new object", result.redactedObjectRef !== sourceRef);
        check("screenshot redaction sha256 matches bytes",
          redactedBytes !== null && result.sha256 === createHash("sha256").update(redactedBytes).digest("hex"),
          result.sha256,
        );
        check(
          "screenshot redaction does not copy raw source bytes",
          redactedBytes !== null && Buffer.compare(Buffer.from(redactedBytes), Buffer.from(sourcePng)) !== 0,
        );
        assertNoForbidden("screenshot redaction", result.evidence, [String(sourceRef), CREDENTIAL_REF.replace("/fs", "/raw")]);
      }
    }

    {
      const maskedPng = new Uint8Array([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
        0x01, 0x02, 0x03, 0x04,
      ]);
      const sourceRef = await store.putBytes(maskedPng);
      const result = await redactor.redact(redactionRequest({
        artifactRef: "artifact-fs-masked-screenshot" as ArtifactRef,
        objectRef: sourceRef,
        type: "screenshot_masked",
      }));
      check("capture-masked screenshot redaction returns redacted", result.kind === "redacted", result.kind);
      if (result.kind === "redacted") {
        const redactedBytes = await store.getBytes(result.redactedObjectRef);
        check(
          "capture-masked screenshot preserves useful masked image bytes",
          redactedBytes !== null && Buffer.compare(Buffer.from(redactedBytes), Buffer.from(maskedPng)) === 0,
        );
        check("capture-masked screenshot still writes a new object", result.redactedObjectRef !== sourceRef);
      }
    }

    {
      const maskedWebm = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x02, 0x03, 0x04]);
      const sourceRef = await store.putBytes(maskedWebm);
      const result = await redactor.redact(redactionRequest({
        artifactRef: "artifact-fs-masked-video" as ArtifactRef,
        objectRef: sourceRef,
        type: "video_masked",
      }));
      check("capture-masked video redaction returns redacted", result.kind === "redacted", result.kind);
      if (result.kind === "redacted") {
        const redactedBytes = await store.getBytes(result.redactedObjectRef);
        check(
          "capture-masked video preserves useful masked WebM bytes",
          redactedBytes !== null && Buffer.compare(Buffer.from(redactedBytes), Buffer.from(maskedWebm)) === 0,
        );
        check("capture-masked video still writes a new object", result.redactedObjectRef !== sourceRef);
      }
    }

    {
      const sourceRef = await store.putBytes(new TextEncoder().encode("not a video"));
      const result = await redactor.redact(redactionRequest({
        artifactRef: "artifact-fs-bad-masked-video" as ArtifactRef,
        objectRef: sourceRef,
        type: "video_masked",
      }));
      check("capture-masked video without video signature fails closed", result.kind === "terminal_failed", result.kind);
    }

    {
      const sourceText = "password: open-sesame\nemail: ada@example.com";
      const sourceRef = await store.putBytes(new TextEncoder().encode(sourceText));
      const artifactRef = "artifact-fs-text" as ArtifactRef;
      const result = await redactor.redact(redactionRequest({ artifactRef, objectRef: sourceRef, type: "llm_output" }));
      check("text redaction returns redacted", result.kind === "redacted", result.kind);
      if (result.kind === "redacted") {
        const redactedBytes = await store.getBytes(result.redactedObjectRef);
        const redactedText = redactedBytes === null ? "" : new TextDecoder().decode(redactedBytes);
        check("text redaction removes credential value", !redactedText.includes("open-sesame"), redactedText);
        check("text redaction removes email value", !redactedText.includes("ada@example.com"), redactedText);
        check("text redaction keeps mask labels", redactedText.includes("[REDACTED:credential]"));
      }
    }

    {
      const sourceRef = await store.putBytes(new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]));
      const result = await redactor.redact(redactionRequest({
        artifactRef: "artifact-fs-video" as ArtifactRef,
        objectRef: sourceRef,
        type: "video",
      }));
      check("video redaction remains fail-closed", result.kind === "terminal_failed", result.kind);
    }

    {
      const sourceRef = await store.putBytes(new TextEncoder().encode("temporary redacted content"));
      const artifactRef = "artifact-fs-retention" as ArtifactRef;
      const deleted = await retention.deleteObject(retentionRequest({ artifactRef, objectRef: sourceRef }));
      check("retention existing object returns deleted", deleted.kind === "deleted", deleted.kind);
      check("retention existing object removes bytes", (await store.getBytes(sourceRef)) === null);
      if (deleted.kind === "deleted") assertNoForbidden("retention deleted", deleted.evidence, [String(sourceRef)]);

      const notFound = await retention.deleteObject(retentionRequest({ artifactRef, objectRef: sourceRef }));
      check("retention missing object returns not_found", notFound.kind === "not_found", notFound.kind);
      if (notFound.kind === "not_found") assertNoForbidden("retention not_found", notFound.evidence, [String(sourceRef)]);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\nfs-artifact-lifecycle.unit: ${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

void main();
