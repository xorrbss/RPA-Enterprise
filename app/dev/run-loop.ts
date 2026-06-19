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

import type { ArtifactRef, ExecutorPlugin, SecretRef } from "../../ts/core-types";
import type { AuthenticatedPrincipal, PrincipalId, TenantId } from "../../ts/security-middleware-contract";
import type { RunState } from "../../ts/state-machine-types";
import { withTenantTx } from "../src/db/pool";
import { applyRunTransition } from "../src/runtime/run-transition";
import { driveClaimedRun } from "../src/runtime/run-step-driver";
import { extractEntryNavigateUrlRef, resolveSiteProfileId, resolveUrlRef } from "../src/runtime/site-resolution";
import { createStagehandSession, SingleSessionProvider } from "../src/executor/cdp-session";
import { SitePageStateResolver } from "../src/executor/site-page-state-resolver";
import { loadSitePageStateConfig } from "../src/executor/site-page-state-config";
import { UtilityExecutor } from "../src/executor/utility-executor";
import { StagehandDomExecutor, type LlmGatewayCaller } from "../src/executor/stagehand-dom-executor";
import { CompositeExecutor } from "../src/runtime/composite-executor";
import { GatewayError, LlmGateway } from "../src/gateway/llm-gateway";
import type { GatewayArtifactSink } from "../src/gateway/llm-gateway";
import { CodexSseAdapter } from "../src/gateway/codex-sse-adapter";
import { FetchCodexSseTransport } from "../src/gateway/codex-sse-transport";
import { SafeCapabilityGate } from "../src/gateway/capability-gate";
import { DeterministicGatewayRedactionBoundary } from "../../gateway/redaction-boundary";
import { VaultSecretStoreBoundary } from "../src/secrets/vault-secret-store-boundary";
import { ContractDurableSecurityAuditWriter, FakeSecretStore, InMemoryImmutableAuditLog } from "../../security/compliance-scaffold";
import { DevPlaintextSessionEncryptor, PgBrowserSessionStore } from "../src/runtime/browser-session-store";

const WORKER_ID = "9a000000-0000-0000-0000-0000000000df";
// dev 브라우저 정체성(실 UUID) — browser_sessions PK/FK 가 uuid + browser_identities 행을 요구하므로 serve.ts 가
// 이 id 로 browser_identities 를 시드한다(세션 재사용 키의 browser_identity_id). leaseId/networkPolicyId 는 DB 미조회라 리터럴 유지.
export const DEV_BROWSER_IDENTITY_ID = "9b000000-0000-0000-0000-0000000000b1";

// dom 실행기 cfg(run-loop 전역 — 캐시 미주입(bypass)이라 scenarioVersionId 는 cacheKey 전용으로 미사용; 정적 placeholder).
const DOM_CFG = {
  model: process.env.CODEX_MODEL?.trim() || "gpt-4o-mini",
  promptTemplateVersion: "dev@1",
  budget: { maxInputTokens: 100_000, maxOutputTokens: 4096, maxCost: 1 },
  scenarioVersionId: "dev-runloop",
  browserIdentityVersion: 1,
};

/**
 * 실 Codex 게이트웨이 조립(CODEX_* env 필수). 미설정 시 null → dom 실행기 비활성(navigate/observe 만).
 * validator 는 POC pass-through(실 ajv schemaRef 레지스트리는 후속 갭). redaction 경계가 user 메시지(DOM 포함)를 redact.
 */
