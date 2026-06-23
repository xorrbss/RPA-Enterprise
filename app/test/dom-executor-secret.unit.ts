/**
 * 단위 테스트 — StagehandDomExecutor 자격증명 fill 의 시크릿-주입 경계(누출-제로 증명).
 *
 * 적대 리뷰가 못 박은 주통제를 단언한다(assertNoPlainSecret 값-동등 백스톱이 아니라 "평문이 애초에 output 에 안 들어감"):
 *  - act(secretRef) → LLM 은 selector 만 책임. 실행기가 ctx.assetRefs[key](SecretRef)를 SecretStoreBoundary(purpose:'executor')
 *    경유로 해소해 **CDP fill 에만** 평문을 흘린다(LLM·캐시·output 에 평문 미운반).
 *  - 직렬화된 StepResult/plan 에 평문 부재 — JSON.stringify 와 safeSerialize(taint 경계) 둘 다 통과/미포함.
 *  - 감사로그에 secret.resolve(allow) 1건, payload={ref,purpose:'executor'} 이며 시크릿 값 미포함.
 *  - 가드(loud): 경계/principal 미주입 또는 에셋 키 미바인딩 → IR_SCHEMA_INVALID throw(조용한 빈 fill 금지).
 *
 * FakeSecretStore 는 compliance-scaffold 의 실제 구현(markPlainSecretFromStore 로 taint 등록)을 써서 safeSerialize 가
 * 누설을 실제로 잡도록 한다. 실행: tsx test/dom-executor-secret.unit.ts
 */
import type { ArtifactRef, PageState, RunContext, SecretRef } from "../../ts/core-types";
import {
  type AuthenticatedPrincipal,
  type LLMResponse,
  type PrincipalId,
  type TenantId,
} from "../../ts/security-middleware-contract";
import {
  ContractDurableSecurityAuditWriter,
  FakeSecretStore,
  InMemoryImmutableAuditLog,
  safeSerialize,
} from "../../security/compliance-scaffold";
import { VaultSecretStoreBoundary } from "../src/secrets/vault-secret-store-boundary";
import type { CdpSession, CdpSessionProvider } from "../src/executor/cdp-session";
import {
  StagehandDomExecutor,
  StagehandDomExecutorError,
  type LlmGatewayCaller,
} from "../src/executor/stagehand-dom-executor";

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const SECRET = "S3cr3t-DO-NOT-LOG-9f2a";
const VAULT_REF = "rpa/dev/runtime-worker/executor/hiworks-password";
const ASSET_KEY = "login.password";
const TENANT = "00000000-0000-0000-0000-0000000000d1" as TenantId;

const PRINCIPAL: AuthenticatedPrincipal = {
  subjectId: "exec-svc" as PrincipalId,
  tenantId: TENANT,
  roles: ["admin"],
  source: "jwt",
  claims: { runtime_identity: "runtime-worker" }, // RESOLVE_MATRIX: runtime-worker → purpose 'executor' 허용
};

const cfg = {
  model: "gpt-4o-mini",
  promptTemplateVersion: "v1",
  budget: { maxInputTokens: 10000, maxOutputTokens: 256, maxCost: 0.5 },
  scenarioVersionId: "sv-1",
  browserIdentityVersion: 1,
};

function makeCtx(over: Partial<RunContext> = {}): RunContext {
  const ps: PageState = {
    url: { raw: "https://hw/login", canonical: "https://hw/login", pattern: "https://hw/login" },
    dom: { structuralHash: "h1", visibleTextHash: "h2", landmarks: [], frames: [] },
    auth: "anonymous",
    flags: {},
    matchedWhere: [],
  };
  return {
    runId: "run-1",
    tenantId: TENANT,
    nodeId: "n-login-pw",
    attempt: 0,
    siteProfileId: "site-1",
    browserIdentityId: "bid-1",
    networkPolicyId: "np-1",
    leaseId: "lease-1",
    assetRefs: { [ASSET_KEY]: VAULT_REF as SecretRef },
    abortSignal: new AbortController().signal,
    pageState: ps,
    ...over,
  };
}

