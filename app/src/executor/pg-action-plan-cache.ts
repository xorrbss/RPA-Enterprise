/**
 * PgActionPlanCache — ActionPlanCache 의 PostgreSQL 구현 (D3 — db action_plan_cache / impl-bundle §D).
 *
 * 테넌트 바인딩 트랜잭션(withTenantTx, RLS strict app.tenant_id) 위에서 동작한다. 키는 테이블 UNIQUE 7컬럼.
 * put 은 그 UNIQUE 로 ON CONFLICT DO UPDATE(success_count+1, status='active' 재검증). get 은 **active 만** 재생.
 * markSuspect 는 active→suspect→stale(재생 차단); 미존재 시 suspect 1회 기록(§D failed plan).
 *
 * plan_ref(text): 본 구현은 직렬화된 ActionPlan 을 직접 싣는다(자기완결 참조). 대용량/외부화는 후속(artifact).
 */
import type { PgPool } from "../db/pool";
import { withTenantTx } from "../db/pool";
import { recordCacheLookup } from "../observability/telemetry";
import {
  parseActionPlan,
  type ActionPlan,
  type ActionPlanCache,
  type ActionPlanCacheHit,
  type ActionPlanCacheKey,
} from "./action-plan-cache";

/** 키 8값(tenant + UNIQUE 7컬럼) — SQL $1..$8 순서 고정. */
function keyParams(k: ActionPlanCacheKey): unknown[] {
  return [
    k.tenantId,
    k.scenarioVersionId,
    k.stepId,
    k.urlPattern,
    k.domStructuralHash,
    k.model,
    k.promptTemplateVersion,
    k.browserIdentityVersion,
  ];
}

const KEY_WHERE = `tenant_id=$1 AND scenario_version_id=$2 AND step_id=$3 AND url_pattern=$4
   AND dom_structural_hash=$5 AND model=$6 AND prompt_template_version=$7 AND browser_identity_version=$8`;

export class PgActionPlanCache implements ActionPlanCache {
  constructor(private readonly pool: PgPool) {}

  async get(key: ActionPlanCacheKey): Promise<ActionPlanCacheHit | undefined> {
    const hit = await withTenantTx(this.pool, key.tenantId, async (c) => {
      const r = await c.query<{ id: string; plan_ref: string | null; status: string }>(
        `SELECT id::text, plan_ref, status FROM action_plan_cache WHERE ${KEY_WHERE}`,
        keyParams(key),
      );
      const row = r.rows[0];
      // active 만 재생(suspect/stale/quarantined → miss → 재해석). plan_ref 부재도 miss.
      if (!row || row.status !== "active" || row.plan_ref === null) return undefined;
      try {
        const plan = parseActionPlan(JSON.parse(row.plan_ref));
        return plan === undefined ? undefined : { plan, cacheId: row.id }; // cacheId=run_steps.action_plan_cache_id 링크
      } catch {
        return undefined; // 손상된 plan_ref → 조용한 재생 금지(miss 로 재해석).
      }
    });
    // §E cache_hit_rate: 재생 가능(active+유효) 여부로 hit/miss. bootstrap 전이면 no-op meter.
    recordCacheLookup(hit !== undefined, { tenant_id: key.tenantId });
    return hit;
  }

  async put(key: ActionPlanCacheKey, plan: ActionPlan): Promise<void> {
    await withTenantTx(this.pool, key.tenantId, async (c) => {
      await c.query(
        `INSERT INTO action_plan_cache
           (id, tenant_id, scenario_version_id, step_id, url_pattern, dom_structural_hash,
            model, prompt_template_version, browser_identity_version, plan_ref, status, success_count, last_success_at)
         VALUES (gen_random_uuid(), $1,$2,$3,$4,$5,$6,$7,$8, $9, 'active', 1, now())
         ON CONFLICT (scenario_version_id, step_id, url_pattern, dom_structural_hash,
                      model, prompt_template_version, browser_identity_version)
         DO UPDATE SET plan_ref = EXCLUDED.plan_ref,
                       status = 'active',
                       success_count = action_plan_cache.success_count + 1,
                       last_success_at = now()`,
        [...keyParams(key), JSON.stringify(plan)],
      );
    });
  }

  async markSuspect(key: ActionPlanCacheKey): Promise<void> {
    await withTenantTx(this.pool, key.tenantId, async (c) => {
      // active→suspect→stale(§7.2 재생 차단). 종결(quarantined) 등은 불변.
      const upd = await c.query(
        `UPDATE action_plan_cache
            SET status = CASE status WHEN 'active' THEN 'suspect' WHEN 'suspect' THEN 'stale' ELSE status END
          WHERE ${KEY_WHERE}`,
        keyParams(key),
      );
      if (upd.rowCount === 0) {
        // 미존재 family 의 실패 해석 → suspect 1회 기록(plan 미저장, 재생 불가).
        await c.query(
          `INSERT INTO action_plan_cache
             (id, tenant_id, scenario_version_id, step_id, url_pattern, dom_structural_hash,
              model, prompt_template_version, browser_identity_version, plan_ref, status)
           VALUES (gen_random_uuid(), $1,$2,$3,$4,$5,$6,$7,$8, NULL, 'suspect')`,
          keyParams(key),
        );
      }
    });
  }
}
