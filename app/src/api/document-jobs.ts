import type { FastifyInstance, FastifyRequest } from "fastify";

import { withTenantTx } from "../db/pool";
import { runIdempotentCommand } from "./command";
import {
  createDocumentJob,
  createValidationTask,
  extractDocumentJob,
  recordExternalDocumentExtraction,
} from "./document-jobs-commands";
import {
  parseCreateBody,
  parseExternalExtractionBody,
  requireEmptyBody,
  statusFilter,
  validateJobId,
} from "./document-jobs-parse";
import {
  assertDocumentJobExists,
  mapExtraction,
  mapJob,
  selectDocumentJob,
  selectExtraction,
  type DocumentJobRow,
} from "./document-jobs-store";
import { ApiResponseError } from "../runtime/errors";
import { paginate, parsePageParams } from "./list-query";
import { requirePrincipal, type ApiServerDeps } from "./server-shared";

export function registerDocumentJobRoutes(app: FastifyInstance, deps: ApiServerDeps): void {
  app.get("/v1/document-jobs", { config: { rbacAction: "document_job.read" } }, async (request, reply) => {
    const principal = requirePrincipal(request);
    const query = request.query as Record<string, unknown>;
    const { limit, cursor } = parsePageParams(query);
    const status = statusFilter(query.status);
    const rows = await withTenantTx(deps.pool, principal.tenantId, async (client) => {
      const result = await client.query<DocumentJobRow>(
        `SELECT id, source_artifact_id, source_run_id, document_type, field_schema, status,
                created_by, created_at, updated_at, created_at::text AS cursor_at
           FROM document_jobs
          WHERE tenant_id = $1::uuid
            AND deleted_at IS NULL
            AND ($2::text IS NULL OR status = $2)
            AND ($3::timestamptz IS NULL OR (created_at, id) < ($3::timestamptz, $4::uuid))
          ORDER BY created_at DESC, id DESC
          LIMIT $5`,
        [principal.tenantId, status ?? null, cursor?.createdAt ?? null, cursor?.id ?? null, limit + 1],
      );
      return result.rows;
    });
    reply.code(200).send(paginate(rows, limit, (row) => ({ createdAt: row.cursor_at, id: row.id }), mapJob));
  });

  app.post("/v1/document-jobs", { config: { rbacAction: "document_job.manage" } }, async (request, reply) => {
    const body = parseCreateBody(request.body);
    const result = await runIdempotentCommand(deps, request, "createDocumentJob", "/v1/document-jobs", (client, tenantId) =>
      createDocumentJob(client, tenantId, request, body),
    );
    reply.code(result.status).send(result.body);
  });

  app.get<{ Params: { jobId: string } }>(
    "/v1/document-jobs/:jobId",
    { config: { rbacAction: "document_job.read" } },
    async (request, reply) => {
      const row = await requireDocumentJob(deps, request, request.params.jobId);
      reply.code(200).send(mapJob(row));
    },
  );

  app.post<{ Params: { jobId: string } }>(
    "/v1/document-jobs/:jobId/extract",
    { config: { rbacAction: "document_job.manage" } },
    async (request, reply) => {
      requireEmptyBody(request.body);
      const jobId = validateJobId(request.params.jobId);
      const result = await runIdempotentCommand(deps, request, "extractDocumentJob", `/v1/document-jobs/${jobId}/extract`, (client, tenantId) =>
        extractDocumentJob(deps, client, tenantId, request, jobId),
      );
      reply.code(result.status).send(result.body);
    },
  );

  app.post<{ Params: { jobId: string } }>(
    "/v1/document-jobs/:jobId/external-extractions",
    { config: { rbacAction: "document_job.manage" } },
    async (request, reply) => {
      const body = parseExternalExtractionBody(request.body);
      const jobId = validateJobId(request.params.jobId);
      const result = await runIdempotentCommand(
        deps,
        request,
        "recordExternalDocumentExtraction",
        `/v1/document-jobs/${jobId}/external-extractions`,
        (client, tenantId) => recordExternalDocumentExtraction(client, tenantId, jobId, body),
      );
      reply.code(result.status).send(result.body);
    },
  );

  app.get<{ Params: { jobId: string } }>(
    "/v1/document-jobs/:jobId/extraction",
    { config: { rbacAction: "document_job.read" } },
    async (request, reply) => {
      const jobId = validateJobId(request.params.jobId);
      const principal = requirePrincipal(request);
      const row = await withTenantTx(deps.pool, principal.tenantId, async (client) => {
        await assertDocumentJobExists(client, jobId);
        return selectExtraction(client, jobId);
      });
      if (row === null) throw new ApiResponseError("RESOURCE_NOT_FOUND", { reason: "document_extraction_not_found" });
      reply.code(200).send(mapExtraction(row));
    },
  );

  app.post<{ Params: { jobId: string } }>(
    "/v1/document-jobs/:jobId/validation-task",
    { config: { rbacAction: "document_job.manage" } },
    async (request, reply) => {
      requireEmptyBody(request.body);
      const jobId = validateJobId(request.params.jobId);
      const result = await runIdempotentCommand(
        deps,
        request,
        "createDocumentValidationTask",
        `/v1/document-jobs/${jobId}/validation-task`,
        (client, tenantId) => createValidationTask(client, tenantId, request, jobId),
      );
      reply.code(result.status).send(result.body);
    },
  );
}

async function requireDocumentJob(deps: ApiServerDeps, request: FastifyRequest, rawId: string): Promise<DocumentJobRow> {
  const id = validateJobId(rawId);
  const principal = requirePrincipal(request);
  const row = await withTenantTx(deps.pool, principal.tenantId, (client) => selectDocumentJob(client, id));
  if (row === null) throw new ApiResponseError("RESOURCE_NOT_FOUND");
  return row;
}
