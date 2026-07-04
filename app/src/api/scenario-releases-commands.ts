import { createHash, randomUUID } from "node:crypto";

import type { FastifyRequest } from "fastify";
import type { PoolClient } from "pg";

import { compileScenario } from "./compile-pipeline";
import type { CommandResponse } from "./command";
import { ApiResponseError } from "../runtime/errors";
import { appendGovernanceAudit } from "./role-assignments";
import { readProductionReadiness, type ProductionReadinessConfig } from "./production-readiness";
import { assertScenarioVersionCertifiedForProd } from "./scenario-certification";
import { requirePrincipal, type ApiServerDeps } from "./server-shared";
import { appendReleaseEvent, assertLatestVersion, loadRelease, loadScenarioVersion, loadScenarioVersionById, releaseDetail, type ReleaseStatus, type ReleaseTargetEnvironment } from "./scenario-releases-store";

export interface CreateReleaseBody {
  readonly sourceVersion: number;
  readonly targetEnvironment: ReleaseTargetEnvironment;
  readonly reason: string | null;
}

export async function createRelease(
  client: PoolClient,
  request: FastifyRequest,
  tenantId: string,
  scenarioId: string,
  body: CreateReleaseBody,
  signedCommandRefs: readonly string[] | undefined,
): Promise<CommandResponse> {
  const actor = requirePrincipal(request);
  const source = await loadScenarioVersion(client, tenantId, scenarioId, body.sourceVersion);
  const outcome = compileScenario(source.ir, { promote: true, signedCommandRefs });
  if (!outcome.ok) throw new ApiResponseError(outcome.code, outcome.details);
  const packageHash = packageHashFor({
    scenario_id: scenarioId,
    source_version_id: source.version_id,
    target_environment: body.targetEnvironment,
    ir: outcome.ir,
    params_schema: outcome.ir.params_schema ?? null,
    validation_report: outcome.report,
  });
  const releaseId = randomUUID();
  await client.query(
    `INSERT INTO scenario_releases
       (id, tenant_id, scenario_id, source_version_id, target_environment, status,
        package_hash, validation_report, requested_by, reason)
     VALUES
       ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, 'draft', $6, $7::jsonb, $8, $9)`,
    [releaseId, tenantId, scenarioId, source.version_id, body.targetEnvironment, packageHash, JSON.stringify(outcome.report), actor.subjectId, body.reason],
  );
  await appendReleaseEvent(client, tenantId, releaseId, "created", actor.subjectId, body.reason);
  await appendGovernanceAudit(client, request, "scenario_release.create", "allow", "release_created", {
    release_id: releaseId,
    scenario_id: scenarioId,
    source_version: source.version,
    target_environment: body.targetEnvironment,
    package_hash: packageHash,
  });
  return { status: 201, body: await releaseDetail(client, tenantId, releaseId) };
}

export async function transitionRelease(
  client: PoolClient,
  request: FastifyRequest,
  tenantId: string,
  releaseId: string,
  next: Extract<ReleaseStatus, "submitted" | "approved" | "rejected">,
  reason: string | null,
  readinessConfig: ProductionReadinessConfig,
): Promise<CommandResponse> {
  const actor = requirePrincipal(request);
  const release = await loadRelease(client, tenantId, releaseId);
  if (next === "submitted" && release.status !== "draft") {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "release_not_draft", status: release.status });
  }
  if ((next === "approved" || next === "rejected") && release.status !== "submitted") {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "release_not_submitted", status: release.status });
  }
  if (next === "approved" && release.requested_by === actor.subjectId) {
    throw new ApiResponseError("AUTHZ_FORBIDDEN", { reason: "maker_checker_violation" });
  }
  if (next === "approved" && release.target_environment === "prod") {
    await assertScenarioVersionCertifiedForProd(client, tenantId, release.scenario_id, release.source_version_id);
    await assertControlledProdReady(client, tenantId, readinessConfig);
  }
  const eventType = next === "approved" ? "approved" : next === "rejected" ? "rejected" : "submitted";
  const auditAction = next === "approved"
    ? "scenario_release.approve"
    : next === "rejected"
      ? "scenario_release.reject"
      : "scenario_release.submit";
  if (next === "submitted") {
    await client.query(
      `UPDATE scenario_releases SET status='submitted', submitted_at=now(), updated_at=now()
        WHERE tenant_id=$1::uuid AND id=$2::uuid`,
      [tenantId, releaseId],
    );
  } else if (next === "approved") {
    await client.query(
      `UPDATE scenario_releases SET status='approved', approved_by=$1, approved_at=now(), updated_at=now()
        WHERE tenant_id=$2::uuid AND id=$3::uuid`,
      [actor.subjectId, tenantId, releaseId],
    );
  } else {
    if (reason === null) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "rejection_reason_required" });
    await client.query(
      `UPDATE scenario_releases SET status='rejected', rejected_by=$1, rejected_at=now(), rejection_reason=$2, updated_at=now()
        WHERE tenant_id=$3::uuid AND id=$4::uuid`,
      [actor.subjectId, reason, tenantId, releaseId],
    );
  }
  await appendReleaseEvent(client, tenantId, releaseId, eventType, actor.subjectId, reason);
  await appendGovernanceAudit(client, request, auditAction, "allow", `release_${eventType}`, {
    release_id: releaseId,
    scenario_id: release.scenario_id,
    target_environment: release.target_environment,
    package_hash: release.package_hash,
  });
  return { status: 200, body: await releaseDetail(client, tenantId, releaseId) };
}