/** LLM 은 selector 만 반환(value 없음) — 실행기가 secretRef→valueRef 로 결정형 고정. */
const planGateway: LlmGatewayCaller = {
  call: async () =>
    ({
      outputRef: "art://o" as ArtifactRef,
      usage: { inputTokens: 1, outputTokens: 1, cost: 0 },
      finishReason: "stop",
      parsedJson: { operation: "fill", selector: "#password" },
    }) as unknown as LLMResponse,
};

function fakeSessions() {
  const ops: Array<{ op: string; selector: string; value?: string }> = [];
  const session: CdpSession = {
    url: () => "u",
    goto: async () => {},
    reload: async () => {},
    evaluate: async (expr: string) => {
      ops.push({ op: "evaluate", selector: expr }); // AUD-4: data-rpa-sensitive 표식 평가식 캡처
      return undefined as never;
    },
    sendCDP: async () => undefined as never,
    click: async (s) => void ops.push({ op: "click", selector: s }),
    fill: async (s, v) => void ops.push({ op: "fill", selector: s, value: v }),
    selectOption: async (s, v) => void ops.push({ op: "select", selector: s, value: v }),
    setInputFiles: async () => {},
    downloadDir: () => "/tmp",
    waitForDownload: async () => true,
    close: async () => {},
  };
  return { provider: { forLease: () => session } as CdpSessionProvider, ops };
}

function boundaryWithLog() {
  const log = new InMemoryImmutableAuditLog();
  const boundary = new VaultSecretStoreBoundary({
    store: new FakeSecretStore({ [VAULT_REF]: SECRET }),
    audit: new ContractDurableSecurityAuditWriter(log),
  });
  return { boundary, log };
}

async function caught(p: Promise<unknown>): Promise<StagehandDomExecutorError | undefined> {
  try {
    await p;
    return undefined;
  } catch (e) {
    return e instanceof StagehandDomExecutorError ? e : undefined;
  }
}

