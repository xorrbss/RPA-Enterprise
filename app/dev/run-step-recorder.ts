/**
 * Dev 전용 ExecutorPlugin 데코레이터 — executor.execute 전에 run_steps 행을 멱등 기록한다(프로덕션
 * PgExecutorStepOrchestrator.attemptStore.begin 의 dev 최소 대역).
 *
 * 왜 필요한가: 실 게이트웨이 sink(PgGatewayArtifactSink)가 artifacts.(tenant_id,run_id,step_id,attempt) 복합
 * FK(→run_steps)를 요구한다. dev 의 driveClaimedRun→interpreter(runScenario) 경로는 run_steps 를 만들지 않으므로,
 * 이 데코레이터 없이는 gateway 를 호출하는 첫 act/extract 스텝의 artifact INSERT 가 FK 위반으로 좌초한다(run 미완료).
 * ctx 가 tenant/run/node/attempt 를, stepId 가 step_id 를 제공 → 결정형 기록(gateway meta.stepId 와 동일 키). interpreter
 * 가 observe 를 executor 로 보내지 않으므로(ir-translate drop) 여기서 보는 action 은 navigate/act/extract 뿐이다.
 */
import { randomUUID } from "node:crypto";

import type { Pool } from "pg";

import type { ExecutorPlugin, RunContext, StepResult, VerifyResult } from "../../ts/core-types";
import { withTenantTx } from "../src/db/pool";

// run_steps.action CHECK(migration_core_entities §5) — 이 집합 외 type 은 기록하지 않는다(gateway 미호출=artifact 없음→FK 무관).
const STEP_ACTIONS: ReadonlySet<string> = new Set([
  "act",
  "observe",
  "extract",
  "navigate",
  "download",
  "upload",
  "api_call",
  "file",
  "human_task",
  "shell",
]);

export class RunStepRecordingExecutor implements ExecutorPlugin {
  constructor(
    private readonly inner: ExecutorPlugin,
    private readonly pool: Pool,
  ) {}

  capabilities(): { dom: boolean; vision: boolean; utility: boolean } {
    return this.inner.capabilities();
  }

  verify(criteria: unknown, ctx: RunContext): Promise<VerifyResult> {
    return this.inner.verify(criteria, ctx);
  }

  async execute(stepId: string, action: unknown, ctx: RunContext): Promise<StepResult> {
    await this.recordStep(stepId, action, ctx);
    return this.inner.execute(stepId, action, ctx);
  }

  /** run_steps 선행 기록(멱등). 같은 (tenant,run,step,attempt) 중복 INSERT 는 DO NOTHING(재시도/재진입 안전). */
  private async recordStep(stepId: string, action: unknown, ctx: RunContext): Promise<void> {
    const type =
      typeof action === "object" && action !== null && typeof (action as { type?: unknown }).type === "string"
        ? (action as { type: string }).type
        : undefined;
    if (type === undefined || !STEP_ACTIONS.has(type)) return; // 미지원 type 은 artifact 미생성 → FK 무관, 기록 생략.
    await withTenantTx(this.pool, ctx.tenantId, async (c) => {
      await c.query(
        `INSERT INTO run_steps (id, tenant_id, run_id, step_id, node_id, attempt, action, status, started_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::int, $7, 'started', now())
         ON CONFLICT (tenant_id, run_id, step_id, attempt) DO NOTHING`,
        [randomUUID(), ctx.tenantId, ctx.runId, stepId, ctx.nodeId, ctx.attempt, type],
      );
    });
  }
}
