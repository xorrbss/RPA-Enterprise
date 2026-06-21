// reads.ts 에서 추출 — artifact 본문/목록 조회 라우트(동작 무변경, api-surface §5 / D8-A1).
// artifact.read RBAC + RLS 2단 게이트 + security-contracts §10 audit boundary(fail-closed).
import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";

import type { ObjectRef } from "../../../ts/core-types";
import {
  SECURITY_AUDIT_PAYLOAD_SCHEMA_REF,
  type CorrelationId,
  type IdempotencyKey,
  type IsoDateTime,
} from "../../../ts/security-middleware-contract";
import { withTenantTx } from "../db/pool";
import { ApiResponseError } from "./errors";
import { UUID_RE } from "./reads-support";
import { requirePrincipal, type ApiServerDeps } from "./server";

// artifact.read audit 보존일수 — worker artifact-lifecycle audit(DEFAULT_ARTIFACT_LIFECYCLE_AUDIT_RETENTION_DAYS=90)과
// 동일(비발명, 기존 artifact audit 보존 정책 재사용). 전용 ops-defaults 행 도입 시 그 값으로 대체.
const ARTIFACT_READ_AUDIT_RETENTION_DAYS = 90;

interface ArtifactRow {
  id: string;
  type: string | null;
  media_type: string | null;
  filename: string | null;
  byte_size: string | null;
  duration_ms: number | null;
  sha256: string | null;
  object_ref: string;
  redaction_status: string;
  retention_until: Date | null;
}


