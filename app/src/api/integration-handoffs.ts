import type { FastifyInstance } from "fastify";

import type { SecretRef } from "../../../ts/core-types";
import { withTenantTx } from "../db/pool";
import { runIdempotentCommand } from "./command";
import { ApiResponseError } from "../runtime/errors";
import {
  integrationHandoffCallbackPrincipal,
  parseCallbackRequest,
  parseCreateRequest,
  parseDispatchRequest,
  parseProviderCallbackHeaders,
  parseSafeString,
  parseStatusFilter,
  parseUuid,
  parseUuidNotFound,
  requireIdempotencyHeader,
} from "./integration-handoffs-parse";
import {
  assertDispatchableHandoff,
  insertIntegrationHandoff,
  insertIntegrationHandoffDispatchAttempt,
  listIntegrationHandoffs,
  mapHandoff,
  recordIntegrationHandoffReceipt,
  selectIntegrationHandoffForAuth,
  selectIntegrationHandoffRow,
} from "./integration-handoffs-store";
import { paginate, parsePageParams } from "./list-query";
import { requirePrincipal, type ApiServerDeps } from "./server-shared";
import { verifyWebhookSignature, webhookSigningPayload } from "./webhook-trigger-auth";

export function registerIntegrationHandoffRoutes(app: FastifyInstance, deps: ApiServerDeps): void {
  app.get("/v1/integration-handoffs", { config: { rbacAction: "integration.handoff" } }, async (request, reply) => {
    const principal = requirePrincipal(request);
    const query = request.query as Record<string, unknown>;
    const page = parsePageParams(query);
    const status = parseStatusFilter(query.status);
    const providerAlias = query.provider_alias === undefined ? undefined : parseSafeString(query.provider_alias, "provider_alias", 1, 120);

    const rows = await withTenantTx(deps.pool, principal.tenantId, (client) =>
      listIntegrationHandoffs(client, principal.tenantId, page.limit, page.cursor, status, providerAlias),
    );
    reply.code(200).send(paginate(rows, page.limit, (row) => ({ createdAt: row.cursor_at, id: row.id }), mapHandoff));
  });

  app.post("/v1/integration-handoffs", { config: { rbacAction: "integration.handoff" } }, async (request, reply) => {
    const principal = requirePrincipal(request);
    const body = parseCreateRequest(request.body);
    const response = await runIdempotentCommand(
      deps,
      request,
      "createIntegrationHandoff",
      "/v1/integration-handoffs",
      async (client, tenantId) => {
        const item = await insertIntegrationHandoff(
          client,
          tenantId,
          principal.subjectId,
          requireIdempotencyHeader(request.headers["idempotency-key"]),
          body,
        );
        return { status: 202, body: item };
      },
    );
    reply.code(response.status).send(response.body);
  });

  app.post<{ Params: { handoff_id: string } }>(
    "/v1/integration-handoffs/:handoff_id/dispatch",
    { config: { rbacAction: "integration.handoff" } },
    async (request, reply) => {
      if (deps.enqueuer.enqueueIntegrationHandoffDispatch === undefined) {
        throw new ApiResponseError("CONTROL_PLANE_INTERNAL_ERROR", { reason: "integration_handoff_dispatch_enqueuer_not_configured" });
      }
      const principal = requirePrincipal(request);
      const handoffId = parseUuid(request.params.handoff_id, "handoff_id");
      const body = parseDispatchRequest(request.body);
      const enqueueIntegrationHandoffDispatch = deps.enqueuer.enqueueIntegrationHandoffDispatch.bind(deps.enqueuer);
      const response = await runIdempotentCommand(
        deps,
        request,
        "dispatchIntegrationHandoff",
        `/v1/integration-handoffs/${handoffId}/dispatch`,
        async (client, tenantId) => {
          const handoff = await selectIntegrationHandoffRow(client, tenantId, handoffId);
          if (handoff === undefined) {
            throw new ApiResponseError("RESOURCE_NOT_FOUND", { reason: "integration_handoff_not_found" });
          }
          assertDispatchableHandoff(handoff);
          const attempt = await insertIntegrationHandoffDispatchAttempt(
            client,
            tenantId,
            handoff,
            principal.subjectId,
            requireIdempotencyHeader(request.headers["idempotency-key"]),
            body,
          );
          await enqueueIntegrationHandoffDispatch(client, {
            tenantId,
            attemptId: attempt.attempt_id,
            correlationId: request.correlationId,
          });
          return { status: 202, body: attempt };
        },
      );
      reply.code(response.status).send(response.body);
    },
  );

  app.post<{ Params: { handoff_id: string } }>(
    "/v1/integration-handoffs/:handoff_id/callback",
    { config: { rbacAction: "integration.handoff" } },
    async (request, reply) => {
      const principal = requirePrincipal(request);
      const handoffId = parseUuid(request.params.handoff_id, "handoff_id");
      const body = parseCallbackRequest(request.body);
      const item = await withTenantTx(deps.pool, principal.tenantId, (client) =>
        recordIntegrationHandoffReceipt(client, principal.tenantId, handoffId, principal.subjectId, body),
      );
      reply.code(200).send(item);
    },
  );

  app.post<{ Params: { tenantId: string; handoff_id: string } }>(
    "/v1/webhooks/integration-handoffs/:tenantId/:handoff_id",
    { config: { skipJwtAuth: true } },
    async (request, reply) => {
      const tenantId = parseUuidNotFound(request.params.tenantId, "tenant_id");
      const handoffId = parseUuidNotFound(request.params.handoff_id, "handoff_id");
      const rawBody = request.body;
      const body = parseCallbackRequest(rawBody);
      const headers = parseProviderCallbackHeaders(request.headers);
      if (headers.eventId !== body.receiptId) {
        throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "handoff_callback_event_id_must_match_receipt_id" });
      }

      const authRow = await withTenantTx(deps.pool, tenantId, (client) =>
        selectIntegrationHandoffForAuth(client, handoffId),
      );
      if (authRow === null) {
        throw new ApiResponseError("RESOURCE_NOT_FOUND", { reason: "integration_handoff_not_found" });
      }
      if (authRow.callback_signature_secret_ref === null) {
        throw new ApiResponseError("UNAUTHENTICATED", { reason: "integration_handoff_callback_signature_not_configured" });
      }

      const boundary = deps.integrationHandoffCallbackSecretBoundary ?? deps.webhookSecretBoundary;
      if (boundary === undefined) {
        throw new ApiResponseError("CONTROL_PLANE_INTERNAL_ERROR", { reason: "integration_handoff_callback_secret_boundary_not_configured" });
      }
      const secretRef = authRow.callback_signature_secret_ref as SecretRef;
      const secret = await boundary.resolveAuthorized({
        principal: integrationHandoffCallbackPrincipal(tenantId),
        ref: secretRef,
        purpose: "connector",
        connectorId: authRow.provider_alias,
      });
      const signingPayload = webhookSigningPayload(headers.timestamp, headers.eventId, rawBody);
      if (!verifyWebhookSignature(secret, headers.signature, signingPayload)) {
        throw new ApiResponseError("UNAUTHENTICATED", { reason: "invalid_integration_handoff_callback_signature" });
      }

      const item = await withTenantTx(deps.pool, tenantId, (client) =>
        recordIntegrationHandoffReceipt(
          client,
          tenantId,
          handoffId,
          "api:integration-handoff-callback",
          body,
          secretRef,
        ),
      );
      reply.code(202).send(item);
    },
  );
}
