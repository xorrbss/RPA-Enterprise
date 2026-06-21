/**
 * Scenario create/read/validate/promote routes (D4.4 / api-surface section 2).
 *
 * All writes run the section 10 compile pipeline before persistence. Promote
 * also requires If-Match and Idempotency-Key and blocks static warnings.
 */

import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";

import { withTenantTx } from "../db/pool";
import { runIdempotentCommand } from "./command";
import { compileScenario } from "./compile-pipeline";
import { ApiResponseError } from "./errors";
import { requirePrincipal, type ApiServerDeps } from "./server";
import {
  cloneIrWithVersion,
  isRecord,
  parseIfMatch,
  parseVersionParam,
  promoteScenario,
  signedCommandRefsFor,
  UUID_RE,
  type ScenarioVersionDetailRow,
  type ScenarioVersionListRow,
} from "./scenarios-support";

export function registerScenarioRoutes(app: FastifyInstance, deps: ApiServerDeps): void {
  app.post("/v1/scenarios", { config: { rbacAction: "scenario.create" } }, async (request, reply) => {
    const principal = requirePrincipal(request);
    const signedCommandRefs = await signedCommandRefsFor(deps, principal, "scenario.save");
    const outcome = compileScenario(request.body, { signedCommandRefs });
    if (!outcome.ok) {
      throw new ApiResponseError(outcome.code, outcome.details);
    }
    const ir = outcome.ir;
    const created = await withTenantTx(deps.pool, principal.tenantId, async (c) => {
      const sc = await c.query<{ id: string }>(
        `INSERT INTO scenarios (id, tenant_id, name) VALUES ($1::uuid, $2::uuid, $3)
         ON CONFLICT (tenant_id, name) WHERE archived_at IS NULL DO NOTHING RETURNING id`,
        [randomUUID(), principal.tenantId, ir.meta.name],
      );
      if (sc.rowCount === 0) {
        throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "scenario_name_in_use", name: ir.meta.name });
      }
      const scenarioId = sc.rows[0].id;
      await c.query(
        `INSERT INTO scenario_versions
           (id, tenant_id, scenario_id, version, promotion_status, ir, compiled_ast, params_schema)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'draft', $5::jsonb, $6, $7::jsonb)`,
        [
          randomUUID(),
          principal.tenantId,
          scenarioId,
          ir.meta.version,
          JSON.stringify(ir),
          outcome.compiledAst,
          ir.params_schema !== undefined ? JSON.stringify(ir.params_schema) : null,
        ],
      );
      return { scenarioId, version: ir.meta.version };
    });
    reply
      .code(201)
      .header("ETag", String(created.version))
      .send({ scenario_id: created.scenarioId, version: created.version, promotion_status: "draft" });
  });

  app.get<{ Params: { scenarioId: string } }>(
    "/v1/scenarios/:scenarioId",
    { config: { rbacAction: "scenario.read" } },
    async (request, reply) => {
      const principal = requirePrincipal(request);
      const id = request.params.scenarioId;
      if (!UUID_RE.test(id)) {
        throw new ApiResponseError("RESOURCE_NOT_FOUND");
      }
      const row = await withTenantTx(deps.pool, principal.tenantId, async (c) => {
        const r = await c.query<{ id: string; name: string; version: number; promotion_status: string; ir: unknown }>(
          `SELECT s.id, s.name, sv.version, sv.promotion_status, sv.ir
             FROM scenarios s
            JOIN scenario_versions sv ON sv.tenant_id = s.tenant_id AND sv.scenario_id = s.id
            WHERE s.tenant_id = $1::uuid AND s.id = $2::uuid
              AND s.archived_at IS NULL
            ORDER BY sv.version DESC
            LIMIT 1`,
          [principal.tenantId, id],
        );
        return r.rows[0] ?? null;
      });
      if (row === null) {
        throw new ApiResponseError("RESOURCE_NOT_FOUND");
      }
      // ir 본문 포함 — 콘솔 편집 화면이 직전 버전을 prefill할 수 있게 한다(목록 응답에는 ir 미포함 유지).
      reply
        .code(200)
        .header("ETag", String(row.version))
        .send({ scenario_id: row.id, name: row.name, version: row.version, promotion_status: row.promotion_status, ir: row.ir });
    },
  );

  app.get<{ Params: { scenarioId: string } }>(
    "/v1/scenarios/:scenarioId/versions",
    { config: { rbacAction: "scenario.read" } },
    async (request, reply) => {
      const principal = requirePrincipal(request);
      const scenarioId = request.params.scenarioId;
      if (!UUID_RE.test(scenarioId)) {
        throw new ApiResponseError("RESOURCE_NOT_FOUND");
      }
      const rows = await withTenantTx(deps.pool, principal.tenantId, async (c) => {
        const exists = await c.query(
          `SELECT 1 FROM scenarios
            WHERE tenant_id=$1::uuid AND id=$2::uuid AND archived_at IS NULL`,
          [principal.tenantId, scenarioId],
        );
        if (exists.rowCount === 0) {
          throw new ApiResponseError("RESOURCE_NOT_FOUND");
        }
        const result = await c.query<ScenarioVersionListRow>(
          `SELECT id AS version_id, version, promotion_status, created_at::text AS created_at, promoted_at::text AS promoted_at
             FROM scenario_versions
            WHERE tenant_id=$1::uuid AND scenario_id=$2::uuid
            ORDER BY version DESC`,
          [principal.tenantId, scenarioId],
        );
        return result.rows;
      });
      reply.code(200).send({ items: rows, next_cursor: null });
    },
  );

  app.get<{ Params: { scenarioId: string; version: string } }>(
    "/v1/scenarios/:scenarioId/versions/:version",
    { config: { rbacAction: "scenario.read" } },
    async (request, reply) => {
      const principal = requirePrincipal(request);
      const scenarioId = request.params.scenarioId;
      const version = parseVersionParam(request.params.version);
      if (!UUID_RE.test(scenarioId) || version === undefined) {
        throw new ApiResponseError("RESOURCE_NOT_FOUND");
      }
      const row = await withTenantTx(deps.pool, principal.tenantId, async (c) => {
        const result = await c.query<ScenarioVersionDetailRow>(
          `SELECT s.id AS scenario_id, s.name, sv.id AS version_id, sv.version, sv.promotion_status,
                  sv.created_at::text AS created_at, sv.promoted_at::text AS promoted_at, sv.ir
             FROM scenarios s
             JOIN scenario_versions sv ON sv.tenant_id=s.tenant_id AND sv.scenario_id=s.id
            WHERE s.tenant_id=$1::uuid AND s.id=$2::uuid AND s.archived_at IS NULL
              AND sv.version=$3`,
          [principal.tenantId, scenarioId, version],
        );
        return result.rows[0] ?? null;
      });
      if (row === null) {
        throw new ApiResponseError("RESOURCE_NOT_FOUND");
      }
      reply
        .code(200)
        .header("ETag", String(row.version))
        .send({
          scenario_id: row.scenario_id,
          name: row.name,
          version_id: row.version_id,
          version: row.version,
          promotion_status: row.promotion_status,
          created_at: row.created_at,
          promoted_at: row.promoted_at,
          ir: row.ir,
        });
    },
  );

  app.post<{ Params: { scenarioId: string } }>(
    "/v1/scenarios/:scenarioId/validate",
    { config: { rbacAction: "scenario.read" } },
    async (request) => {
      const principal = requirePrincipal(request);
      const signedCommandRefs = await signedCommandRefsFor(deps, principal, "scenario.validate");
      const outcome = compileScenario(request.body, { signedCommandRefs });
      if (!outcome.ok) {
        if (outcome.report === undefined) {
          throw new ApiResponseError(outcome.code, outcome.details);
        }
        return { valid: false, report: outcome.report };
      }
      return { valid: true, report: outcome.report };
    },
  );

  app.post<{ Params: { scenarioId: string; version: string } }>(
    "/v1/scenarios/:scenarioId/versions/:version/rollback",
    { config: { rbacAction: "scenario.update" } },
    async (request, reply) => {
      const principal = requirePrincipal(request);
      const scenarioId = request.params.scenarioId;
      const sourceVersion = parseVersionParam(request.params.version);
      if (!UUID_RE.test(scenarioId) || sourceVersion === undefined) {
        throw new ApiResponseError("RESOURCE_NOT_FOUND");
      }
      const expectedVersion = parseIfMatch(request.headers["if-match"]);
      if (expectedVersion === undefined) {
        throw new ApiResponseError("SCENARIO_VERSION_CONFLICT", { reason: "missing_if_match" });
      }
      const signedCommandRefs = await signedCommandRefsFor(deps, principal, "scenario.save");
      const result = await runIdempotentCommand(
        deps,
        request,
        "rollbackScenario",
        `/v1/scenarios/${scenarioId}/versions/${sourceVersion}/rollback`,
        async (c, tenantId) => {
          const current = await c.query<{ name: string; version: number }>(
            `SELECT s.name, sv.version
               FROM scenarios s
               JOIN scenario_versions sv ON sv.tenant_id=s.tenant_id AND sv.scenario_id=s.id
              WHERE s.tenant_id=$1::uuid AND s.id=$2::uuid AND s.archived_at IS NULL
              ORDER BY sv.version DESC
              LIMIT 1`,
            [tenantId, scenarioId],
          );
          const currentRow = current.rows[0];
          if (currentRow === undefined) {
            throw new ApiResponseError("RESOURCE_NOT_FOUND");
          }
          if (currentRow.version !== expectedVersion) {
            throw new ApiResponseError("SCENARIO_VERSION_CONFLICT", { reason: "if_match_mismatch", currentVersion: currentRow.version });
          }
          const source = await c.query<{ ir: unknown }>(
            `SELECT ir FROM scenario_versions
              WHERE tenant_id=$1::uuid AND scenario_id=$2::uuid AND version=$3`,
            [tenantId, scenarioId, sourceVersion],
          );
          const sourceRow = source.rows[0];
          if (sourceRow === undefined) {
            throw new ApiResponseError("RESOURCE_NOT_FOUND");
          }
          const nextVersion = currentRow.version + 1;
          const nextIr = cloneIrWithVersion(sourceRow.ir, currentRow.name, nextVersion);
          const outcome = compileScenario(nextIr, { signedCommandRefs });
          if (!outcome.ok) {
            throw new ApiResponseError(outcome.code, outcome.details);
          }
          await c.query(
            `INSERT INTO scenario_versions
               (id, tenant_id, scenario_id, version, promotion_status, ir, compiled_ast, params_schema)
             VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'draft', $5::jsonb, $6, $7::jsonb)`,
            [
              randomUUID(),
              tenantId,
              scenarioId,
              nextVersion,
              JSON.stringify(outcome.ir),
              outcome.compiledAst,
              outcome.ir.params_schema !== undefined ? JSON.stringify(outcome.ir.params_schema) : null,
            ],
          );
          return {
            status: 200,
            body: { scenario_id: scenarioId, version: nextVersion, promotion_status: "draft", rolled_back_from: sourceVersion },
          };
        },
      );
      const bodyVersion = isRecord(result.body) && typeof result.body.version === "number" ? result.body.version : undefined;
      if (bodyVersion !== undefined) {
        reply.header("ETag", String(bodyVersion));
      }
      reply
        .code(result.status)
        .send(result.body);
    },
  );

  // PUT /v1/scenarios/{id} — 기존 시나리오 편집 = 새 draft version 작성(api-surface §74).
  // If-Match(현재 version) 필수, 컴파일 파이프라인 재실행. 이름은 생성 시 고정, version은 직전+1로만 단조 증가.
  app.put<{ Params: { scenarioId: string } }>(
    "/v1/scenarios/:scenarioId",
    { config: { rbacAction: "scenario.update" } },
    async (request, reply) => {
      const principal = requirePrincipal(request);
      const scenarioId = request.params.scenarioId;
      if (!UUID_RE.test(scenarioId)) {
        throw new ApiResponseError("RESOURCE_NOT_FOUND");
      }
      const expectedVersion = parseIfMatch(request.headers["if-match"]);
      if (expectedVersion === undefined) {
        throw new ApiResponseError("SCENARIO_VERSION_CONFLICT", { reason: "missing_if_match" });
      }
      const signedCommandRefs = await signedCommandRefsFor(deps, principal, "scenario.save");
      const outcome = compileScenario(request.body, { signedCommandRefs });
      if (!outcome.ok) {
        throw new ApiResponseError(outcome.code, outcome.details);
      }
      const ir = outcome.ir;
      const updated = await withTenantTx(deps.pool, principal.tenantId, async (c) => {
        const current = await c.query<{ name: string; version: number }>(
          `SELECT s.name, sv.version
            FROM scenarios s
             JOIN scenario_versions sv ON sv.tenant_id = s.tenant_id AND sv.scenario_id = s.id
            WHERE s.tenant_id = $1::uuid AND s.id = $2::uuid
              AND s.archived_at IS NULL
            ORDER BY sv.version DESC
            LIMIT 1`,
          [principal.tenantId, scenarioId],
        );
        const row = current.rows[0];
        if (row === undefined) {
          throw new ApiResponseError("RESOURCE_NOT_FOUND");
        }
        if (row.version !== expectedVersion) {
          throw new ApiResponseError("SCENARIO_VERSION_CONFLICT", { reason: "if_match_mismatch", currentVersion: row.version });
        }
        // 이름은 scenarios.name에 고정 — 버전 IR의 meta.name 불일치를 조용히 넘기지 않는다.
        if (ir.meta.name !== row.name) {
          throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "scenario_name_immutable", expected: row.name });
        }
        // meta.version 권위 유지 + 갭/충돌 방지: 새 version은 직전+1이어야 한다.
        if (ir.meta.version !== row.version + 1) {
          throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "version_must_increment", expected: row.version + 1 });
        }
        await c.query(
          `INSERT INTO scenario_versions
             (id, tenant_id, scenario_id, version, promotion_status, ir, compiled_ast, params_schema)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'draft', $5::jsonb, $6, $7::jsonb)`,
          [
            randomUUID(),
            principal.tenantId,
            scenarioId,
            ir.meta.version,
            JSON.stringify(ir),
            outcome.compiledAst,
            ir.params_schema !== undefined ? JSON.stringify(ir.params_schema) : null,
          ],
        );
        return { version: ir.meta.version };
      });
      reply
        .code(200)
        .header("ETag", String(updated.version))
        .send({ scenario_id: scenarioId, version: updated.version, promotion_status: "draft" });
    },
  );

  app.post<{ Params: { scenarioId: string } }>(
    "/v1/scenarios/:scenarioId/archive",
    { config: { rbacAction: "scenario.update" } },
    async (request, reply) => {
      requirePrincipal(request);
      const scenarioId = request.params.scenarioId;
      if (!UUID_RE.test(scenarioId)) {
        throw new ApiResponseError("RESOURCE_NOT_FOUND");
      }
      const expectedVersion = parseIfMatch(request.headers["if-match"]);
      if (expectedVersion === undefined) {
        throw new ApiResponseError("SCENARIO_VERSION_CONFLICT", { reason: "missing_if_match" });
      }
      const result = await runIdempotentCommand(
        deps,
        request,
        "archiveScenario",
        `/v1/scenarios/${scenarioId}/archive`,
        async (c, tenantId) => {
          const current = await c.query<{ version: number }>(
            `SELECT sv.version
               FROM scenarios s
               JOIN scenario_versions sv ON sv.tenant_id=s.tenant_id AND sv.scenario_id=s.id
              WHERE s.tenant_id=$1::uuid AND s.id=$2::uuid AND s.archived_at IS NULL
              ORDER BY sv.version DESC
              LIMIT 1`,
            [tenantId, scenarioId],
          );
          const row = current.rows[0];
          if (row === undefined) {
            throw new ApiResponseError("RESOURCE_NOT_FOUND");
          }
          if (row.version !== expectedVersion) {
            throw new ApiResponseError("SCENARIO_VERSION_CONFLICT", { reason: "if_match_mismatch", currentVersion: row.version });
          }
          await c.query(
            `UPDATE scenario_versions
                SET promotion_status='draft', promoted_at=NULL
              WHERE tenant_id=$1::uuid AND scenario_id=$2::uuid AND promotion_status='prod'`,
            [tenantId, scenarioId],
          );
          await c.query(
            `UPDATE scenarios SET archived_at=now()
              WHERE tenant_id=$1::uuid AND id=$2::uuid AND archived_at IS NULL`,
            [tenantId, scenarioId],
          );
          return { status: 200, body: { scenario_id: scenarioId, version: row.version, archived: true } };
        },
      );
      const bodyVersion = isRecord(result.body) && typeof result.body.version === "number" ? result.body.version : undefined;
      if (bodyVersion !== undefined) {
        reply.header("ETag", String(bodyVersion));
      }
      reply.code(result.status).send(result.body);
    },
  );

  app.post<{ Params: { scenarioId: string } }>(
    "/v1/scenarios/:scenarioId/promote",
    { config: { rbacAction: "scenario.promote" } },
    async (request, reply) => {
      const result = await promoteScenario(deps, request.params.scenarioId, request);
      reply.code(result.status);
      if (isRecord(result.body) && typeof result.body.version === "number") {
        reply.header("ETag", String(result.body.version));
      }
      reply.send(result.body);
    },
  );
}