async function main(): Promise<void> {
  // ── 성공 경로: 평문이 CDP fill 에만 흐르고 output/감사 어디에도 안 실린다 ──
  {
    const s = fakeSessions();
    const { boundary, log } = boundaryWithLog();
    const ex = new StagehandDomExecutor(planGateway, s.provider, cfg, undefined, boundary, PRINCIPAL);
    const result = await ex.execute(
      "n-login-pw",
      { type: "act", instruction: "비밀번호 입력칸에 비밀번호를 입력", secretRef: ASSET_KEY, sideEffect: "login" },
      makeCtx(),
    );

    const fill = s.ops.find((o) => o.op === "fill");
    check("fill 이 CDP 로 적용됨(#password)", fill?.selector === "#password");
    check("CDP fill 에 평문이 정확히 전달됨", fill?.value === SECRET);
    check("StepResult.status=success", result.status === "success");
    // AUD-4 누출 차단: 자격증명 fill 대상 필드를 data-rpa-sensitive 로 표식(캡처-마스크가 type 무관 마스킹)·fill 직전.
    const markIdx = s.ops.findIndex((o) => o.op === "evaluate" && o.selector.includes("data-rpa-sensitive") && o.selector.includes("#password"));
    const fillIdx = s.ops.findIndex((o) => o.op === "fill");
    check("자격증명 fill 대상 필드를 data-rpa-sensitive 로 표식", markIdx >= 0, JSON.stringify(s.ops.filter((o) => o.op === "evaluate")));
    check("표식이 fill 직전(누출 프레임 포함 커버)", markIdx >= 0 && markIdx < fillIdx);
    // break-it AUD4-SHADOW-IFRAME: 표식이 open shadow root 를 관통(재귀 shadowRoot 순회)해야 셰도우 내 자격증명 필드도 표식됨.
    check("표식이 shadow DOM 관통(shadowRoot 재귀 순회)", markIdx >= 0 && (s.ops[markIdx]?.selector ?? "").includes("shadowRoot"));

    const plan = (result.output as { plan?: { operation?: string; selector?: string; value?: unknown; valueRef?: unknown } }).plan;
    check("output.plan.valueRef = 에셋 키(평문 아님)", plan?.valueRef === ASSET_KEY);
    check("output.plan.value 부재(LLM 추측값 미운반)", plan?.value === undefined);

    const serialized = JSON.stringify(result);
    check("JSON.stringify(StepResult) 에 평문 부재", !serialized.includes(SECRET));
    let safe = "";
    let threw = false;
    try {
      safe = safeSerialize(result);
    } catch {
      threw = true;
    }
    check("safeSerialize(StepResult) 통과(taint 미도달) + 평문 부재", !threw && !safe.includes(SECRET));

    const records = log.snapshot();
    const resolveRow = records.find((r) => r.action === "secret.resolve");
    const payload = resolveRow?.payload as { ref?: string; purpose?: string } | undefined;
    check("감사 secret.resolve(allow) 1건 기록", resolveRow !== undefined && resolveRow.outcome === "allow");
    check("감사 payload = {ref, purpose:'executor'}", payload?.ref === VAULT_REF && payload?.purpose === "executor");
    check("감사 어디에도 시크릿 값 미포함", !JSON.stringify(records).includes(SECRET));
  }

  // ── 가드(loud): 경계/principal 미주입 → IR_SCHEMA_INVALID ──
  {
    const s = fakeSessions();
    const ex = new StagehandDomExecutor(planGateway, s.provider, cfg); // secrets/principal 미주입
    const err = await caught(
      ex.execute("n2", { type: "act", instruction: "비밀번호 입력", secretRef: ASSET_KEY }, makeCtx()),
    );
    check("경계 미주입 → IR_SCHEMA_INVALID throw", err?.code === "IR_SCHEMA_INVALID");
    check("미주입 시 CDP fill 미실행(조용한 빈 fill 금지)", !s.ops.some((o) => o.op === "fill"));
  }

  // ── 가드(loud): 에셋 키 미바인딩 → IR_SCHEMA_INVALID ──
  {
    const s = fakeSessions();
    const { boundary } = boundaryWithLog();
    const ex = new StagehandDomExecutor(planGateway, s.provider, cfg, undefined, boundary, PRINCIPAL);
    const err = await caught(
      ex.execute("n3", { type: "act", instruction: "비밀번호 입력", secretRef: "missing.key" }, makeCtx()),
    );
    check("에셋 키 미바인딩 → IR_SCHEMA_INVALID throw", err?.code === "IR_SCHEMA_INVALID");
  }

  // ── 비-자격증명 act(secretRef 없음)는 리터럴 fill 그대로(기존 동작 보존) ──
  {
    const s = fakeSessions();
    const litGateway: LlmGatewayCaller = {
      call: async () =>
        ({
          outputRef: "art://o" as ArtifactRef,
          usage: { inputTokens: 1, outputTokens: 1, cost: 0 },
          finishReason: "stop",
          parsedJson: { operation: "fill", selector: "#q", value: "hello" },
        }) as unknown as LLMResponse,
    };
    const ex = new StagehandDomExecutor(litGateway, s.provider, cfg);
    await ex.execute("n4", { type: "act", instruction: "검색어 입력" }, makeCtx());
    const fill = s.ops.find((o) => o.op === "fill");
    check("비-자격증명 fill 은 리터럴 value 보존", fill?.selector === "#q" && fill?.value === "hello");
    check("비-자격증명 fill 은 data-rpa-sensitive 표식 안 함(자격증명만 표식)", !s.ops.some((o) => o.op === "evaluate" && o.selector.includes("data-rpa-sensitive")));
  }

  // ── 결정형 fill(fill_selector) + secretRef: LLM 을 전혀 경유하지 않고 IR 선언 셀렉터에 시크릿을 채운다(셀렉터 환각 차단) ──
  {
    const s = fakeSessions();
    const { boundary } = boundaryWithLog();
    let llmCalls = 0;
    const trackingGateway: LlmGatewayCaller = {
      call: async () => {
        llmCalls += 1;
        // 만약 결정형 경로가 잘못 LLM 을 부르면 다른(환각) 셀렉터를 줘서 테스트가 실패하도록.
        return { outputRef: "art://o" as ArtifactRef, usage: { inputTokens: 1, outputTokens: 1, cost: 0 }, finishReason: "stop", parsedJson: { operation: "fill", selector: "#hallucinated" } } as unknown as LLMResponse;
      },
    };
    const ex = new StagehandDomExecutor(trackingGateway, s.provider, cfg, undefined, boundary, PRINCIPAL);
    const result = await ex.execute(
      "n-det-pw",
      { type: "act", instruction: "비밀번호 입력", secretRef: ASSET_KEY, fillSelector: "#det-password", sideEffect: "login" },
      makeCtx(),
    );
    check("결정형 fill 은 LLM 을 전혀 호출하지 않음", llmCalls === 0);
    const fill = s.ops.find((o) => o.op === "fill");
    check("결정형 fill 은 IR 선언 셀렉터(#det-password)에 적용(LLM 환각 #hallucinated 미사용)", fill?.selector === "#det-password");
    check("결정형 fill 에 시크릿 평문이 정확히 전달됨", fill?.value === SECRET);
    check("결정형 fill StepResult.status=success", result.status === "success");
    const plan = (result.output as { plan?: { valueRef?: unknown; value?: unknown } }).plan;
    check("결정형 fill output.plan 은 ref-bearing(평문 미운반)", plan?.valueRef === ASSET_KEY && plan?.value === undefined);
  }

  // ── 결정형 fill(fill_selector) + value_ref(비-secret): LLM 미경유로 IR 셀렉터에 params 값 fill ──
  {
    const s = fakeSessions();
    let llmCalls = 0;
    const trackingGateway: LlmGatewayCaller = {
      call: async () => {
        llmCalls += 1;
        return { outputRef: "art://o" as ArtifactRef, usage: { inputTokens: 1, outputTokens: 1, cost: 0 }, finishReason: "stop", parsedJson: { operation: "fill", selector: "#hallucinated" } } as unknown as LLMResponse;
      },
    };
    const ex = new StagehandDomExecutor(trackingGateway, s.provider, cfg);
    await ex.execute(
      "n-det-val",
      { type: "act", instruction: "사유 입력", valueRef: "reason", value: "반려 사유 텍스트", fillSelector: "textarea#reason" },
      makeCtx(),
    );
    check("결정형 value fill 은 LLM 미호출", llmCalls === 0);
    const fill = s.ops.find((o) => o.op === "fill");
    check("결정형 value fill 은 IR 셀렉터·params 값으로 적용", fill?.selector === "textarea#reason" && fill?.value === "반려 사유 텍스트");
  }

  // ── 결정형 select(select_selector+select_value): LLM 미경유로 드롭다운 셀렉터·옵션 결정형 선택 ──
  {
    const s = fakeSessions();
    let llmCalls = 0;
    const trackingGateway: LlmGatewayCaller = {
      call: async () => {
        llmCalls += 1;
        return { outputRef: "art://o" as ArtifactRef, usage: { inputTokens: 1, outputTokens: 1, cost: 0 }, finishReason: "stop", parsedJson: { operation: "select", selector: "#hallucinated", value: "wrong" } } as unknown as LLMResponse;
      },
    };
    const ex = new StagehandDomExecutor(trackingGateway, s.provider, cfg);
    await ex.execute("n-det-sel", { type: "act", instruction: "연도 선택", selectSelector: "select#year", selectValue: "2026" }, makeCtx());
    check("결정형 select 는 LLM 미호출", llmCalls === 0);
    const sel = s.ops.find((o) => o.op === "select");
    check("결정형 select 는 IR 셀렉터·값으로 selectOption(LLM 환각 미사용)", sel?.selector === "select#year" && sel?.value === "2026");
  }

  if (failures > 0) {
    console.error(`\nFAIL: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nPASS: StagehandDomExecutor 자격증명 fill 시크릿-주입 누출-제로 green");
  process.exit(0);
}

main().catch((e) => {
  console.error("unit fatal:", e);
  process.exit(1);
});
