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

// gateway 아티팩트를 실제로 생성해 복합 FK 부모가 되는 도달 가능 type 만 기록한다(LLM 프리미티브 act/extract).
//   navigate/observe 등 비-artifact type 은 FK 무관이라 기록 생략(불필요 행·오해성 트레이스 방지). observe 는 ir-translate
//   가 drop 해 실행기 미도달, 그 외 type(download/shell 등)은 ir-translate 가 ACTION_UNSUPPORTED 로 차단해 도달 불가.
const STEP_ACTIONS: ReadonlySet<string> = new Set(["act", "extract"]);

// StepResult.status → run_steps.status(migration §5 CHECK). 둘 다 동일 enum(started 제외)이라 통과 값만 허용.
const STEP_STATUSES: ReadonlySet<string> = new Set([
  "success",
  "failed_business",
  "failed_system",
  "failed_challenge",
  "failed_security",
  "uncertain",
  "skipped",
  "suspended",
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
    await this.recordStep(stepId, action, ctx); // gateway sink 의 artifact FK 가 참조할 행을 선기록('started').
    const startMs = Date.now();
    try {
      const result = await this.inner.execute(stepId, action, ctx);
      await this.finalizeStep(stepId, ctx, result.status, result.timings.durationMs); // 반환 경로 종결.
      return result;
    } catch (e) {
      // throw 경로(valueRef 미해소·CDP 적용 실패·RUN_ABORTED 등 — GatewayError 만 StepResult 로 환원, 나머진 전파)도
      //   종결한다. 안 그러면 행이 영구 'started' 로 잔류(F5 의 return-only 보강 누락, review 후속). 보수적 failed_system
      //   으로 종결 후 원 예외 재throw(전파 의미 보존). 상위(interpreter→driver→run-loop)는 throw 를 그대로 흘린다.
      await this.finalizeStep(stepId, ctx, "failed_system", Date.now() - startMs);
      throw e;
    }
  }

  /** run_steps 선행 기록(멱등). 같은 (tenant,run,step,attempt) 중복 INSERT 는 DO NOTHING(재시도/재진입 안전). */
  private async recordStep(stepId: string, action: unknown, ctx: RunContext): Promise<void> {
    const type =
      typeof action === "object" && action !== null && typeof (action as { type?: unknown }).type === "string"
        ? (action as { type: string }).type
        : undefined;
    if (type === undefined || !STEP_ACTIONS.has(type)) return; // 비-artifact type 은 FK 무관, 기록 생략.
    await withTenantTx(this.pool, ctx.tenantId, async (c) => {
      await c.query(
        `INSERT INTO run_steps (id, tenant_id, run_id, step_id, node_id, attempt, action, status, started_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::int, $7, 'started', now())
         ON CONFLICT (tenant_id, run_id, step_id, attempt) DO NOTHING`,
        [randomUUID(), ctx.tenantId, ctx.runId, stepId, ctx.nodeId, ctx.attempt, type],
      );
    });
  }

  /** 'started' 행을 종결 상태/소요로 갱신(멱등: status='started' 가드). 반환·throw 양쪽에서 호출. 미기록 스텝(비-artifact)은 0행 영향. */
  private async finalizeStep(stepId: string, ctx: RunContext, status: string, durationMs: number): Promise<void> {
    if (!STEP_STATUSES.has(status)) return; // 미지원 상태값은 갱신 안 함(CHECK 위반 회피 — 조용히 'started' 유지보다 안전).
    await withTenantTx(this.pool, ctx.tenantId, async (c) => {
      await c.query(
        `UPDATE run_steps
            SET status = $5, ended_at = now(), duration_ms = $6::int
          WHERE tenant_id = $1::uuid AND run_id = $2::uuid AND step_id = $3 AND attempt = $4::int AND status = 'started'`,
        [ctx.tenantId, ctx.runId, stepId, ctx.attempt, status, durationMs],
      );
    });
  }
}
