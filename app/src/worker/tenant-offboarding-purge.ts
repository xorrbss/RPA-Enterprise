// tenant_offboarding_purge 잡 처리기(설계 rpa-offboarding-data-export-deletion-design O4 — hard 단계).
// approved 원장의 purge_after 경과 시 테넌트 데이터를 비가역 삭제한다. BYPASSRLS lifecycle role 전용
// (artifacts 행 삭제는 RLS DELETE 정책 부재로 tenant role 불가 — graphile-runner 가 lifecycle task 로 라우팅).
//
// 순서: ① 원장 CAS(approved→purging; purging 재개=재시도 멱등) ② artifact 본문 드레인 — 기존 retention
// 경로 재사용(retention_until 당김 → ArtifactRetentionProcessor 반복: claim→object delete→row tombstone,
// legal_hold 는 그 경로가 이미 제외) ③ 삭제 레지스트리(FK 역순, children-first) ctid 배치 물리 DELETE
// — legal_hold 행 제외, FK 위반(잔존 hold 의 부모)은 행 단위 SAVEPOINT 로 건너뜀(조용한 skip 이 아니라
// held_rows 로 보고) ④ 잔존 스냅샷(held_rows) + bypassrls.use 감사(fail-closed, finalize 와 같은 tx)
// + 원장 purged. per-tick cap 초과 시 deferred — graphile 재시도가 남은 배치를 이어간다(멱등).
//
// 제외(설계 §5 O4 명시): audit_log/audit_verifier_runs(WORM — 트리거도 차단), control_plane_idempotency_keys
// (TTL 자체 소멸), tenant_offboarding_requests(원장 자신 — 처분 증빙, D5 무기한 보존).
import type pg from "pg";

import type { RuntimeJobResult, RuntimeWorkerJob } from "../../../ts/runtime-contract";
import { withTenantTx } from "../db/pool";
import type { ArtifactRetentionProcessor } from "./artifact-retention-processor";
import { lifecycleAuditRetentionDays } from "./runtime-worker-artifact-lifecycle";
import { appendWorkerBypassAuditWithClient, assertLifecycleBypassUse } from "./runtime-worker-lifecycle-audit";
import { requireString } from "./runtime-worker-parse";

/** purge 에서 제외하는 tenant 테이블(설계 §5 O4-6). 레지스트리+제외 = 전체 tenant 테이블(정보스키마 대조 테스트가 잠금). */
export const TENANT_PURGE_EXCLUDED_TABLES: readonly string[] = [
  "audit_log",
  "audit_verifier_runs",
  "control_plane_idempotency_keys",
  "tenant_offboarding_requests",
];

/**
 * 삭제 레지스트리 — FK 역순(children-first). 순서 불변식: 모든 FK 간선(child→parent)에서 child 가 parent 보다
 * 먼저 온다(int 테스트가 pg_catalog 간선과 대조). 유일한 상호 FK 사이클(connector_profiles ↔
 * connector_certifications)은 삭제 전 latest_certification_id NULL-out 프리스텝으로 절단한다.
 */
export const TENANT_PURGE_TABLE_ORDER: readonly string[] = [
  "ai_governance_evidence",
  "ai_runtime_policies",
  "approval_decisions",
  "approval_row_claims",
  "automation_adoption_evidence",
  "browser_leases",
  "browser_recording_events",
  "browser_sessions",
  "capture_sessions",
  "challenge_resolution_attempts",
  "connector_certifications",
  "connector_profiles",
  "credential_binding_events",
  "credential_concurrency_policies",
  "credential_leases",
  "dead_letter",
  "document_extractions",
  "document_jobs",
  "artifact_redaction_failures",
  "artifacts",
  "events_outbox",
  "gateway_policies",
  "integration_handoff_dispatch_attempts",
  "integration_handoff_receipts",
  "integration_handoffs",
  "network_policies",
  "ops_alert_acknowledgements",
  "ops_alert_notification_routes",
  "ops_notification_attempts",
  "ops_notification_deliveries",
  "principal_role_assignment_events",
  "principal_role_assignments",
  "principals",
  "production_readiness_evidence",
  "roi_actual_evidence",
  "roi_estimates",
  "automation_ideas",
  "process_mining_imports",
  "run_pause_requests",
  "run_reruns",
  "run_resume_requests",
  "run_trigger_fires",
  "run_triggers",
  "scenario_environment_bindings",
  "scenario_generation_llm_calls",
  "scenario_generations",
  "scenario_promotion_requests",
  "scenario_release_events",
  "scenario_releases",
  "scim_group_role_mappings",
  "scim_providers",
  "sink_deliveries",
  "normalized_records",
  "raw_items",
  "site_block_samples",
  "site_element_repository",
  "site_profile_approvals",
  "stagehand_calls",
  "run_steps",
  "action_plan_cache",
  "studio_validation_runs",
  "studio_graph_versions",
  "studio_projects",
  "browser_recording_sessions",
  "browser_identities",
  "site_profiles",
  "web_attended_run_requests",
  "human_tasks",
  "runs",
  "scenario_versions",
  "scenarios",
  "worker_pool_assignments",
  "workitems",
];