export async function deployRelease(
  client: PoolClient,
  request: FastifyRequest,
  tenantId: string,
  releaseId: string,
  expectedVersion: number,
  signedCommandRefs: readonly string[] | undefined,
  readinessConfig: ProductionReadinessConfig,
): Promise<CommandResponse> {
  const actor = requirePrincipal(request);
  const release = await loadRelease(client, tenantId, releaseId);
  if (release.status !== "approved") {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "release_not_approved", status: release.status });
  }
  const source = await loadScenarioVersionById(client, tenantId, release.scenario_id, release.source_version_id);
  if (release.target_environment === "prod") {
    await assertScenarioVersionCertifiedForProd(client, tenantId, release.scenario_id, release.source_version_id);
    await assertControlledProdReady(client, tenantId, readinessConfig);
  }
  await assertLatestVersion(client, tenantId, release.scenario_id, expectedVersion);
  const outcome = compileScenario(source.ir, { promote: true, signedCommandRefs });
  if (!outcome.ok) throw new ApiResponseError(outcome.code, outcome.details);
  await applyEnvironmentBinding(client, tenantId, release.scenario_id, release.target_environment, release.source_version_id, releaseId, actor.subjectId, outcome.compiledAst);
  await client.query(
    `UPDATE scenario_releases SET status='deployed', deployed_by=$1, deployed_at=now(), updated_at=now()
      WHERE tenant_id=$2::uuid AND id=$3::uuid`,
    [actor.subjectId, tenantId, releaseId],
  );
  await appendReleaseEvent(client, tenantId, releaseId, "deployed", actor.subjectId, null);
  await appendGovernanceAudit(client, request, "scenario_release.deploy", "allow", "release_deployed", {
    release_id: releaseId,
    scenario_id: release.scenario_id,
    source_version: source.version,
    target_environment: release.target_environment,
    package_hash: release.package_hash,
  });
  return { status: 200, body: await releaseDetail(client, tenantId, releaseId, true) };
}

export async function rollbackRelease(
  client: PoolClient,
  request: FastifyRequest,
  tenantId: string,
  releaseId: string,
  expectedVersion: number,
  signedCommandRefs: readonly string[] | undefined,
): Promise<CommandResponse> {
  const actor = requirePrincipal(request);
  const release = await loadRelease(client, tenantId, releaseId);
  if (release.status !== "deployed") {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "release_not_deployed", status: release.status });
  }
  await assertLatestVersion(client, tenantId, release.scenario_id, expectedVersion);
  const previous = await client.query<{ scenario_version_id: string }>(
    `SELECT scenario_version_id::text
       FROM scenario_environment_bindings
      WHERE tenant_id=$1::uuid
        AND scenario_id=$2::uuid
        AND environment=$3
        AND deactivated_at IS NOT NULL
        AND release_id IS DISTINCT FROM $4::uuid
      ORDER BY activated_at DESC
      LIMIT 1`,
    [tenantId, release.scenario_id, release.target_environment, releaseId],
  );
  const previousVersionId = previous.rows[0]?.scenario_version_id;
  if (previousVersionId === undefined) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "rollback_target_missing" });
  }
  const source = await loadScenarioVersionById(client, tenantId, release.scenario_id, previousVersionId);
  if (release.target_environment === "prod") {
    await assertScenarioVersionCertifiedForProd(client, tenantId, release.scenario_id, previousVersionId);
  }
  const outcome = compileScenario(source.ir, { promote: true, signedCommandRefs });
  if (!outcome.ok) throw new ApiResponseError(outcome.code, outcome.details);
  const packageHash = packageHashFor({
    scenario_id: release.scenario_id,
    source_version_id: previousVersionId,
    target_environment: release.target_environment,
    ir: outcome.ir,
    params_schema: outcome.ir.params_schema ?? null,
    validation_report: outcome.report,
  });
  const rollbackId = randomUUID();
  await client.query(
    `INSERT INTO scenario_releases
       (id, tenant_id, scenario_id, source_version_id, target_environment, status, package_hash,
        validation_report, requested_by, requested_at, submitted_at, approved_by, approved_at,
        deployed_by, deployed_at, rollback_of_release_id, reason)
     VALUES
       ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, 'deployed', $6, $7::jsonb,
        $8, now(), now(), $8, now(), $8, now(), $9::uuid, $10)`,
    [rollbackId, tenantId, release.scenario_id, previousVersionId, release.target_environment, packageHash, JSON.stringify(outcome.report), actor.subjectId, releaseId, "rollback"],
  );
  await client.query(
    `UPDATE scenario_releases SET status='rolled_back', updated_at=now()
      WHERE tenant_id=$1::uuid AND id=$2::uuid`,
    [tenantId, releaseId],
  );
  await applyEnvironmentBinding(client, tenantId, release.scenario_id, release.target_environment, previousVersionId, rollbackId, actor.subjectId, outcome.compiledAst);
  await appendReleaseEvent(client, tenantId, rollbackId, "created", actor.subjectId, "rollback");
  await appendReleaseEvent(client, tenantId, rollbackId, "approved", actor.subjectId, "rollback");
  await appendReleaseEvent(client, tenantId, rollbackId, "deployed", actor.subjectId, "rollback");
  await appendReleaseEvent(client, tenantId, releaseId, "rolled_back", actor.subjectId, "rollback");
  await appendGovernanceAudit(client, request, "scenario_release.rollback", "allow", "release_rolled_back", {
    release_id: releaseId,
    rollback_release_id: rollbackId,
    scenario_id: release.scenario_id,
    source_version: source.version,
    target_environment: release.target_environment,
    package_hash: packageHash,
  });
  return { status: 201, body: await releaseDetail(client, tenantId, rollbackId, true) };
}

