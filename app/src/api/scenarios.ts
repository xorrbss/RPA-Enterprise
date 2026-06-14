/**
 * 시나리오 CRUD·검증 라우트 (D4.4 — api-surface §2). 얇은 핸들러: 저장/검증은 §10 컴파일 파이프라인
 * (compile-pipeline.ts: ajv→IREL→V1–V11) 통과분만 영속하고 compiled_ast를 캐시(런타임 파싱 없음).
 * RBAC(auth-rbac §2, D4 결정): create=scenario.create(operator+), read/validate=scenario.read(전 역할).
 * promote(scenario.promote + If-Match 412 + Idempotency-Key + prod warnings 차단)는 후속 증분.
 */
import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";

import { withTenantTx } from "../db/pool";
import { compileScenario } from "./compile-pipeline";
import { ApiResponseError } from "./errors";
import { requirePrincipal, type ApiServerDeps } from "./server";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// TODO: [BLOCKED]
//   violated: security-contracts §2 — shell action cmd_ref는 저장/승격 경계에서 signed command registry로 검증해야 한다.
//   reason: signed command registry 소스가 ApiServerDeps/DB/config 어디에도 없어 compileScenario에 signedCommandRefs를
//     전달하지 못한다 → static-validation V8이 미등록으로 간주해 shell 액션 포함 시나리오를 차단한다(fail-closed: 안전하나
//     적법 cmd_ref도 저장 불가). 현재 wired 라우트(create/validate)는 옵션 미전달이라 shell 시나리오를 저장할 수 없다.
//   required_change: SignedCommandRegistry 소스를 ApiServerDeps에 연결하고 cmd_refs를 compileScenario(create/validate)에 전달.
export function registerScenarioRoutes(app: FastifyInstance, deps: ApiServerDeps): void {
  // POST /v1/scenarios — 생성(저장). body=IR 문서 → 파이프라인 통과 시 scenario + scenario_version(v=meta.version, draft).
  app.post("/v1/scenarios", { config: { rbacAction: "scenario.create" } }, async (request, reply) => {
    const principal = requirePrincipal(request);
    const outcome = compileScenario(request.body);
    if (!outcome.ok) {
      throw new ApiResponseError(outcome.code, outcome.details);
    }
    const ir = outcome.ir;
    const created = await withTenantTx(deps.pool, principal.tenantId, async (c) => {
      const sc = await c.query<{ id: string }>(
        `INSERT INTO scenarios (id, tenant_id, name) VALUES ($1::uuid, $2::uuid, $3)
         ON CONFLICT (tenant_id, name) DO NOTHING RETURNING id`,
        [randomUUID(), principal.tenantId, ir.meta.name],
      );
      if (sc.rowCount === 0) {
        // 동일 tenant 내 이름 중복 — 새 시나리오 생성 불가(전용 코드 없음 → 정의 오류로 표면화, "조용한 false 금지").
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

  // GET /v1/scenarios/:scenario_id — 메타 + 최신 version. ETag=scenario_versions.version(api-surface §0.3).
  app.get<{ Params: { scenario_id: string } }>(
    "/v1/scenarios/:scenario_id",
    { config: { rbacAction: "scenario.read" } },
    async (request, reply) => {
      const principal = requirePrincipal(request);
      const id = request.params.scenario_id;
      if (!UUID_RE.test(id)) {
        throw new ApiResponseError("RESOURCE_NOT_FOUND");
      }
      const row = await withTenantTx(deps.pool, principal.tenantId, async (c) => {
        const r = await c.query<{ id: string; name: string; version: number; promotion_status: string }>(
          `SELECT s.id, s.name, sv.version, sv.promotion_status
             FROM scenarios s
             JOIN scenario_versions sv ON sv.scenario_id = s.id
            WHERE s.id = $1::uuid
            ORDER BY sv.version DESC
            LIMIT 1`,
          [id],
        );
        return r.rows[0] ?? null;
      });
      if (row === null) {
        // RLS가 타테넌트를 숨기므로 cross-tenant도 동일하게 not-found(존재 비노출).
        throw new ApiResponseError("RESOURCE_NOT_FOUND");
      }
      reply
        .code(200)
        .header("ETag", String(row.version))
        .send({ scenario_id: row.id, name: row.name, version: row.version, promotion_status: row.promotion_status });
    },
  );

  // POST /v1/scenarios/:scenario_id/validate — 부작용 없는 dry-run. ajv 통과 시 ValidationReport(200), ajv 실패는 422.
  app.post<{ Params: { scenario_id: string } }>(
    "/v1/scenarios/:scenario_id/validate",
    { config: { rbacAction: "scenario.read" } },
    async (request) => {
      requirePrincipal(request);
      const outcome = compileScenario(request.body);
      if (!outcome.ok) {
        if (outcome.report === undefined) {
          // ajv 단계 실패(파싱 불가) → 보고서 생성 불가 → 422.
          throw new ApiResponseError(outcome.code, outcome.details);
        }
        // 그래프/IREL errors → dry-run은 보고서로 반환(저장 안 함). 클라이언트가 errors를 점검.
        return { valid: false, report: outcome.report };
      }
      return { valid: true, report: outcome.report };
    },
  );
}