const DEFAULT_ROW_CAP_PER_TICK = 20_000;
const DEFAULT_ARTIFACT_CAP_PER_TICK = 200;
const DELETE_BATCH_SIZE = 1_000;
const DEFERRED_RETRY_AFTER_MS = 5_000;

export interface TenantOffboardingPurgeDeps {
  readonly workerId?: string;
  readonly offboardingPurgeRowCapPerTick?: number;
  readonly offboardingPurgeArtifactCapPerTick?: number;
  readonly artifactLifecycleAuditRetentionDays?: number;
}

export class TenantOffboardingPurgeProcessor {
  constructor(
    private readonly pool: pg.Pool,
    private readonly deps: TenantOffboardingPurgeDeps,
    private readonly artifactRetention: ArtifactRetentionProcessor,
  ) {}

  async handle(job: RuntimeWorkerJob): Promise<RuntimeJobResult> {
    const tenantId = requireString(job.tenantId, "tenant_offboarding_purge.tenantId");
    const correlationId = requireString(job.correlationId, "tenant_offboarding_purge.correlationId");
    const workerId = requireString(this.deps.workerId, "PgRuntimeWorkerOptions.workerId for tenant_offboarding_purge");

    // ① 원장 claim — approved(만기)→purging CAS, purging 은 재개(부분 실패 재시도 멱등). 대상 없으면 no-op.
    const ledgerId = await withTenantTx(this.pool, tenantId, async (client) => {
      await assertLifecycleBypassUse(client, "tenant_offboarding_purge", "tenant_offboarding.purge.claim");
      const claimed = await client.query<{ id: string }>(
        `UPDATE tenant_offboarding_requests
            SET status = 'purging', updated_at = now()
          WHERE tenant_id = $1::uuid
            AND (status = 'purging' OR (status = 'approved' AND purge_after <= now()))
          RETURNING id`,
        [tenantId],
      );
      return claimed.rows[0]?.id ?? null;
    });
    if (ledgerId === null) {
      return { kind: "completed", emittedEvents: [] };
    }

    // ② artifact 본문 드레인 — retention 경로 재사용: legal_hold=false 미삭제 행의 retention 을 당기고,
    //    ArtifactRetentionProcessor(claim→CAS 재검사→object delete→tombstone)를 잔여 0 까지 반복(per-tick cap).
    await withTenantTx(this.pool, tenantId, async (client) => {
      await assertLifecycleBypassUse(client, "tenant_offboarding_purge", "tenant_offboarding.purge.artifact_retention_pull");
      await client.query(
        `UPDATE artifacts
            SET retention_until = now() - interval '1 second'
          WHERE tenant_id = $1::uuid AND legal_hold = false AND deleted_at IS NULL
            AND (retention_until IS NULL OR retention_until > now())`,
        [tenantId],
      );
    });
    let artifactBudget = this.deps.offboardingPurgeArtifactCapPerTick ?? DEFAULT_ARTIFACT_CAP_PER_TICK;
    for (;;) {
      const remaining = await this.countRemainingDeletableArtifacts(tenantId);
      if (remaining === 0) break;
      if (artifactBudget <= 0) {
        return { kind: "deferred", code: "SESSION_LOCKED", retryAfterMs: DEFERRED_RETRY_AFTER_MS };
      }
      artifactBudget -= 1;
      const result = await this.artifactRetention.handle({
        kind: "artifact_retention",
        tenantId: job.tenantId,
        correlationId: job.correlationId,
      });
      if (result.kind !== "completed") return result;
      const after = await this.countRemainingDeletableArtifacts(tenantId);
      if (after >= remaining) {
        // claim 이 소진됐는데 잔여가 줄지 않으면(청구 만료 대기 등) 조용한 무한루프 대신 재시도로 넘긴다.
        return { kind: "deferred", code: "SESSION_LOCKED", retryAfterMs: DEFERRED_RETRY_AFTER_MS };
      }
    }

    // ③ 레지스트리 물리 삭제 — 사이클 절단 프리스텝 후 children-first 순회. legal_hold 컬럼 보유 테이블은 hold 제외.
    const legalHoldTables = await this.legalHoldTables();
    await withTenantTx(this.pool, tenantId, async (client) => {
      await assertLifecycleBypassUse(client, "tenant_offboarding_purge", "tenant_offboarding.purge.connector_cycle_cut");
      await client.query(
        `UPDATE connector_profiles SET latest_certification_id = NULL WHERE tenant_id = $1::uuid`,
        [tenantId],
      );
    });
    let rowBudget = this.deps.offboardingPurgeRowCapPerTick ?? DEFAULT_ROW_CAP_PER_TICK;
    for (const table of TENANT_PURGE_TABLE_ORDER) {
      for (;;) {
        if (rowBudget <= 0) {
          return { kind: "deferred", code: "SESSION_LOCKED", retryAfterMs: DEFERRED_RETRY_AFTER_MS };
        }
        const batch = Math.min(DELETE_BATCH_SIZE, rowBudget);
        const outcome = await this.deleteBatch(tenantId, table, legalHoldTables.has(table), batch);
        rowBudget -= outcome.deleted;
        if (outcome.exhaustedBudget) {
          return { kind: "deferred", code: "SESSION_LOCKED", retryAfterMs: DEFERRED_RETRY_AFTER_MS };
        }
        // 진행 0 = 삭제 가능 행 소진(남은 행은 legal_hold 또는 hold 의 FK 부모 — 잔존 스냅샷으로 보고).
        if (outcome.deleted === 0) break;
      }
    }

    // ④ 잔존 스냅샷(held_rows — 조용한 skip 금지: 무엇이 남았는지 원장에 기록) + 감사 + purged 확정(같은 tx, fail-closed).
    const heldRows: Record<string, number> = {};
    for (const table of TENANT_PURGE_TABLE_ORDER) {
      const count = await this.countTenantRows(tenantId, table);
      if (count > 0) heldRows[table] = count;
    }
    await withTenantTx(this.pool, tenantId, async (client) => {
      await assertLifecycleBypassUse(client, "tenant_offboarding_purge", "tenant_offboarding.purge.finalize");
      await appendWorkerBypassAuditWithClient(client, {
        tenantId,
        correlationId,
        workerId,
        reason: "tenant_offboarding.purge.completed",
        idempotencyKey: `tenant_offboarding_purge:${ledgerId}:${correlationId}`,
        retentionDays: lifecycleAuditRetentionDays(this.deps.artifactLifecycleAuditRetentionDays),
        payload: {
          decision_kind: "tenant_offboarding.purge",
          request_id: ledgerId,
          held_rows: heldRows,
          fail_closed: true,
        },
      });
      const finalized = await client.query(
        `UPDATE tenant_offboarding_requests
            SET status = 'purged', purged_at = now(), held_rows = $3::jsonb, updated_at = now()
          WHERE tenant_id = $1::uuid AND id = $2::uuid AND status = 'purging'`,
        [tenantId, ledgerId, JSON.stringify(heldRows)],
      );
      if (finalized.rowCount !== 1) {
        throw new Error(`tenant_offboarding_purge: ledger finalize CAS failed for ${ledgerId}`);
      }
    });
    return { kind: "completed", emittedEvents: [] };
  }

