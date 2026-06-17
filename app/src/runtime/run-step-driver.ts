/**
 * Run 실행 드라이버 (D3 가동 1단계 — 증분2: 인터프리터 ↔ DB 전이 연결).
 *
 * claimed 상태의 run을 받아: claimed→running(R2) → scenario_versions(ir+compiled_ast) 로드 →
 * 인터프리터(runScenario)로 그래프 순회 실행 → terminal 결과를 DB 전이로 종료(running→completing→completed).
 * 각 전이는 독립 CAS 트랜잭션(applyRunTransition: UPDATE WHERE status=<cur> + 동일 tx outbox). 인터프리터(브라우저
 * 작업)는 트랜잭션 밖에서 수행한다(긴 작업으로 커넥션 점유 금지).
 *
 * 범위: success/success_empty → completed(R7→R21), fail_business → failed_business(R9), fail_system → failed_system(R8),
 * suspend → suspended(R4→포트→resume-token 발행→R11, driveSuspend). 그 외 terminal 은 미구현 — 조용히 흘리지 않고
 * throw로 표면화한다("조용한 false/unknown 금지").
 */
import type { Pool } from "pg";

import type { ClassifiedException, ExecutorPlugin, PageState, PageStateRef, PageStateResolver, RedactedString, RunContext, SecretRef } from "../../../ts/core-types";
import type { IsoDateTime, ResumeTokenCodec, ResumeTokenEnvelope } from "../../../ts/runtime-contract";
import type { RunId } from "../../../ts/security-middleware-contract";
import type { RunEvent, RunGuard, RunState } from "../../../ts/state-machine-types";
import { withTenantTx } from "../db/pool";
import type { CdpSessionProvider } from "../executor/cdp-session";
import { clearCookies, getAllCookies, setCookies } from "../executor/raw-cdp";
import { applyRunTransition } from "./run-transition";
import { sessionKey, type BrowserSessionStore } from "./browser-session-store";
import type { ExecutorChallengeSuspensionPort } from "./executor-completion-coordinator";
import { compiledScenarioFrom } from "./ir-translate";
import { runScenario, type ScenarioOutcome, type SuspendContext } from "./ir-interpreter";

// ops-defaults.md resume_token.ttl=30m(expiresAt). 코드 상수 금지 규약 — inline 인용(RQ-017 패턴).
const RESUME_TOKEN_TTL_MS = 30 * 60 * 1000;

export interface ClaimedRun {
  readonly runId: string;
  readonly tenantId: string;
  readonly scenarioVersionId: string;
  readonly correlationId: string;
  readonly leaseId: string;
  readonly siteProfileId: string;
  readonly browserIdentityId: string;
  readonly networkPolicyId: string;
  /** runs.params(실행 파라미터). navigate.url_ref 가 이 params 의 키로 해소된다. */
  readonly params?: Record<string, unknown>;
  /**
   * 자격증명 에셋 키 → SecretRef(또는 비밀 아닌 에셋 문자열) 바인딩. 시나리오 meta.assets 에서 유도해 주입하며,
   * 실행기 fill(secretRef) 이 ctx.assetRefs[key] 를 SecretStore 경유로 해소한다. 비밀/에셋 구분은 이 주입 지점이 권위.
   */
  readonly assetRefs?: Record<string, SecretRef | string>;
}

export interface DriveDeps {
  readonly pool: Pool;
  readonly executor: ExecutorPlugin;
  readonly resolver: PageStateResolver;
  readonly workerId: string;
  // suspend 경로(트리거 i) 주입 — 미주입 시 suspend terminal 은 loud throw(미구성). 둘 다 있어야 구동.
  readonly suspensionPort?: ExecutorChallengeSuspensionPort;
  readonly resumeTokenCodec?: ResumeTokenCodec;
  // 세션 재사용(방식 A) — 둘 다 주입돼야 동작(optional, 미주입 callers 무영향). sessionProvider 는 live CdpSession 핸들
  //   (driver 가 executor 추상화 너머 두 번째 런타임 포트에 의존 — 작지만 실 결합 증가, run-lifecycle 소유자라 정당).
  readonly sessionStore?: BrowserSessionStore;
  readonly sessionProvider?: CdpSessionProvider;
}

