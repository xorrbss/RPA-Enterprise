/**
 * Dev 런타임 루프 (D3 가동 1단계 — 증분3b, 테스트용). 상주 graphile 워커의 dev 대역.
 *
 * queued run을 주기 폴링 → claim(queued→claimed) → driveClaimedRun(실 UtilityExecutor + CdpPageStateResolver,
 * 실 Chrome)로 completed까지 구동한다. 단일 세션이라 한 번에 한 run만 처리.
 *
 * 한계(정직): PageStateResolver는 'd3-dryrun-v1' 마커가 있는 페이지에서만 flags를 산출한다. 따라서 dev에서
 * 실제로 completed까지 가는 건 **마커 픽스처(serve.ts 제공)를 가리키는 데모 시나리오** 뿐이다. 위저드가 만든
 * 실 URL 시나리오는 PAGE_STATE_UNRESOLVED로 실패하며(2단계 대기), 그 run은 실패 로그를 남기고 멈춘다.
 * Chrome이 없으면 루프는 비활성(run은 queued 유지). 프로덕션은 graphile 워커 데몬 + 브라우저 풀(후속).
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Pool } from "pg";

import { withTenantTx } from "../src/db/pool";
import { applyRunTransition } from "../src/runtime/run-transition";
import { driveClaimedRun } from "../src/runtime/run-step-driver";
import { createStagehandSession, SingleSessionProvider } from "../src/executor/cdp-session";
import { CdpPageStateResolver } from "../src/executor/page-state-resolver";
import { UtilityExecutor } from "../src/executor/utility-executor";

const WORKER_ID = "9a000000-0000-0000-0000-0000000000df";

export interface RunLoop {
  stop(): Promise<void>;
}

function findChrome(): string | null {
  const env = process.env.CHROME_PATH?.trim();
  if (env !== undefined && env.length > 0 && existsSync(env)) return env;
  return (
    [
      "C:/Program Files/Google/Chrome/Application/chrome.exe",
      "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
      "/usr/bin/google-chrome",
      "/usr/bin/chromium",
    ].find((c) => existsSync(c)) ?? null
  );
}

interface QueuedRun {
  id: string;
  scenario_version_id: string;
  correlation_id: string;
}

/**
 * queued run 폴링 루프 시작. Chrome 미발견 시 null(루프 비활성). tenantId 스코프(dev 단일 테넌트).
 */
export async function startRunLoop(pool: Pool, tenantId: string, intervalMs = 2000): Promise<RunLoop | null> {
  const chrome = findChrome();
  if (chrome === null) {
    console.log("run-loop: Chrome 미발견 → 실행 비활성(만든 run은 queued로 대기). CHROME_PATH 설정 시 활성화.");
    return null;
  }
  const downloadDir = mkdtempSync(join(tmpdir(), "dev-runloop-"));
  const session = await createStagehandSession({ chromeExecutablePath: chrome, downloadDir, headless: true });
  const provider = new SingleSessionProvider(session);
  const resolver = new CdpPageStateResolver(provider);
  const executor = new UtilityExecutor(provider);
  console.log("run-loop: 실 Chrome 실행기 활성 — queued run을 polling해 구동(마커 픽스처 데모 시나리오만 completed).");

  let stopped = false;
  let busy = false;

  const tick = async (): Promise<void> => {
    if (stopped || busy) return;
    busy = true;
    try {
      const next = await withTenantTx(pool, tenantId, async (c) => {
        const r = await c.query<QueuedRun>(
          `SELECT id::text AS id, scenario_version_id::text AS scenario_version_id, correlation_id::text AS correlation_id
             FROM runs WHERE status='queued' ORDER BY created_at LIMIT 1`,
        );
        return r.rows[0] ?? null;
      });
      if (next === null) return;

      // claim: queued → claimed (R1 대역).
      const claimed = await withTenantTx(pool, tenantId, (c) =>
        applyRunTransition(c, {
          tenantId,
          runId: next.id,
          fromStatus: "queued",
          event: { type: "worker.claimed" },
          guard: { leaseAcquired: true },
          correlationId: next.correlation_id,
          workerId: WORKER_ID,
          eventIdempotencyKey: `${next.id}:worker.claimed`,
        }),
      );
      if (!claimed.applied) {
        console.log(`run-loop: ${next.id.slice(0, 8)} claim 경합(${claimed.reason}) — 건너뜀`);
        return;
      }

      try {
        const result = await driveClaimedRun(
          {
            runId: next.id,
            tenantId,
            scenarioVersionId: next.scenario_version_id,
            correlationId: next.correlation_id,
            leaseId: "dev-lease",
            siteProfileId: "dev-site",
            browserIdentityId: "dev-bid",
            networkPolicyId: "dev-np",
          },
          { pool, executor, resolver, workerId: WORKER_ID },
        );
        console.log(`run-loop: ${next.id.slice(0, 8)} → ${result.state} (${result.outcome.visited.join("→")})`);
      } catch (e) {
        // 실패(예: 마커 없는 실 URL → PAGE_STATE_UNRESOLVED)는 표면화. run은 running에서 멈춤(실패 전이는 후속).
        console.error(`run-loop: ${next.id.slice(0, 8)} 구동 실패 — ${e instanceof Error ? e.message : String(e)}`);
      }
    } catch (e) {
      console.error("run-loop tick error:", e instanceof Error ? e.message : String(e));
    } finally {
      busy = false;
    }
  };

  const timer = setInterval(() => void tick(), intervalMs);
  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      try {
        await session.close();
      } catch {
        /* ignore */
      }
      rmSync(downloadDir, { recursive: true, force: true });
    },
  };
}