  private async countRemainingDeletableArtifacts(tenantId: string): Promise<number> {
    return withTenantTx(this.pool, tenantId, async (client) => {
      const result = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM artifacts
          WHERE tenant_id = $1::uuid AND legal_hold = false AND deleted_at IS NULL`,
        [tenantId],
      );
      return result.rows[0]?.n ?? 0;
    });
  }

  private async countTenantRows(tenantId: string, table: string): Promise<number> {
    return withTenantTx(this.pool, tenantId, async (client) => {
      const result = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM ${quoteIdent(table)} WHERE tenant_id = $1::uuid`,
        [tenantId],
      );
      return result.rows[0]?.n ?? 0;
    });
  }

  /** legal_hold 컬럼 보유 테이블(정보스키마) — 해당 테이블은 hold=false 만 삭제(설계 §4-3). */
  private async legalHoldTables(): Promise<Set<string>> {
    const result = await this.pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.columns
        WHERE column_name = 'legal_hold' AND table_name = ANY($1::text[])
        GROUP BY table_name`,
      [[...TENANT_PURGE_TABLE_ORDER]],
    );
    return new Set(result.rows.map((row) => row.table_name));
  }

  /**
   * ctid 배치 삭제. FK 위반(23503 — 잔존 legal_hold 행의 부모)이 나면 배치 전체를 버리는 대신
   * ctid keyset 전체 스윕으로 전환해 행 단위 SAVEPOINT 로 위반 행만 건너뛴다: children-first 순서라
   * 위반은 hold-스파인에만 발생하고, 건너뛴 행은 held_rows 스냅샷으로 보고된다(조용한 skip 금지).
   */
  private async deleteBatch(
    tenantId: string,
    table: string,
    hasLegalHold: boolean,
    budget: number,
  ): Promise<{ deleted: number; exhaustedBudget: boolean }> {
    const ident = quoteIdent(table);
    const holdClause = hasLegalHold ? "AND legal_hold = false" : "";
    try {
      const deleted = await withTenantTx(this.pool, tenantId, async (client) => {
        await assertLifecycleBypassUse(client, "tenant_offboarding_purge", `tenant_offboarding.purge.delete.${table}`);
        const result = await client.query(
          `DELETE FROM ${ident}
            WHERE ctid IN (SELECT ctid FROM ${ident} WHERE tenant_id = $1::uuid ${holdClause} LIMIT $2)`,
          [tenantId, budget],
        );
        return result.rowCount ?? 0;
      });
      return { deleted, exhaustedBudget: false };
    } catch (err) {
      if (!isFkViolation(err)) throw err;
      return this.deleteRowByRowSkippingFkParents(tenantId, table, holdClause, budget);
    }
  }

  /**
   * ctid keyset 전체 스윕 — 페이지 순서 무관하게 테이블의 모든 후보 행을 정확히 1회씩 방문한다
   * (부분 페이지가 hold-부모로만 차 있어도 뒤 페이지의 삭제 가능 행을 놓치지 않음). 삭제 수가 budget 에
   * 닿으면 조기 반환 → 호출측이 deferred 로 넘겨 다음 재시도가 이어간다(멱등).
   */
  private async deleteRowByRowSkippingFkParents(
    tenantId: string,
    table: string,
    holdClause: string,
    budget: number,
  ): Promise<{ deleted: number; exhaustedBudget: boolean }> {
    const ident = quoteIdent(table);
    return withTenantTx(this.pool, tenantId, async (client) => {
      await assertLifecycleBypassUse(client, "tenant_offboarding_purge", `tenant_offboarding.purge.delete_rows.${table}`);
      let deleted = 0;
      let cursor = "(0,0)";
      for (;;) {
        const candidates = await client.query<{ ctid: string }>(
          `SELECT ctid::text AS ctid FROM ${ident}
            WHERE tenant_id = $1::uuid ${holdClause} AND ctid > $2::tid
            ORDER BY ctid LIMIT $3`,
          [tenantId, cursor, DELETE_BATCH_SIZE],
        );
        if (candidates.rows.length === 0) return { deleted, exhaustedBudget: false };
        for (const row of candidates.rows) {
          cursor = row.ctid;
          await client.query("SAVEPOINT purge_row");
          try {
            const result = await client.query(
              `DELETE FROM ${ident} WHERE ctid = $1::tid AND tenant_id = $2::uuid`,
              [row.ctid, tenantId],
            );
            deleted += result.rowCount ?? 0;
            await client.query("RELEASE SAVEPOINT purge_row");
          } catch (err) {
            await client.query("ROLLBACK TO SAVEPOINT purge_row");
            if (!isFkViolation(err)) throw err;
            // 잔존 hold 행이 참조하는 부모 — 삭제 불가가 정당(무결성). held_rows 스냅샷으로 보고된다.
          }
          if (deleted >= budget) return { deleted, exhaustedBudget: true };
        }
      }
    });
  }
}

function quoteIdent(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) {
    throw new Error(`tenant_offboarding_purge: invalid table identifier ${name}`);
  }
  return `"${name}"`;
}

function isFkViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "23503";
}