function safeMediaType(value: string | null): string {
  if (value === null) return "application/octet-stream";
  const trimmed = value.trim();
  if (/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+(?:\s*;\s*[A-Za-z0-9!#$&^_.+-]+=[A-Za-z0-9!#$&^_.+-]+)*$/.test(trimmed)) {
    return trimmed;
  }
  return "application/octet-stream";
}

function contentDisposition(filename: string | null, artifactId: string): string {
  const fallback = `artifact-${artifactId}.bin`;
  const safeName = sanitizeFilename(filename) ?? fallback;
  return `inline; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(safeName)}`;
}

function sanitizeFilename(filename: string | null): string | null {
  if (filename === null) return null;
  const trimmed = filename.trim().replace(/[\\/:*?"<>|\x00-\x1f\x7f]+/g, "_");
  if (trimmed.length === 0 || trimmed === "." || trimmed === "..") return null;
  return trimmed.slice(0, 180);
}


export function registerArtifactReadRoutes(app: FastifyInstance, deps: ApiServerDeps): void {
  // RLS(artifacts_visible_isolation)가 redacted/not_required·미삭제·비격리만 노출 → pending/failed/quarantined/deleted/
  // cross-tenant는 미존재로 떨어져 404(D8-A1: 존재 비노출; 409 ARTIFACT_NOT_REDACTED는 v1 미노출, BYPASSRLS 미사용).
  // 본문은 object store(redacted at rest)에서 read. artifactStore 미주입 시 미등록; scheme/bucket 불일치는 404 fail-closed.
  if (deps.artifactStore !== undefined) {
    const artifactStore = deps.artifactStore;
    // security-contracts §10: artifact.read 본문 disclosure는 audit boundary 없이 노출 불가(fail-closed).
    //   artifactStore가 있는데 securityAudit가 없으면 미설정(fail-open) — 라우트를 등록하지 않고 명시 차단.
    const securityAudit = deps.securityAudit;
    if (securityAudit === undefined) {
      throw new Error(
        "registerReadRoutes: artifactStore requires securityAudit — security-contracts §10은 artifact.read 본문 반환 전 audit boundary append를 강제한다(fail-closed)",
      );
    }
    app.get<{ Params: { generationId: string; artifactId: string } }>(
      "/v1/scenario-generations/:generationId/artifacts/:artifactId",
      { config: { rbacAction: "artifact.read" } },
      async (request, reply) => {
        const principal = requirePrincipal(request);
        const { generationId, artifactId } = request.params;
        if (!UUID_RE.test(generationId) || !UUID_RE.test(artifactId)) {
          throw new ApiResponseError("RESOURCE_NOT_FOUND");
        }
        const row = await withTenantTx(deps.pool, principal.tenantId, async (c) => {
          const result = await c.query<ArtifactRow>(
            `SELECT id, type, media_type, filename, byte_size::text AS byte_size, duration_ms,
                    sha256, object_ref, redaction_status, retention_until
               FROM artifacts
              WHERE tenant_id = $1::uuid AND generation_id = $2::uuid AND id = $3::uuid`,
            [principal.tenantId, generationId, artifactId],
          );
          return result.rows[0] ?? null;
        });
        if (row === null) {
          throw new ApiResponseError("RESOURCE_NOT_FOUND");
        }
        const content = await artifactStore.get(row.object_ref as ObjectRef);
        if (content === null) {
          request.log.error(
            { artifact_id: row.id, generation_id: generationId, correlation_id: request.correlationId },
            "scenario generation artifact object bytes missing for visible row — fail-closed 404 (data integrity)",
          );
          throw new ApiResponseError("RESOURCE_NOT_FOUND");
        }
        const occurredAt = new Date();
        await securityAudit.recordDecision(
          {
            tenantId: principal.tenantId,
            actor: { subjectId: principal.subjectId, roles: principal.roles },
            action: "artifact.read",
            outcome: "allow",
            resource: { kind: "artifact", id: row.id },
            reason: "artifact_body_disclosed",
            correlationId: request.correlationId as CorrelationId,
            idempotencyKey: randomUUID() as IdempotencyKey,
            occurredAt: occurredAt.toISOString() as IsoDateTime,
            retentionUntil: new Date(
              occurredAt.getTime() + ARTIFACT_READ_AUDIT_RETENTION_DAYS * 24 * 60 * 60 * 1000,
            ).toISOString() as IsoDateTime,
            payloadSchemaRef: SECURITY_AUDIT_PAYLOAD_SCHEMA_REF,
            failClosed: true,
            payload: {
              decision_kind: "artifact.read",
              artifact_id: row.id,
              generation_id: generationId,
              redaction_status: row.redaction_status,
            },
          },
          { artifact_id: row.id, generation_id: generationId },
        );
        reply.code(200).send({
          artifact_id: row.id,
          generation_id: generationId,
          type: row.type,
          media_type: row.media_type,
          filename: row.filename,
          byte_size: row.byte_size !== null ? Number(row.byte_size) : null,
          duration_ms: row.duration_ms,
          sha256: row.sha256,
          redaction_status: row.redaction_status,
          retention_until: row.retention_until !== null ? row.retention_until.toISOString() : null,
          content,
        });
      },
    );
    app.get<{ Params: { id: string } }>(
      "/v1/artifacts/:id",
      { config: { rbacAction: "artifact.read" } },
      async (request, reply) => {
        const principal = requirePrincipal(request);
        const id = request.params.id;
        if (!UUID_RE.test(id)) {
          throw new ApiResponseError("RESOURCE_NOT_FOUND");
        }
        const row = await withTenantTx(deps.pool, principal.tenantId, async (c) => {
          const result = await c.query<ArtifactRow>(
            `SELECT id, type, media_type, filename, byte_size::text AS byte_size, duration_ms,
                    sha256, object_ref, redaction_status, retention_until
               FROM artifacts WHERE id = $1::uuid`,
            [id],
          );
          return result.rows[0] ?? null;
        });
        if (row === null) {
          // RLS가 비가시(pending/failed/quarantined/deleted/cross-tenant) 행을 숨김 → 404(존재 비노출, D8-A1).
          // 여기서는 §10 audit를 남기지 않는다(의도적 scoping): RLS-숨김은 "이 테넌트에 해당 artifact가 존재하지 않음"
          // 이라 audit할 artifact.read 결정 대상이 없고(존재 비노출과도 정합), 역할-수준 RBAC deny는 본 핸들러 이전
          // preHandler(server.ts)에서 disclosure와 무관하게 차단된다. §10의 fail-closed 의무는 **본문 disclosure(allow)**
          // 경로에 적용한다. (deny/blocked까지 문자 그대로 audit하려면 별도 결정 필요 — RQ-019 노트.)
          throw new ApiResponseError("RESOURCE_NOT_FOUND");
        }
        // 본문은 redacted/not_required object(at rest 마스킹) — 평문 노출 없음(security-contracts §4/§9).
        // object를 audit **전에** 읽는다: 부재(null)면 disclosure 자체가 불가하므로 audit를 남기지 않고 fail-closed 404
        //   (RQ-022 — 가시 metadata인데 object bytes 부재 = 데이터 무결성 이슈; 미분류 500이 아니라 결정형 404).
        const content = await artifactStore.get(row.object_ref as ObjectRef);
        if (content === null) {
          // 운영 가시성: 무결성 이슈를 error 로깅(클라이언트엔 존재 비노출=404로만 표면화). §10 audit는 실제 disclosure만.
          request.log.error(
            { artifact_id: row.id, correlation_id: request.correlationId },
            "artifact object bytes missing for visible row — fail-closed 404 (data integrity)",
          );
          throw new ApiResponseError("RESOURCE_NOT_FOUND");
        }
        // security-contracts §10:147-148: artifact.read(allow=본문 disclosure) 결정을 **본문 반환 전** append-only
        //   audit log에 fail-closed로 남긴다(object 확인 후 = 실제 disclosure 경로). recordDecision throw 시 본문 미반환.
        const occurredAt = new Date();
        await securityAudit.recordDecision(
          {
            tenantId: principal.tenantId,
            actor: { subjectId: principal.subjectId, roles: principal.roles },
            action: "artifact.read",
            outcome: "allow",
            resource: { kind: "artifact", id: row.id },
            reason: "artifact_body_disclosed",
            correlationId: request.correlationId as CorrelationId,
            // 각 disclosure = 별개 audit 이벤트(idempotency_key UNIQUE). correlation 재사용에도 충돌 없게 per-read UUID.
            idempotencyKey: randomUUID() as IdempotencyKey,
            occurredAt: occurredAt.toISOString() as IsoDateTime,
            // artifact lifecycle audit 보존(worker DEFAULT_ARTIFACT_LIFECYCLE_AUDIT_RETENTION_DAYS=90)과 동일 — 비발명.
            retentionUntil: new Date(
              occurredAt.getTime() + ARTIFACT_READ_AUDIT_RETENTION_DAYS * 24 * 60 * 60 * 1000,
            ).toISOString() as IsoDateTime,
            payloadSchemaRef: SECURITY_AUDIT_PAYLOAD_SCHEMA_REF,
            failClosed: true,
            payload: { decision_kind: "artifact.read", artifact_id: row.id, redaction_status: row.redaction_status },
          },
          { artifact_id: row.id },
        );
        reply.code(200).send({
          artifact_id: row.id,
          type: row.type,
          media_type: row.media_type,
          filename: row.filename,
          byte_size: row.byte_size !== null ? Number(row.byte_size) : null,
          duration_ms: row.duration_ms,
          sha256: row.sha256,
          redaction_status: row.redaction_status,
          retention_until: row.retention_until !== null ? row.retention_until.toISOString() : null,
          content,
        });
      },
    );
    app.get<{ Params: { id: string } }>(
      "/v1/artifacts/:id/blob",
      { config: { rbacAction: "artifact.read" } },
      async (request, reply) => {
        const principal = requirePrincipal(request);
        const id = request.params.id;
        if (!UUID_RE.test(id)) {
          throw new ApiResponseError("RESOURCE_NOT_FOUND");
        }
        const row = await withTenantTx(deps.pool, principal.tenantId, async (c) => {
          const result = await c.query<ArtifactRow>(
            `SELECT id, type, media_type, filename, byte_size::text AS byte_size, duration_ms,
                    sha256, object_ref, redaction_status, retention_until
               FROM artifacts WHERE id = $1::uuid`,
            [id],
          );
          return result.rows[0] ?? null;
        });
        if (row === null) {
          throw new ApiResponseError("RESOURCE_NOT_FOUND");
        }
        const bytes = await artifactStore.getBytes(row.object_ref as ObjectRef);
        if (bytes === null) {
          request.log.error(
            { artifact_id: row.id, correlation_id: request.correlationId },
            "artifact object raw bytes missing for visible row - fail-closed 404 (data integrity)",
          );
          throw new ApiResponseError("RESOURCE_NOT_FOUND");
        }
        const occurredAt = new Date();
        await securityAudit.recordDecision(
          {
            tenantId: principal.tenantId,
            actor: { subjectId: principal.subjectId, roles: principal.roles },
            action: "artifact.read",
            outcome: "allow",
            resource: { kind: "artifact", id: row.id },
            reason: "artifact_blob_disclosed",
            correlationId: request.correlationId as CorrelationId,
            idempotencyKey: randomUUID() as IdempotencyKey,
            occurredAt: occurredAt.toISOString() as IsoDateTime,
            retentionUntil: new Date(
              occurredAt.getTime() + ARTIFACT_READ_AUDIT_RETENTION_DAYS * 24 * 60 * 60 * 1000,
            ).toISOString() as IsoDateTime,
            payloadSchemaRef: SECURITY_AUDIT_PAYLOAD_SCHEMA_REF,
            failClosed: true,
            payload: {
              decision_kind: "artifact.read",
              delivery: "blob",
              artifact_id: row.id,
              redaction_status: row.redaction_status,
            },
          },
          { artifact_id: row.id },
        );
        const body = Buffer.from(bytes);
        reply
          .code(200)
          .type(safeMediaType(row.media_type))
          .header("Cache-Control", "no-store")
          .header("Content-Length", String(body.byteLength))
          .header("Content-Disposition", contentDisposition(row.filename, row.id))
          .send(body);
      },
    );
  }
}
