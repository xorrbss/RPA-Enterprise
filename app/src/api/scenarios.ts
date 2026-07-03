/**
 * Scenario create/read/validate/promote routes (D4.4 / api-surface section 2).
 *
 * All writes run the section 10 compile pipeline before persistence. Promote
 * also requires If-Match and Idempotency-Key and blocks static warnings.
 */

import { randomUUID } from "node:crypto";

import type { FastifyInstance, FastifyRequest } from "fastify";
import type { PoolClient } from "pg";

import { withTenantTx } from "../db/pool";
import { runIdempotentCommand } from "./command";
import { compileScenario, studioValidationStagesFromCompile } from "./compile-pipeline";
import { ApiResponseError } from "./errors";
import { appendGovernanceAudit } from "./role-assignments";
import { mapScenarioCertification } from "./scenario-certification";
import { requirePrincipal, type ApiServerDeps } from "./server-shared";
import {
  cloneIrWithVersion,
  isRecord,
  parseIfMatch,
  parseVersionParam,
  promoteScenario,
  promoteScenarioFromRun,
  resolveRunTargetForIr,
  signedCommandRefsFor,
  UUID_RE,
  type ScenarioVersionDetailRow,
  type ScenarioVersionListRow,
} from "./scenarios-support";

interface CertificationBody {
  readonly reason: string;
  readonly expiresAt: string | null;
}

type GovernanceStageUpdate = "review" | "pilot" | "deprecated";