function buildCodexGateway(artifactSink?: GatewayArtifactSink): LlmGatewayCaller | null {
  const apiKey = process.env.CODEX_API_KEY?.trim();
  const baseUrl = process.env.CODEX_BASE_URL?.trim();
  const model = process.env.CODEX_MODEL?.trim();
  if (!apiKey || !baseUrl || !model) return null;
  // 네이티브 JSON 모드(jsonMode + response_format) — provider 가 유효-JSON 강제(D5 PoC #3 가용 확정). 없으면
  // gpt-4o-mini 가 prompt 폴백에서 마크다운 펜스/산문을 섞어 Gateway JSON.parse 가 LLM_MALFORMED_OUTPUT 로 실패.
  const transport = new FetchCodexSseTransport({ baseUrl, apiKey, model, nativeStructuredOutput: true });
  const adapter = new CodexSseAdapter(transport, {
    model,
    maxContextTokens: 8192,
    idleTimeoutMs: 20_000,
    wallTimeoutMs: 120_000,
    pricePer1kInputUsd: 0,
    pricePer1kOutputUsd: 0,
    capabilities: { jsonMode: true }, // nativeStructuredOutput 과 짝(capabilities 일치).
  });
  return new LlmGateway({
    primary: adapter,
    gate: new SafeCapabilityGate(),
    validator: { validate: () => ({ ok: true }) },
    sink: {
      // dev 가시화: 게이트웨이가 sink.put(응답텍스트, meta) 로 LLM 출력(extract 결과 AND act 액션플랜 둘 다)을 넘긴다.
      // dev sink는 즉시 조회를 위해 run-level artifact로 저장하고, StepRecordingExecutor가 반환된 UUID ref를 run_steps에 보존한다.
      put: async (text: string, meta) => {
        console.log(`[GW-OUTPUT ${meta.stepId}]`, typeof text === "string" ? text.slice(0, 4000) : JSON.stringify(text).slice(0, 4000));
        return artifactSink !== undefined ? artifactSink.put(text, meta) : "art://dev-gateway" as ArtifactRef;
      },
    },
    redactionBoundary: new DeterministicGatewayRedactionBoundary(),
    config: { retryMax: 2, fallbackAttempts: 0, repairAttempts: 1 },
  });
}

/**
 * dev SecretStore 경계 — FakeSecretStore(env 시드, 비프로덕션) + 감사. 에셋 키 = SecretRef(POC identity 매핑;
 * vault 경로 분리는 네임스페이스 SSoT 후속). 로컬 픽스처는 자격증명을 검증 안 하므로 기본값으로 충분.
 */
function buildDevSecretBoundary(): VaultSecretStoreBoundary {
  const seed: Record<string, string> = {
    "login.username": process.env.HIWORKS_USER?.trim() || "demo-user",
    "login.password": process.env.HIWORKS_PASS?.trim() || "demo-pass",
  };
  return new VaultSecretStoreBoundary({
    store: new FakeSecretStore(seed),
    audit: new ContractDurableSecurityAuditWriter(new InMemoryImmutableAuditLog()),
  });
}

/**
 * dev 세션 스토어 — browser_sessions 영속(방식 A). dev-plaintext 암호화기 + 명시 allowDevPlaintext(prod 차단; 실 KMS
 * 미구현 TODO:[BLOCKED]). 복원/캡처는 driveClaimedRun 북엔드가 sessionProvider 의 live CdpSession 으로 수행.
 */
function buildDevSessionStore(pool: Pool): PgBrowserSessionStore {
  return new PgBrowserSessionStore({ pool, encryptor: new DevPlaintextSessionEncryptor() }, { allowDevPlaintext: true });
}

/** 시나리오 IR(meta) assets[] → assetRefs(에셋 키 → SecretRef). POC identity 매핑(키=ref). */
function deriveAssetRefs(ir: unknown): Record<string, SecretRef> {
  const doc = typeof ir === "string" ? (JSON.parse(ir) as unknown) : ir;
  const assets = (doc as { assets?: unknown } | null)?.assets;
  const refs: Record<string, SecretRef> = {};
  if (Array.isArray(assets)) {
    for (const k of assets) if (typeof k === "string" && k.length > 0) refs[k] = k as SecretRef;
  }
  return refs;
}

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
  params: unknown;
}

