/**
 * Dev 런타임 루프 (D3 가동 1단계 — 증분3b, 테스트용). 상주 graphile 워커의 dev 대역.
 *
 * queued run을 주기 폴링 → claim(queued→claimed) → **run별 site_profile 해소** → driveClaimedRun(실 UtilityExecutor +
 * SitePageStateResolver, 실 Chrome)로 completed까지 구동한다. 단일 세션이라 한 번에 한 run만 처리.
 *
 * 멀티사이트: run의 시나리오 entry navigate URL의 origin을 site_profiles.url_pattern에 매칭해(resolveSiteProfileId)
 * 그 사이트의 page_state_selectors를 로드, run별 resolver를 구성한다. 서로 다른 사이트를 가리키는 시나리오가 각자
 * 맞는 셀렉터로 구동된다. 해소 불가(0-match/ambiguous)·symbolic url_ref·셀렉터 미설정은 loud 로그 후 건너뜀(은폐 금지).
 * Chrome이 없으면 루프는 비활성(run은 queued 유지). 프로덕션은 graphile 워커 데몬 + 브라우저 풀(후속).
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Pool } from "pg";

import { withTenantTx } from "../src/db/pool";
import { applyRunTransition } from "../src/runtime/run-transition";
import { driveClaimedRun } from "../src/runtime/run-step-driver";
import { extractEntryNavigateUrlRef, resolveSiteProfileId } from "../src/runtime/site-resolution";
import { createStagehandSession, SingleSessionProvider } from "../src/executor/cdp-session";
import { SitePageStateResolver } from "../src/executor/site-page-state-resolver";
import { loadSitePageStateConfig } from "../src/executor/site-page-state-config";
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
  ir: unknown;
}

/**
 * queued run 폴링 루프 시작. Chrome 미발견 시 null(루프 비활성). tenantId 스코프(dev 단일 테넌트).
 * run별로 시나리오 entry URL→site_profile을 해소하고 그 사이트의 page_state_selectors로 resolver를 구성한다.
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
  const executor = new UtilityExecutor(provider);
  console.log("run-loop: 실 Chrome 실행기 활성 — queued run을 polling해 구동(run별 site_profile 해소 → DB 셀렉터로 completed).");

  let stopped = false;
  let busy = false;

  const tick = async (): Promise<void> => {
    if (stopped || busy) return;
    busy = true;
    try {
      const next = await withTenantTx(pool, tenantId, async (c) => {
        const r = await c.query<QueuedRun>(
          `SELECT r.id::text AS id, r.scenario_version_id::text AS scenario_version_id,
                  r.correlation_id::text AS correlation_id, sv.ir AS ir
             FROM runs r JOIN scenario_versions sv ON sv.id = r.scenario_version_id
            WHERE r.status='queued' ORDER BY r.created_at LIMIT 1`,
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
        // run별 site_profile 해소 → 그 사이트의 page_state_selectors로 resolver 구성.
        const resolved = await withTenantTx(pool, tenantId, async (c) => {
          const entryUrlRef = extractEntryNavigateUrlRef(next.ir);
          const siteProfileId = await resolveSiteProfileId(c, { tenantId, entryUrlRef });
          const config = await loadSitePageStateConfig(c, tenantId, siteProfileId);
          return { siteProfileId, config };
        });
        const resolver = new SitePageStateResolver(provider, resolved.config);

        const result = await driveClaimedRun(
          {
            runId: next.id,
            tenantId,
            scenarioVersionId: next.scenario_version_id,
            correlationId: next.correlation_id,
            leaseId: "dev-lease",
            siteProfileId: resolved.siteProfileId,
            browserIdentityId: "dev-bid",
            networkPolicyId: "dev-np",
          },
          { pool, executor, resolver, workerId: WORKER_ID },
        );
        console.log(`run-loop: ${next.id.slice(0, 8)} → ${result.state} (site ${resolved.siteProfileId.slice(0, 8)}, ${result.outcome.visited.join("→")})`);
      } catch (e) {
        // 해소 실패(symbolic url_ref·0-match·ambiguous·셀렉터 미설정) 또는 구동 실패는 표면화(은폐 금지). run은 claimed에서 멈춤.
        console.error(`run-loop: ${next.id.slice(0, 8)} 해소/구동 실패 — ${e instanceof Error ? e.message : String(e)}`);
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