interface GovernanceStageBody {
  readonly stage: GovernanceStageUpdate;
  readonly reason: string;
  readonly evidenceRef: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly legalHold: boolean;
}

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
      // 실행 대상(ir.target) 미설정 시 시작 URL로 사이트 자동 추론·주입 — 쉬운 만들기 산출 IR이 그대로 실행되도록.
      const inferredTarget = await resolveRunTargetForIr(c, principal.tenantId, ir);
      const irToStore = inferredTarget !== undefined ? { ...ir, target: inferredTarget } : ir;
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
          JSON.stringify(irToStore),
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
        const r = await c.query<ScenarioVersionDetailRow>(
          `SELECT s.id AS scenario_id, s.name, sv.id AS version_id, sv.version, sv.promotion_status,
                  sv.certification_status, sv.certified_by, sv.certified_at::text AS certified_at,
                  sv.certification_expires_at::text AS certification_expires_at, sv.certification_reason,
                  sv.certification_revoked_by, sv.certification_revoked_at::text AS certification_revoked_at,
                  sv.certification_revoke_reason, sv.governance_stage, sv.governance_reason,
                  sv.governance_evidence_ref, sv.governance_metadata,
                  sv.governance_updated_by, sv.governance_updated_at::text AS governance_updated_at,
                  sv.created_at::text AS created_at,
                  sv.promoted_at::text AS promoted_at, sv.ir
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
        .send(mapScenarioVersion(row));
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
          `SELECT id AS version_id, version, promotion_status, certification_status,
                  certified_by, certified_at::text AS certified_at,
                  certification_expires_at::text AS certification_expires_at, certification_reason,
                  certification_revoked_by, certification_revoked_at::text AS certification_revoked_at,
                  certification_revoke_reason, governance_stage, governance_reason,
                  governance_evidence_ref, governance_metadata,
                  governance_updated_by, governance_updated_at::text AS governance_updated_at,
                  created_at::text AS created_at, promoted_at::text AS promoted_at
             FROM scenario_versions
            WHERE tenant_id=$1::uuid AND scenario_id=$2::uuid
            ORDER BY version DESC`,
          [principal.tenantId, scenarioId],
        );
        return result.rows;
      });
      reply.code(200).send({ items: rows.map(mapScenarioVersion), next_cursor: null });
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
                  sv.certification_status, sv.certified_by, sv.certified_at::text AS certified_at,
                  sv.certification_expires_at::text AS certification_expires_at, sv.certification_reason,
                  sv.certification_revoked_by, sv.certification_revoked_at::text AS certification_revoked_at,
                  sv.certification_revoke_reason, sv.governance_stage, sv.governance_reason,
                  sv.governance_evidence_ref, sv.governance_metadata,
                  sv.governance_updated_by, sv.governance_updated_at::text AS governance_updated_at,
                  sv.created_at::text AS created_at,
                  sv.promoted_at::text AS promoted_at, sv.ir
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
        .send(mapScenarioVersion(row));
    },
  );

  app.post<{ Params: { scenarioId: string; version: string } }>(
    "/v1/scenarios/:scenarioId/versions/:version/certify",
    { config: { rbacAction: "scenario.certify" } },
    async (request, reply) => {
      requirePrincipal(request);
      const scenarioId = request.params.scenarioId;
      const version = parseVersionParam(request.params.version);
      if (!UUID_RE.test(scenarioId) || version === undefined) {
        throw new ApiResponseError("RESOURCE_NOT_FOUND");
      }
      const body = parseCertificationBody(request.body);
      const result = await runIdempotentCommand(
        deps,
        request,
        "certifyScenarioVersion",
        `/v1/scenarios/${scenarioId}/versions/${version}/certify`,
        (c, tenantId) => certifyScenarioVersion(c, request, tenantId, scenarioId, version, body),
      );
      reply.code(result.status).send(result.body);
    },
  );

  app.post<{ Params: { scenarioId: string; version: string } }>(
    "/v1/scenarios/:scenarioId/versions/:version/revoke-certification",
    { config: { rbacAction: "scenario.certify" } },
    async (request, reply) => {
      requirePrincipal(request);
      const scenarioId = request.params.scenarioId;
      const version = parseVersionParam(request.params.version);
      if (!UUID_RE.test(scenarioId) || version === undefined) {
        throw new ApiResponseError("RESOURCE_NOT_FOUND");
      }
      const reason = parseRequiredReasonBody(request.body);
      const result = await runIdempotentCommand(
        deps,
        request,
        "revokeScenarioCertification",
        `/v1/scenarios/${scenarioId}/versions/${version}/revoke-certification`,
        (c, tenantId) => revokeScenarioCertification(c, request, tenantId, scenarioId, version, reason),
      );
      reply.code(result.status).send(result.body);
    },
  );

  app.post<{ Params: { scenarioId: string; version: string } }>(
    "/v1/scenarios/:scenarioId/versions/:version/governance-stage",
    { config: { rbacAction: "scenario.certify" } },
    async (request, reply) => {
      requirePrincipal(request);
      const scenarioId = request.params.scenarioId;
      const version = parseVersionParam(request.params.version);
      if (!UUID_RE.test(scenarioId) || version === undefined) {
        throw new ApiResponseError("RESOURCE_NOT_FOUND");
      }
      const body = parseGovernanceStageBody(request.body);
      const result = await runIdempotentCommand(
        deps,
        request,
        "setScenarioVersionGovernanceStage",
        `/v1/scenarios/${scenarioId}/versions/${version}/governance-stage`,
        (c, tenantId) => setScenarioVersionGovernanceStage(c, request, tenantId, scenarioId, version, body),
      );
      reply.code(result.status).send(result.body);
    },
  );

  app.post<{ Params: { scenarioId: string } }>(
    "/v1/scenarios/:scenarioId/validate",
    { config: { rbacAction: "scenario.read" } },
    async (request) => {
      const principal = requirePrincipal(request);
      const signedCommandRefs = await signedCommandRefsFor(deps, principal, "scenario.validate");
      const outcome = compileScenario(request.body, { signedCommandRefs });
      const stages = studioValidationStagesFromCompile(outcome);
      if (!outcome.ok) {
        if (outcome.report === undefined) {
          throw new ApiResponseError(outcome.code, outcome.details);
        }
        return { valid: false, report: outcome.report, stages };
      }
      return { valid: true, report: outcome.report, stages };
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
          const insertedVersion = await c.query(
            `INSERT INTO scenario_versions
               (id, tenant_id, scenario_id, version, promotion_status, ir, compiled_ast, params_schema)
             VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'draft', $5::jsonb, $6, $7::jsonb)
             ON CONFLICT (tenant_id, scenario_id, version) DO NOTHING
             RETURNING id`,
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
          if (insertedVersion.rowCount !== 1) {
            // IFM-2: 동시 작성자가 같은 version 을 선점(UNIQUE 경합) — raw 23505→500 대신 계약 코드 412(SCENARIO_VERSION_CONFLICT)로
            //   환원해 If-Match 재시도(§0.3)·멱등 회수(IFM-1) 경로로 보낸다. tx 롤백이라 부분상태 없음.
            throw new ApiResponseError("SCENARIO_VERSION_CONFLICT", { reason: "concurrent_version_insert", version: nextVersion });
          }
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
        const inferredTarget = await resolveRunTargetForIr(c, principal.tenantId, ir);
        const irToStore = inferredTarget !== undefined ? { ...ir, target: inferredTarget } : ir;
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
        const insertedVersion = await c.query(
          `INSERT INTO scenario_versions
             (id, tenant_id, scenario_id, version, promotion_status, ir, compiled_ast, params_schema)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'draft', $5::jsonb, $6, $7::jsonb)
           ON CONFLICT (tenant_id, scenario_id, version) DO NOTHING
           RETURNING id`,
          [
            randomUUID(),
            principal.tenantId,
            scenarioId,
            ir.meta.version,
            JSON.stringify(irToStore),
            outcome.compiledAst,
            ir.params_schema !== undefined ? JSON.stringify(ir.params_schema) : null,
          ],
        );
        if (insertedVersion.rowCount !== 1) {
          // IFM-2: 동시 작성자 version 선점(UNIQUE 경합) → 412 환원(raw 23505→500 회피). tx 롤백이라 부분상태 없음.
          throw new ApiResponseError("SCENARIO_VERSION_CONFLICT", { reason: "concurrent_version_insert", version: ir.meta.version });
        }
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

  // ── maker-checker prod 승격 게이트(D4) — 직접 POST /promote(admin)와 별개의 인간 승격 경로(요청자≠승인자 SoD) ──
  // POST /v1/scenarios/:scenarioId/promotion-requests — operator+(scenario.update) 가 버전 prod 승격을 요청(사유 필수, pending 1건).
  app.post<{ Params: { scenarioId: string } }>(
    "/v1/scenarios/:scenarioId/promotion-requests",
    { config: { rbacAction: "scenario.update" } },
    async (request, reply) => {
      const principal = requirePrincipal(request);
      const scenarioId = request.params.scenarioId;
      if (!UUID_RE.test(scenarioId)) throw new ApiResponseError("RESOURCE_NOT_FOUND");
      const body = isRecord(request.body) ? request.body : {};
      const version = typeof body.version === "number" && Number.isInteger(body.version) ? body.version : null;
      const reason = typeof body.reason === "string" ? body.reason.trim() : "";
      if (version === null) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_version", field: "version" });
      if (reason.length === 0) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "missing_reason", field: "reason" });
      const result = await runIdempotentCommand(
        deps,
        request,
        "createScenarioPromotionRequest",
        `/v1/scenarios/${scenarioId}/promotion-requests`,
        async (c, tenantId) => {
          const ver = await c.query<{ promotion_status: string }>(
            `SELECT sv.promotion_status
               FROM scenario_versions sv JOIN scenarios s ON s.tenant_id=sv.tenant_id AND s.id=sv.scenario_id
              WHERE sv.tenant_id=$1::uuid AND sv.scenario_id=$2::uuid AND sv.version=$3 AND s.archived_at IS NULL`,
            [tenantId, scenarioId, version],
          );
          const verRow = ver.rows[0];
          if (verRow === undefined) throw new ApiResponseError("RESOURCE_NOT_FOUND");
          if (verRow.promotion_status === "prod") throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "already_prod", version });
          let row: { id: string; created_at: Date };
          try {
            const inserted = await c.query<{ id: string; created_at: Date }>(
              `INSERT INTO scenario_promotion_requests (id, tenant_id, scenario_id, version, reason, requested_by)
               VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6) RETURNING id, created_at`,
              [randomUUID(), tenantId, scenarioId, version, reason, principal.subjectId],
            );
            const first = inserted.rows[0];
            if (first === undefined) throw new ApiResponseError("CONTROL_PLANE_INTERNAL_ERROR");
            row = first;
          } catch (err) {
            if (isRecord(err) && (err as { code?: unknown }).code === "23505") {
              throw new ApiResponseError("SCENARIO_VERSION_CONFLICT", { reason: "promotion_request_pending", version });
            }
            throw err;
          }
          return {
            status: 201,
            body: { request_id: row.id, scenario_id: scenarioId, version, status: "pending", reason, requested_by: principal.subjectId, created_at: row.created_at.toISOString() },
          };
        },
      );
      reply.code(result.status).send(result.body);
    },
  );

  // POST /v1/scenarios/:scenarioId/promotion-requests/:requestId/decide — approver+(scenario.promote.approve) 승인/반려.
  //   요청자≠승인자(SoD) 강제. approve 시 해당 버전 prod 승격(직접 promote 와 동일 compile+CAS). reject 는 사유 기록.
  app.post<{ Params: { scenarioId: string; requestId: string } }>(
    "/v1/scenarios/:scenarioId/promotion-requests/:requestId/decide",
    { config: { rbacAction: "scenario.promote.approve" } },
    async (request, reply) => {
      const principal = requirePrincipal(request);
      const { scenarioId, requestId } = request.params;
      if (!UUID_RE.test(scenarioId) || !UUID_RE.test(requestId)) throw new ApiResponseError("RESOURCE_NOT_FOUND");
      const body = isRecord(request.body) ? request.body : {};
      const decision = body.decision === "approve" || body.decision === "reject" ? body.decision : null;
      if (decision === null) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_decision", field: "decision" });
      const decisionReason = typeof body.reason === "string" && body.reason.trim().length > 0 ? body.reason.trim() : null;
      const signedCommandRefs = await signedCommandRefsFor(deps, principal, "scenario.promote");
      const result = await runIdempotentCommand(
        deps,
        request,
        "decideScenarioPromotionRequest",
        `/v1/scenarios/${scenarioId}/promotion-requests/${requestId}/decide`,
        async (c, tenantId) => {
          const reqRes = await c.query<{ version: number; requested_by: string }>(
            `SELECT version, requested_by FROM scenario_promotion_requests
              WHERE tenant_id=$1::uuid AND id=$2::uuid AND scenario_id=$3::uuid AND status='pending'`,
            [tenantId, requestId, scenarioId],
          );
          const req = reqRes.rows[0];
          if (req === undefined) throw new ApiResponseError("RESOURCE_NOT_FOUND");
          // SoD: 요청자 본인은 승인/반려 불가(maker≠checker).
          if (req.requested_by === principal.subjectId) {
            throw new ApiResponseError("AUTHZ_FORBIDDEN", { reason: "self_approval_forbidden" });
          }
          if (decision === "approve") {
            const verRes = await c.query<{ version_id: string; ir: unknown }>(
              `SELECT sv.id AS version_id, sv.ir
                 FROM scenario_versions sv JOIN scenarios s ON s.tenant_id=sv.tenant_id AND s.id=sv.scenario_id
                WHERE sv.tenant_id=$1::uuid AND sv.scenario_id=$2::uuid AND sv.version=$3 AND s.archived_at IS NULL`,
              [tenantId, scenarioId, req.version],
            );
            const ver = verRes.rows[0];
            if (ver === undefined) throw new ApiResponseError("RESOURCE_NOT_FOUND");
            const outcome = compileScenario(ver.ir, { promote: true, signedCommandRefs });
            if (!outcome.ok) throw new ApiResponseError(outcome.code, outcome.details);
            await c.query(
              `UPDATE scenario_versions SET promotion_status='draft', promoted_at=NULL
                WHERE tenant_id=$1::uuid AND scenario_id=$2::uuid AND id <> $3::uuid AND promotion_status='prod'`,
              [tenantId, scenarioId, ver.version_id],
            );
            await c.query(
              `UPDATE scenario_versions SET promotion_status='prod', compiled_ast=$1, promoted_at=now()
                WHERE tenant_id=$2::uuid AND id=$3::uuid`,
              [outcome.compiledAst, tenantId, ver.version_id],
            );
          }
          const newStatus = decision === "approve" ? "approved" : "rejected";
          await c.query(
            `UPDATE scenario_promotion_requests
                SET status=$4, decided_by=$5, decision_reason=$6, decided_at=now()
              WHERE tenant_id=$1::uuid AND id=$2::uuid AND scenario_id=$3::uuid AND status='pending'`,
            [tenantId, requestId, scenarioId, newStatus, principal.subjectId, decisionReason],
          );
          return {
            status: 200,
            body: { request_id: requestId, scenario_id: scenarioId, version: req.version, status: newStatus, decided_by: principal.subjectId, decision_reason: decisionReason },
          };
        },
      );
      reply.code(result.status).send(result.body);
    },
  );

  // GET /v1/scenarios/promotion-requests — approver 인박스(pending 요청 목록). 정적 라우트(파라메트릭 :scenarioId 에 비가려짐). RLS 스코프.
  app.get("/v1/scenarios/promotion-requests", { config: { rbacAction: "scenario.promote.approve" } }, async (request, reply) => {
    const principal = requirePrincipal(request);
    const rows = await withTenantTx(deps.pool, principal.tenantId, async (c) => {
      const result = await c.query<{ id: string; scenario_id: string; scenario_name: string; version: number; reason: string; requested_by: string; created_at: Date }>(
        `SELECT pr.id, pr.scenario_id, s.name AS scenario_name, pr.version, pr.reason, pr.requested_by, pr.created_at
           FROM scenario_promotion_requests pr JOIN scenarios s ON s.tenant_id=pr.tenant_id AND s.id=pr.scenario_id
          WHERE pr.tenant_id=$1::uuid AND pr.status='pending'
          ORDER BY pr.created_at DESC LIMIT 50`,
        [principal.tenantId],
      );
      return result.rows;
    });
    reply.code(200).send({
      items: rows.map((r) => ({
        request_id: r.id,
        scenario_id: r.scenario_id,
        scenario_name: r.scenario_name,
        version: r.version,
        reason: r.reason,
        requested_by: r.requested_by,
        created_at: r.created_at.toISOString(),
      })),
      next_cursor: null,
    });
  });

  // PbD 승격: 성공 run 의 결정형 ActionPlan(click) 을 새 draft 버전으로 베이킹(scenario-promotion ①+②).
  app.post<{ Params: { scenarioId: string } }>(
    "/v1/scenarios/:scenarioId/promote-from-run",
    { config: { rbacAction: "scenario.promote" } },
    async (request, reply) => {
      const result = await promoteScenarioFromRun(deps, request.params.scenarioId, request);
      reply.code(result.status).send(result.body);
    },
  );
}

async function certifyScenarioVersion(
  client: PoolClient,
  request: FastifyRequest,
  tenantId: string,
  scenarioId: string,
  version: number,
  body: CertificationBody,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const actor = requirePrincipal(request);
  const result = await client.query<ScenarioVersionDetailRow>(
    `UPDATE scenario_versions sv
        SET certification_status='certified',
            certified_by=$1,
            certified_at=now(),
            certification_expires_at=$2::timestamptz,
            certification_reason=$3,
            certification_revoked_by=NULL,
            certification_revoked_at=NULL,
            certification_revoke_reason=NULL,
            governance_stage='certified',
            governance_reason=$3,
            governance_evidence_ref=concat('certification:', $5::text, ':', $6::text),
            governance_metadata='{}'::jsonb,
            governance_updated_by=$1,
            governance_updated_at=now()
       FROM scenarios s
      WHERE sv.tenant_id=$4::uuid
        AND sv.scenario_id=$5::uuid
        AND sv.version=$6
        AND s.tenant_id=sv.tenant_id
        AND s.id=sv.scenario_id
        AND s.archived_at IS NULL
      RETURNING s.id AS scenario_id, s.name, sv.id AS version_id, sv.version, sv.promotion_status,
                sv.certification_status, sv.certified_by, sv.certified_at::text AS certified_at,
                sv.certification_expires_at::text AS certification_expires_at, sv.certification_reason,
                sv.certification_revoked_by, sv.certification_revoked_at::text AS certification_revoked_at,
                sv.certification_revoke_reason, sv.governance_stage, sv.governance_reason,
                sv.governance_evidence_ref, sv.governance_metadata,
                sv.governance_updated_by, sv.governance_updated_at::text AS governance_updated_at,
                sv.created_at::text AS created_at,
                sv.promoted_at::text AS promoted_at, sv.ir`,
    [actor.subjectId, body.expiresAt, body.reason, tenantId, scenarioId, version],
  );
  const row = result.rows[0];
  if (row === undefined) throw new ApiResponseError("RESOURCE_NOT_FOUND");
  await appendGovernanceAudit(client, request, "scenario.certify", "allow", "scenario_version_certified", {
    scenario_id: scenarioId,
    scenario_version_id: row.version_id,
    version,
    certification_status: row.certification_status,
    certification_expires_at: row.certification_expires_at,
  });
  return { status: 200, body: mapScenarioVersion(row) };
}

async function revokeScenarioCertification(
  client: PoolClient,
  request: FastifyRequest,
  tenantId: string,
  scenarioId: string,
  version: number,
  reason: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const actor = requirePrincipal(request);
  const result = await client.query<ScenarioVersionDetailRow>(
    `UPDATE scenario_versions sv
        SET certification_status='revoked',
            certification_revoked_by=$1,
            certification_revoked_at=now(),
            certification_revoke_reason=$2,
            governance_stage='deprecated',
            governance_reason=$2,
            governance_evidence_ref=concat('revocation:', $4::text, ':', $5::text),
            governance_metadata='{}'::jsonb,
            governance_updated_by=$1,
            governance_updated_at=now()
       FROM scenarios s
      WHERE sv.tenant_id=$3::uuid
        AND sv.scenario_id=$4::uuid
        AND sv.version=$5
        AND sv.certification_status='certified'
        AND s.tenant_id=sv.tenant_id
        AND s.id=sv.scenario_id
        AND s.archived_at IS NULL
      RETURNING s.id AS scenario_id, s.name, sv.id AS version_id, sv.version, sv.promotion_status,
                sv.certification_status, sv.certified_by, sv.certified_at::text AS certified_at,
                sv.certification_expires_at::text AS certification_expires_at, sv.certification_reason,
                sv.certification_revoked_by, sv.certification_revoked_at::text AS certification_revoked_at,
                sv.certification_revoke_reason, sv.governance_stage, sv.governance_reason,
                sv.governance_evidence_ref, sv.governance_metadata,
                sv.governance_updated_by, sv.governance_updated_at::text AS governance_updated_at,
                sv.created_at::text AS created_at,
                sv.promoted_at::text AS promoted_at, sv.ir`,
    [actor.subjectId, reason, tenantId, scenarioId, version],
  );
  const row = result.rows[0];
  if (row === undefined) {
    const existing = await client.query<{ certification_status: string }>(
      `SELECT sv.certification_status
         FROM scenario_versions sv
         JOIN scenarios s ON s.tenant_id=sv.tenant_id AND s.id=sv.scenario_id
        WHERE sv.tenant_id=$1::uuid AND sv.scenario_id=$2::uuid AND sv.version=$3 AND s.archived_at IS NULL`,
      [tenantId, scenarioId, version],
    );
    const current = existing.rows[0]?.certification_status;
    if (current === undefined) throw new ApiResponseError("RESOURCE_NOT_FOUND");
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "scenario_version_not_certified", certification_status: current });
  }
  await appendGovernanceAudit(client, request, "scenario.decertify", "allow", "scenario_version_certification_revoked", {
    scenario_id: scenarioId,
    scenario_version_id: row.version_id,
    version,
    certification_status: row.certification_status,
  });
  return { status: 200, body: mapScenarioVersion(row) };
}

async function setScenarioVersionGovernanceStage(
  client: PoolClient,
  request: FastifyRequest,
  tenantId: string,
  scenarioId: string,
  version: number,
  body: GovernanceStageBody,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const actor = requirePrincipal(request);
  const result = await client.query<ScenarioVersionDetailRow>(
    `UPDATE scenario_versions sv
        SET governance_stage=$1,
            governance_reason=$2,
            governance_evidence_ref=$3,
            governance_metadata=$4::jsonb,
            governance_updated_by=$5,
            governance_updated_at=now()
       FROM scenarios s
      WHERE sv.tenant_id=$6::uuid
        AND sv.scenario_id=$7::uuid
        AND sv.version=$8
        AND s.tenant_id=sv.tenant_id
        AND s.id=sv.scenario_id
        AND s.archived_at IS NULL
      RETURNING s.id AS scenario_id, s.name, sv.id AS version_id, sv.version, sv.promotion_status,
                sv.certification_status, sv.certified_by, sv.certified_at::text AS certified_at,
                sv.certification_expires_at::text AS certification_expires_at, sv.certification_reason,
                sv.certification_revoked_by, sv.certification_revoked_at::text AS certification_revoked_at,
                sv.certification_revoke_reason, sv.governance_stage, sv.governance_reason,
                sv.governance_evidence_ref, sv.governance_metadata,
                sv.governance_updated_by, sv.governance_updated_at::text AS governance_updated_at,
                sv.created_at::text AS created_at,
                sv.promoted_at::text AS promoted_at, sv.ir`,
    [
      body.stage,
      body.reason,
      body.evidenceRef,
      JSON.stringify({ ...body.metadata, legal_hold: body.legalHold }),
      actor.subjectId,
      tenantId,
      scenarioId,
      version,
    ],
  );
  const row = result.rows[0];
  if (row === undefined) throw new ApiResponseError("RESOURCE_NOT_FOUND");
  await appendGovernanceAudit(client, request, "scenario.certify", "allow", "scenario_version_governance_stage_set", {
    scenario_id: scenarioId,
    scenario_version_id: row.version_id,
    version,
    governance_stage: row.governance_stage,
    governance_evidence_ref: row.governance_evidence_ref,
  });
  return { status: 200, body: mapScenarioVersion(row) };
}

function mapScenarioVersion(row: ScenarioVersionListRow | ScenarioVersionDetailRow): Record<string, unknown> {
  const body: Record<string, unknown> = {
    version_id: row.version_id,
    version: row.version,
    promotion_status: row.promotion_status,
    certification: mapScenarioCertification(row),
    created_at: row.created_at,
    promoted_at: row.promoted_at,
  };
  if ("scenario_id" in row) body.scenario_id = row.scenario_id;
  if ("name" in row) body.name = row.name;
  if ("ir" in row) body.ir = row.ir;
  return body;
}

function parseCertificationBody(raw: unknown): CertificationBody {
  if (!isRecord(raw)) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "request_body_object_required" });
  for (const key of Object.keys(raw)) {
    if (key !== "reason" && key !== "expires_at") {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "unexpected_field", field: key });
    }
  }
  return {
    reason: parseRequiredReason(raw.reason),
    expiresAt: parseOptionalFutureInstant(raw.expires_at),
  };
}

function parseRequiredReasonBody(raw: unknown): string {
  if (!isRecord(raw)) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "request_body_object_required" });
  for (const key of Object.keys(raw)) {
    if (key !== "reason") throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "unexpected_field", field: key });
  }
  return parseRequiredReason(raw.reason);
}

function parseGovernanceStageBody(raw: unknown): GovernanceStageBody {
  if (!isRecord(raw)) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "request_body_object_required" });
  for (const key of Object.keys(raw)) {
    if (key !== "stage" && key !== "reason" && key !== "evidence_ref" && key !== "metadata" && key !== "legal_hold") {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "unexpected_field", field: key });
    }
  }
  return {
    stage: parseGovernanceStage(raw.stage),
    reason: parseSafeGovernanceString(raw.reason, "reason", 1, 500),
    evidenceRef: parseSafeGovernanceString(raw.evidence_ref, "evidence_ref", 1, 500),
    metadata: parseGovernanceMetadata(raw.metadata),
    legalHold: raw.legal_hold === undefined ? false : parseBoolean(raw.legal_hold, "legal_hold"),
  };
}

function parseGovernanceStage(raw: unknown): GovernanceStageUpdate {
  if (raw === "review" || raw === "pilot" || raw === "deprecated") return raw;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_governance_stage" });
}

function parseRequiredReason(raw: unknown): string {
  if (typeof raw !== "string") throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "reason_required" });
  const trimmed = raw.trim();
  if (trimmed.length === 0) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "reason_required" });
  return trimmed.slice(0, 500);
}

function parseOptionalFutureInstant(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_expires_at" });
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_expires_at" });
  if (parsed <= Date.now()) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "expires_at_must_be_future" });
  return new Date(parsed).toISOString();
}

function parseBoolean(raw: unknown, field: string): boolean {
  if (typeof raw === "boolean") return raw;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: `invalid_${field}` });
}

function parseSafeGovernanceString(raw: unknown, field: string, min: number, max: number): string {
  if (typeof raw !== "string") throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: `${field}_required` });
  const trimmed = raw.trim();
  if (trimmed.length < min || trimmed.length > max) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: `invalid_${field}` });
  }
  assertSafeGovernanceString(trimmed, field);
  return trimmed;
}

function parseGovernanceMetadata(raw: unknown): Readonly<Record<string, unknown>> {
  if (raw === undefined || raw === null) return {};
  if (!isRecord(raw)) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "metadata_must_be_object" });
  if (JSON.stringify(raw).length > 4000) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "metadata_too_large" });
  assertSafeGovernanceMetadata(raw, "metadata", 0);
  return raw;
}

function assertSafeGovernanceMetadata(value: unknown, path: string, depth: number): void {
  if (depth > 4) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "metadata_too_deep", path });
  if (value === null || typeof value === "number" || typeof value === "boolean") return;
  if (typeof value === "string") {
    assertSafeGovernanceString(value, path);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 50) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "metadata_array_too_large", path });
    value.forEach((item, index) => assertSafeGovernanceMetadata(item, `${path}.${index}`, depth + 1));
    return;
  }
  if (!isRecord(value)) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "metadata_value_not_json", path });
  const entries = Object.entries(value);
  if (entries.length > 50) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "metadata_object_too_large", path });
  for (const [key, child] of entries) {
    if (!/^[a-zA-Z0-9_.-]{1,80}$/.test(key) || forbiddenGovernanceEvidenceKey(key)) {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "metadata_secret_or_endpoint_key_forbidden", path: `${path}.${key}` });
    }
    assertSafeGovernanceMetadata(child, `${path}.${key}`, depth + 1);
  }
}

function assertSafeGovernanceString(value: string, path: string): void {
  if (/https?:\/\//i.test(value) || /hooks\.slack\.com/i.test(value)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "raw_endpoint_url_forbidden", path });
  }
  if (/\bbearer\s+[a-z0-9._~+/=-]{8,}/i.test(value) || /\b(token|password|secret)=/i.test(value)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "secret_material_forbidden", path });
  }
}

function forbiddenGovernanceEvidenceKey(key: string): boolean {
  return /(^|[_.-])(secret|token|password|credential|authorization|cookie|webhook_url|endpoint_url|url|dsn|smtp|raw_approval_packet|approval_packet|raw_roster|participant_list|full_text|payload|body)([_.-]|$)/i.test(key);
}