async function assertControlledProdReady(
  client: PoolClient,
  tenantId: string,
  readinessConfig: ProductionReadinessConfig,
): Promise<void> {
  const readiness = await readProductionReadiness(client, tenantId, readinessConfig);
  if (readiness.summary.controlled_prod_ready) return;
  const blockingGateIds = readiness.gates
    .filter((gate) => gate.status === "blocked")
    .map((gate) => gate.gate_id);
  const deferredGateIds = readiness.gates
    .filter((gate) => gate.status === "deferred")
    .map((gate) => gate.gate_id);
  throw new ApiResponseError("IR_SCHEMA_INVALID", {
    reason: "controlled_prod_readiness_required",
    status: readiness.summary.status,
    blocker_count: readiness.summary.blocker_count,
    warning_count: readiness.summary.warning_count,
    deferred_count: readiness.summary.deferred_count,
    blocking_gate_ids: blockingGateIds,
    deferred_gate_ids: deferredGateIds,
  });
}

export function productionReadinessConfig(deps: ApiServerDeps): ProductionReadinessConfig {
  return {
    authReadiness: deps.authReadiness,
    aiGovernanceConfiguredModels: deps.aiGovernanceConfiguredModels,
    aiGovernanceConfiguredPromptVersions: deps.aiGovernanceConfiguredPromptVersions,
  };
}

async function applyEnvironmentBinding(
  client: PoolClient,
  tenantId: string,
  scenarioId: string,
  environment: ReleaseTargetEnvironment,
  scenarioVersionId: string,
  releaseId: string,
  actorSub: string,
  compiledAst: string,
): Promise<void> {
  const newBindingId = randomUUID();
  const previous = await client.query<{ id: string }>(
    `UPDATE scenario_environment_bindings
        SET deactivated_by=$1::text, deactivated_at=now()
      WHERE tenant_id=$2::uuid AND scenario_id=$3::uuid AND environment=$4 AND deactivated_at IS NULL`,
    [actorSub, tenantId, scenarioId, environment],
  );
  await client.query(
    `INSERT INTO scenario_environment_bindings
       (id, tenant_id, scenario_id, environment, scenario_version_id, release_id, activated_by)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::uuid, $6::uuid, $7::text)`,
    [newBindingId, tenantId, scenarioId, environment, scenarioVersionId, releaseId, actorSub],
  );
  if ((previous.rowCount ?? 0) > 0) {
    await client.query(
      `UPDATE scenario_environment_bindings
          SET replaced_by_binding_id=$1::uuid
        WHERE tenant_id=$2::uuid AND scenario_id=$3::uuid AND environment=$4
          AND deactivated_at IS NOT NULL AND replaced_by_binding_id IS NULL`,
      [newBindingId, tenantId, scenarioId, environment],
    );
  }
  if (environment === "prod") {
    await client.query(
      `UPDATE scenario_versions
          SET promotion_status='draft', promoted_at=NULL
        WHERE tenant_id=$1::uuid AND scenario_id=$2::uuid AND id <> $3::uuid AND promotion_status='prod'`,
      [tenantId, scenarioId, scenarioVersionId],
    );
    await client.query(
      `UPDATE scenario_versions
          SET promotion_status='prod', compiled_ast=$1, promoted_at=now()
        WHERE tenant_id=$2::uuid AND id=$3::uuid`,
      [compiledAst, tenantId, scenarioVersionId],
    );
  }
}

function packageHashFor(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalize(value)).digest("hex")}`;
}

// [R2-5 동결] 배포본 패키지 해시(scenario_releases)의 바이트 형식 — audit-record-hash 와 동일 구현이나
//   별도 저장 도메인(둘 다 저장 해시)이라 공유 시 한쪽 변경이 다른쪽 원장을 깨는 결합을 만든다. 통합 금지.
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((item) => canonicalize(item)).join(",")}]`;
  const entries = Object.entries(value as Readonly<Record<string, unknown>>)
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonicalize(child)}`).join(",")}}`;
}