export interface DriveResult {
  readonly state: RunState;
  readonly outcome: ScenarioOutcome;
}

function seedPageState(): PageState {
  return {
    url: { raw: "about:blank", canonical: "about:blank", pattern: "about:blank" },
    dom: { structuralHash: "seed", visibleTextHash: "seed", landmarks: [], frames: [] },
    auth: "anonymous",
    flags: {},
    matchedWhere: [],
  };
}

export async function driveClaimedRun(run: ClaimedRun, deps: DriveDeps): Promise<DriveResult> {
  // 1) claimed → running (R2, started_at).
  await transition(deps.pool, run, "claimed", { type: "run.started" }, { initOk: true }, deps.workerId);

  // 2) scenario_versions(ir + compiled_ast) 로드 (RLS 스코프).
  const sv = await withTenantTx(deps.pool, run.tenantId, async (c) => {
    const r = await c.query<{ ir: unknown; compiled_ast: unknown }>(
      `SELECT ir, compiled_ast FROM scenario_versions WHERE id=$1::uuid AND tenant_id=$2::uuid`,
      [run.scenarioVersionId, run.tenantId],
    );
    return r.rows[0] ?? null;
  });
  if (sv === null) {
    throw new Error(`driveClaimedRun: scenario_version '${run.scenarioVersionId}' not found (tenant ${run.tenantId})`);
  }
  // ir=jsonb(객체), compiled_ast=text(JSON 문자열) — 컬럼 타입에 맞춰 정규화.
  const irDoc = typeof sv.ir === "string" ? (JSON.parse(sv.ir) as unknown) : sv.ir;
  const compiledAst = typeof sv.compiled_ast === "string" ? (JSON.parse(sv.compiled_ast) as unknown) : sv.compiled_ast;
  // navigate.url_ref 는 run.params 의 키로 해소된다(URL_REF_* 실패는 InterpreterError 로 표면화).
  const scenario = compiledScenarioFrom(irDoc, compiledAst, run.params);

  // 3) 인터프리터로 그래프 순회 실행 (트랜잭션 밖).
  const ctx: RunContext = {
    runId: run.runId,
    tenantId: run.tenantId,
    nodeId: scenario.start,
    attempt: 0,
    siteProfileId: run.siteProfileId,
    browserIdentityId: run.browserIdentityId,
    networkPolicyId: run.networkPolicyId,
    leaseId: run.leaseId,
    assetRefs: run.assetRefs ?? {},
    abortSignal: new AbortController().signal,
    pageState: seedPageState(),
  };
  // 세션 재사용(방식 A) 복원 — navigate 이전 유일 seam(driver). 저장된 쿠키가 있으면 주입 → 인증 상태로 진입(login 서브플로
  //   스킵은 시나리오의 observe/on[] 게이트가 결정). store+provider 둘 다 주입 시에만. 복원 CDP 실패는 표면화(조용히
  //   '유효 세션 가정' 금지) — 반-복원 세션으로 진행하지 않는다.
  if (deps.sessionStore !== undefined && deps.sessionProvider !== undefined) {
    const sess = deps.sessionProvider.forLease(run.leaseId);
    // 잔여 쿠키 제거 → 세션 상태는 저장소가 권위(dev 단일세션 재사용·prod 풀 재할당의 cross-run/lease 잔류 차단).
    await clearCookies(sess);
    const bundle = await deps.sessionStore.load(sessionKey(run.tenantId, run.siteProfileId, run.browserIdentityId));
    if (bundle !== null && bundle.cookies.length > 0) {
      await setCookies(sess, bundle.cookies);
    }
  }

  // run.params 를 인터프리터 스코프에 주입(on[].when 의 params.* 참조). navigate url_ref 해소와 동일 출처.
  const outcome = await runScenario(scenario, ctx, { executor: deps.executor, resolver: deps.resolver, params: run.params });

  // 4) terminal 결과를 DB 전이로 종료.
  if (outcome.terminal === "success" || outcome.terminal === "success_empty") {
    await transition(deps.pool, run, "running", { type: "last_node_success" }, { flowTerminalReached: true });
    await transition(deps.pool, run, "completing", { type: "finalize_ok" }, { finalizeOk: true });
    // 세션 재사용 캡처 — 성공 종료 후 현재 쿠키 스냅샷 저장(다음 run 재사용). run 은 이미 completed 이므로 캡처 실패는
    //   best-effort-but-loud(조용히 흘리지 않되 완료된 run 을 실패로 만들지 않음 — 다음 run 이 재로그인).
    if (deps.sessionStore !== undefined && deps.sessionProvider !== undefined) {
      try {
        const cookies = await getAllCookies(deps.sessionProvider.forLease(run.leaseId));
        await deps.sessionStore.save(sessionKey(run.tenantId, run.siteProfileId, run.browserIdentityId), { cookies });
      } catch (e) {
        console.error(`run-step-driver: 세션 캡처 실패(run ${run.runId.slice(0, 8)}, 완료는 유지) — ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return { state: "completed", outcome };
  }
  // 실패 terminal: success(2-hop R7→R21)와 달리 단일 전이(running→failed_*). applyRunTransition 이 run.failed_* emit + ended_at 설정.
  if (outcome.terminal === "fail_business") {
    await transition(deps.pool, run, "running", { type: "business_exception" }, { exceptionClass: "business" });
    return { state: "failed_business", outcome };
  }
  if (outcome.terminal === "fail_system") {
    // R8 은 pending side-effect(captureFailureScreenshot·evaluateDeadLetter)도 반환하지만, 그 디스패치는 다운스트림
    // 디스패처(impl-contracts) 소유다 — driveClaimedRun 은 전이 적용만 하고 pending 을 직접 소비하지 않는다(success 경로와 동일).
    await transition(deps.pool, run, "running", { type: "unrecoverable_exception" }, { exceptionClass: "system" });
    return { state: "failed_system", outcome };
  }

  // suspend(트리거 i): running→suspending(R4) + human_task 포트 → resume-token 발행 + R11 → suspended.
  if (outcome.terminal === "suspend") {
    return driveSuspend(run, deps, outcome);
  }

  // 그 외 terminal(@challenge/@human_task IR 노드 등): 미구현 — 조용히 흘리지 않고 throw로 표면화(terminal 은 string).
  throw new Error(`driveClaimedRun: terminal '${outcome.terminal}' 종료 전이 미구현(success/success_empty/fail_business/fail_system/suspend 외). 후속 증분에서 추가.`);
}

/**
 * suspend 경로(A.1 step2+3). 인터프리터 suspend outcome → R4(running→suspending)+human_task 포트 → resume-token 발행+R11(→suspended).
 * R4+포트는 한 tx(R4 pending=[createHumanTask,startBookmark] 를 포트에 전달). 토큰 발행은 SecretStore.resolve(tx 밖, 네트워크).
 * 토큰 save+R11 은 한 tx(원자: 토큰 없이 suspended 금지). R11 pending(issueResumeToken/releaseLease)은 driver 미소비
 * (success/fail 경로와 동일 — lease 회수는 deferred lease lifecycle; 토큰은 R11 전에 이미 발행·저장).
 */
async function driveSuspend(run: ClaimedRun, deps: DriveDeps, outcome: ScenarioOutcome): Promise<DriveResult> {
  const s: SuspendContext | undefined = outcome.suspend;
  if (s === undefined) {
    throw new Error("driveSuspend: terminal 'suspend' 인데 suspend 컨텍스트 부재(인터프리터 불변 위반)");
  }
  const port = deps.suspensionPort;
  const codec = deps.resumeTokenCodec;
  if (port === undefined || codec === undefined) {
    throw new Error("driveSuspend: suspend 경로는 suspensionPort + resumeTokenCodec 주입 필요(미구성)");
  }

  // 1) R4(running→suspending) + 포트(human_task INSERT + human_task.created + bookmark) — 한 tenant tx.
  await withTenantTx(deps.pool, run.tenantId, async (client) => {
    const r4 = await applyRunTransition(client, {
      tenantId: run.tenantId,
      runId: run.runId,
      fromStatus: "running",
      event: { type: "step.challenge_detected", challengeKind: s.challengeKind },
      guard: {},
      correlationId: run.correlationId,
      eventIdempotencyKey: `${run.runId}:${s.stepId}:${s.attempt}:challenge-detected`,
    });
    if (!r4.applied) {
      throw new Error(`driveSuspend: R4 not applied (${r4.reason}, observed=${r4.observed ?? "none"})`);
    }
    // exception 은 포트가 미사용(vestigial 필수 파라미터) — 있으면 전달, 없으면 challenge 기본.
    const exception: ClassifiedException =
      s.exception ?? { class: "challenge", code: "CHALLENGE_UNRESOLVED", message: "challenge suspend" as RedactedString };
    await port.suspendForChallenge(client, {
      tenantId: run.tenantId,
      runId: run.runId,
      stepId: s.stepId,
      attempt: s.attempt,
      correlationId: run.correlationId,
      exception,
      pendingSideEffects: r4.pending,
    });
  });

  // 2) resume-token 발행(SecretStore.resolve — tx 밖). canonical bytes 로 로컬 HMAC 서명.
  const now = Date.now();
  const token: ResumeTokenEnvelope = await codec.issue({
    runId: run.runId as RunId,
    resumeNodeId: s.resumeNodeId,
    pageStateRef: s.pageStateRef as PageStateRef,
    issuedAt: new Date(now).toISOString() as IsoDateTime,
    expiresAt: new Date(now + RESUME_TOKEN_TTL_MS).toISOString() as IsoDateTime,
  });

  // 3) 토큰 save + R11(suspending→suspended) — 한 tx(원자). guard.resumeTokenIssued=true 는 실제 발행 후에만(stranding 금지).
  await withTenantTx(deps.pool, run.tenantId, async (client) => {
    const saved = await client.query(
      `UPDATE runs SET resume_token = $3::jsonb, updated_at = now()
        WHERE tenant_id = $1::uuid AND id = $2::uuid AND status = 'suspending'`,
      [run.tenantId, run.runId, JSON.stringify(token)],
    );
    if (saved.rowCount !== 1) {
      throw new Error(`driveSuspend: resume_token save affected ${saved.rowCount ?? 0} rows (run not in suspending)`);
    }
    const r11 = await applyRunTransition(client, {
      tenantId: run.tenantId,
      runId: run.runId,
      fromStatus: "suspending",
      event: { type: "bookmark_saved" },
      guard: { resumeTokenIssued: true },
      correlationId: run.correlationId,
      eventIdempotencyKey: `${run.runId}:bookmark_saved`,
    });
    if (!r11.applied) {
      throw new Error(`driveSuspend: R11 not applied (${r11.reason}, observed=${r11.observed ?? "none"})`);
    }
  });

  return { state: "suspended", outcome };
}

// 단일 전이를 자체 CAS 트랜잭션으로 적용. eventIdempotencyKey는 이벤트별 접미(outbox UNIQUE 충돌 방지).
async function transition(
  pool: Pool,
  run: ClaimedRun,
  fromStatus: RunState,
  event: RunEvent,
  guard: RunGuard,
  workerId?: string,
): Promise<void> {
  const outcome = await withTenantTx(pool, run.tenantId, (c) =>
    applyRunTransition(c, {
      tenantId: run.tenantId,
      runId: run.runId,
      fromStatus,
      event,
      guard,
      correlationId: run.correlationId,
      workerId,
      eventIdempotencyKey: `${run.runId}:${event.type}`,
    }),
  );
  if (!outcome.applied) {
    throw new Error(`driveClaimedRun: transition '${event.type}' from '${fromStatus}' not applied (${outcome.reason}, observed=${outcome.observed ?? "none"})`);
  }
}