// runs.params(jsonb) 정규화: 문자열이면 파싱, null/부재면 undefined(빈 {} 와 구분 — navigate 키 해소가 loud 실패).
function normalizeParams(raw: unknown): Record<string, unknown> | undefined {
  const v = typeof raw === "string" ? (JSON.parse(raw) as unknown) : raw;
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

/**
 * queued run 폴링 루프 시작. Chrome 미발견 시 null(루프 비활성). tenantId 스코프(dev 단일 테넌트).
 * run별로 시나리오 entry URL→site_profile을 해소하고 그 사이트의 page_state_selectors로 resolver를 구성한다.
 */
export async function startRunLoop(
  pool: Pool,
  tenantId: string,
  intervalMs = 2000,
  artifactSink?: GatewayArtifactSink,
  // extract.rowAnchor 로 결정형 강화한 행을 인박스용 typed artifact(approval_inbox)로 영속하는 sink(dom 실행기에 주입).
  extractArtifactSink?: GatewayArtifactSink,
): Promise<RunLoop | null> {
  const chrome = findChrome();
  if (chrome === null) {
    console.log("run-loop: Chrome 미발견 → 실행 비활성(만든 run은 queued로 대기). CHROME_PATH 설정 시 활성화.");
    return null;
  }
  const downloadDir = mkdtempSync(join(tmpdir(), "dev-runloop-"));
  const session = await createStagehandSession({ chromeExecutablePath: chrome, downloadDir, headless: true });
  const provider = new SingleSessionProvider(session);
  const utility = new UtilityExecutor(provider);
  const gateway = buildCodexGateway(artifactSink);
  const loggedGateway: LlmGatewayCaller | null =
    gateway === null
      ? null
      : {
          call: async (req, signal) => {
            try {
              return await gateway.call(req, signal);
            } catch (e) {
              if (e instanceof GatewayError) {
                console.error(`[GW-ERROR ${req.metadata.stepId}] ${e.code}: ${e.message}`);
              } else {
                console.error(`[GW-ERROR ${req.metadata.stepId}] ${e instanceof Error ? e.message : String(e)}`);
              }
              throw e;
            }
          },
        };
  const secrets = buildDevSecretBoundary();
  const executorPrincipal: AuthenticatedPrincipal = {
    subjectId: WORKER_ID as PrincipalId,
    tenantId: tenantId as TenantId,
    roles: ["admin"],
    source: "jwt",
    claims: { runtime_identity: "runtime-worker" }, // RESOLVE_MATRIX: runtime-worker → purpose 'executor'
  };
  // gateway 있으면 dom(act/observe/extract) + utility 합성. 없으면 utility 만(act/extract 시나리오는 실패).
  const executor: ExecutorPlugin =
    loggedGateway !== null
      ? new CompositeExecutor(new StagehandDomExecutor(loggedGateway, provider, DOM_CFG, undefined, secrets, executorPrincipal, extractArtifactSink), utility)
      : utility;
  // 세션 재사용(방식 A) — dev 세션 스토어(browser_sessions, dev-plaintext 암호화기). 복원/캡처는 driver 북엔드가 수행.
  const sessionStore = buildDevSessionStore(pool);
  console.log(
    loggedGateway !== null
      ? "run-loop: 실 Chrome + Codex dom 실행기 활성(act/observe/extract→LLM; 자격증명 fill→SecretStore 주입; 세션 재사용 활성)."
      : "run-loop: 실 Chrome utility 실행기만 활성(CODEX_* 미설정 → act/extract 시나리오 불가, navigate/observe 만).",
  );

  let stopped = false;
  let busy = false;

  const tick = async (): Promise<void> => {
    if (stopped || busy) return;
    busy = true;
    try {
      const next = await withTenantTx(pool, tenantId, async (c) => {
        const r = await c.query<QueuedRun>(
          `SELECT r.id::text AS id, r.scenario_version_id::text AS scenario_version_id,
                  r.correlation_id::text AS correlation_id, sv.ir AS ir, r.params AS params
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
        // url_ref(키) → params 의 절대 URL 해소 → 그 origin 으로 site_profile 해소 → page_state_selectors 로 resolver.
        const params = normalizeParams(next.params);
        const resolved = await withTenantTx(pool, tenantId, async (c) => {
          const entryUrl = resolveUrlRef(extractEntryNavigateUrlRef(next.ir), params);
          const siteProfileId = await resolveSiteProfileId(c, { tenantId, entryUrlRef: entryUrl });
          const config = await loadSitePageStateConfig(c, tenantId, siteProfileId);
          // 사이트별 browser_identity 해소 — 세션 캡처(capture API)와 동일 키 정합(없으면 dev 기본 bid 폴백).
          const bid = await c.query<{ id: string }>(
            `SELECT id::text AS id FROM browser_identities WHERE tenant_id=$1::uuid AND site_profile_id=$2::uuid ORDER BY version DESC LIMIT 1`,
            [tenantId, siteProfileId],
          );
          return { siteProfileId, config, browserIdentityId: bid.rows[0]?.id ?? DEV_BROWSER_IDENTITY_ID };
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
            browserIdentityId: resolved.browserIdentityId,
            networkPolicyId: "dev-np",
            params,
            assetRefs: deriveAssetRefs(next.ir), // meta.assets → 자격증명 fill 의 SecretRef 바인딩
          },
          {
            pool,
            executor,
            resolver,
            workerId: WORKER_ID,
            sessionProvider: provider,
            sessionStore,
            recordExecutorSteps: true,
          },
        );
        console.log(`run-loop: ${next.id.slice(0, 8)} → ${result.state} (site ${resolved.siteProfileId.slice(0, 8)}, ${result.outcome.visited.join("→")})`);
      } catch (e) {
        // 해소 실패(url_ref params 누락·0-match·ambiguous·셀렉터 미설정) 또는 구동 실패는 표면화(은폐 금지). run은 claimed에서 멈춤.
        const message = e instanceof Error ? e.message : String(e);
        console.error(`run-loop: ${next.id.slice(0, 8)} 해소/구동 실패 — ${message}`);
        await markRunFailedSystem(pool, tenantId, next.id, next.correlation_id, message);
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

async function markRunFailedSystem(
  pool: Pool,
  tenantId: string,
  runId: string,
  correlationId: string,
  message: string,
): Promise<void> {
  const reason = { code: "RUN_LOOP_FAILED", message };
  await withTenantTx(pool, tenantId, async (c) => {
    const statusRow = await c.query<{ status: RunState }>(
      `SELECT status FROM runs WHERE tenant_id=$1::uuid AND id=$2::uuid`,
      [tenantId, runId],
    );
    const status = statusRow.rows[0]?.status;
    if (status === undefined || isTerminal(status)) return;

    const transitionInput = failedTransitionFor(status);
    if (transitionInput === null) {
      await c.query(
        `UPDATE runs
            SET failure_reason=$3::jsonb, updated_at=now()
          WHERE tenant_id=$1::uuid AND id=$2::uuid AND status=$4`,
        [tenantId, runId, JSON.stringify(reason), status],
      );
      return;
    }

    const transitioned = await applyRunTransition(c, {
      tenantId,
      runId,
      fromStatus: status,
      event: transitionInput.event,
      guard: transitionInput.guard,
      correlationId,
      eventIdempotencyKey: `${runId}:run-loop-failed`,
    });
    if (!transitioned.applied) return;
    await c.query(
      `UPDATE runs
          SET failure_reason=$3::jsonb, updated_at=now()
        WHERE tenant_id=$1::uuid AND id=$2::uuid`,
      [tenantId, runId, JSON.stringify(reason)],
    );
  });
}

function isTerminal(status: RunState): boolean {
  return status === "completed" || status === "cancelled" || status === "failed_business" || status === "failed_system";
}

function failedTransitionFor(status: RunState):
  | { event: { type: "init_failed" }; guard: { initFailBelowThreshold: false } }
  | { event: { type: "unrecoverable_exception" }; guard: { exceptionClass: "system" } }
  | { event: { type: "bookmark_failed" }; guard: Record<string, never> }
  | { event: { type: "restore_failed" }; guard: { loginBypassPossible: false } }
  | { event: { type: "finalize_failed" }; guard: Record<string, never> }
  | null {
  if (status === "claimed") return { event: { type: "init_failed" }, guard: { initFailBelowThreshold: false } };
  if (status === "running") return { event: { type: "unrecoverable_exception" }, guard: { exceptionClass: "system" } };
  if (status === "suspending") return { event: { type: "bookmark_failed" }, guard: {} };
  if (status === "resuming") return { event: { type: "restore_failed" }, guard: { loginBypassPossible: false } };
  if (status === "completing") return { event: { type: "finalize_failed" }, guard: {} };
  return null;
}
