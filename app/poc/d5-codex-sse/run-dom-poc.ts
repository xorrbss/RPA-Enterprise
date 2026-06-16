/**
 * D5c 라이브 PoC — production dom executor 배선(P5b)을 라이브 Codex 게이트웨이에 대해 실측.
 *
 * 닫아야 할 사실(라이브로만): `createDomUtilityExecutorFactory`(P5b)가 만든 ExecutorPlugin 이 dom 프리미티브를
 *   **production 경로 그대로** — composite → StagehandDomExecutor → LlmGateway → CodexSseAdapter → 라이브 Codex —
 *   로 구동해 유효한 StepResult 를 산출하는가. 즉 P5b 의 worker executorFactory 주입이 production LLM 액션을 가동함을 증명.
 *
 * 재구현 아님: 게이트웨이/어댑터/전송/실행기/팩토리 전부 app/src 프로덕션 코드. POC 한정 대역은 비-라이브 포트뿐
 *   (in-memory ArtifactSink — outputRef 저장 경계, evidence 캡처용 · 허용 validator · CDP provider 는 extract 가 미사용).
 *   라이브 경계(어댑터→Codex)와 그 위 production 배선만 본다. 자격은 env 로만, 증거는 redact.
 *
 * 비용: dom extract 1회(read-only=게이트웨이 전용, 브라우저 불요). act(실 DOM 변이)는 Chrome 필요라 본 하니스 범위 밖(P5/d3).
 * challenge→suspend 라이브 트리거는 ChallengeDetector(P2) 미정의 의존이라 범위 밖.
 *
 * 재현:
 *   CODEX_BASE_URL=... CODEX_API_KEY=... CODEX_MODEL=... CODEX_EVIDENCE_ENDPOINT_ALIAS=... CODEX_EVIDENCE_MODEL_ALIAS=... \
 *   npm --prefix app/poc/d5-codex-sse install && npm --prefix app/poc/d5-codex-sse run dom-poc
 *   (.env 자동로드: 같은 폴더 .env 를 무-의존성 로드 — d5 run-poc 와 동형, 셸 env 우선.)
 */
import { readFileSync } from "node:fs";

import type { ArtifactRef, ExecutorPlugin, PageState, RunContext } from "../../../ts/core-types";
import type { LLMRequest, LLMResponse } from "../../../ts/security-middleware-contract";
import { CodexSseAdapter } from "../../src/gateway/codex-sse-adapter";
import { FetchCodexSseTransport } from "../../src/gateway/codex-sse-transport";
import { LlmGateway, type GatewayArtifactSink, type LlmGatewayConfig, type StructuredOutputValidator } from "../../src/gateway/llm-gateway";
import { SafeCapabilityGate } from "../../src/gateway/capability-gate";
import { DeterministicGatewayRedactionBoundary } from "../../../gateway/redaction-boundary";
import { createDomUtilityExecutorFactory } from "../../src/runtime/dom-executor-factory";
import type { CdpSessionProvider } from "../../src/executor/cdp-session";
import {
  buildCodexEvidenceRedactions,
  errorEvidence,
  markdownCell,
  redactEvidence,
  validateCodexBaseUrl,
  validateEvidenceAlias,
  validatePositiveIntegerEnv,
} from "./evidence-redaction";

type Status = "PASS" | "GAP" | "ERROR";
interface Row {
  n: number;
  feature: string;
  status: Status;
  via: string;
  evidence: string;
}

function env(name: string): string {
  const v = process.env[name];
  if (v === undefined || v.trim() === "") {
    throw new Error(`missing env ${name} (자격증명/엔드포인트 미주입 — PoC 실행 불가)`);
  }
  return v.trim();
}

// .env 자동 로드(무-의존성, d5 run-poc 와 동형): 이 스크립트 옆 .env 가 있으면 KEY=VALUE 를 process.env 로 채운다.
// 이미 설정된 셸 env 가 우선(덮어쓰지 않음). .env 는 .gitignore 로 커밋 차단 — 비밀은 .env(로컬)/Vault 로만.
function loadDotEnvIfPresent(): void {
  let text: string;
  try {
    text = readFileSync(new URL("./.env", import.meta.url), "utf8");
  } catch {
    return; // .env 없으면 셸 env 만 사용.
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined || process.env[key] === "") process.env[key] = val;
  }
}
loadDotEnvIfPresent();

const BASE_URL = validateCodexBaseUrl(env("CODEX_BASE_URL"));
const API_KEY = env("CODEX_API_KEY");
const MODEL = env("CODEX_MODEL");
const CONFIGURED_MAX_CTX = validatePositiveIntegerEnv("CODEX_MAX_CONTEXT_TOKENS", process.env.CODEX_MAX_CONTEXT_TOKENS, 8192);
const EVIDENCE_ENDPOINT_ALIAS = validateEvidenceAlias("CODEX_EVIDENCE_ENDPOINT_ALIAS", env("CODEX_EVIDENCE_ENDPOINT_ALIAS"));
const EVIDENCE_MODEL_ALIAS = validateEvidenceAlias("CODEX_EVIDENCE_MODEL_ALIAS", env("CODEX_EVIDENCE_MODEL_ALIAS"));
const EVIDENCE_REDACTIONS = buildCodexEvidenceRedactions({
  baseUrl: BASE_URL,
  apiKey: API_KEY,
  model: MODEL,
  endpointAlias: EVIDENCE_ENDPOINT_ALIAS,
  modelAlias: EVIDENCE_MODEL_ALIAS,
});
const redact = (value: unknown): string => redactEvidence(value, EVIDENCE_REDACTIONS);
const err = (error: unknown): string => errorEvidence(error, EVIDENCE_REDACTIONS);
const cell = (value: unknown): string => markdownCell(value, EVIDENCE_REDACTIONS);

// ── production 게이트웨이 배선(라이브 어댑터 + production 포트 + POC 한정 비-라이브 대역) ──
function makeAdapter(): CodexSseAdapter {
  const transport = new FetchCodexSseTransport({ baseUrl: BASE_URL, apiKey: API_KEY, model: MODEL });
  return new CodexSseAdapter(transport, {
    model: MODEL,
    maxContextTokens: CONFIGURED_MAX_CTX,
    idleTimeoutMs: 20_000,
    wallTimeoutMs: 120_000,
    pricePer1kInputUsd: 0,
    pricePer1kOutputUsd: 0,
  });
}

// in-memory ArtifactSink — gateway 의 누적 출력 저장 경계(outputRef). 라이브 DB/object-store 불요(POC 한정). content 캡처(증거용).
let lastSinkContent: string | null = null;
const memSink: GatewayArtifactSink = {
  put: async (content) => {
    lastSinkContent = content;
    return "art://d5c-dom-out" as ArtifactRef;
  },
};
// 허용 validator — 스키마 검증은 gateway 단위테스트 소관. 본 POC 는 라이브 경로만 본다.
const okValidator: StructuredOutputValidator = { validate: () => ({ ok: true }) };
const gatewayConfig: LlmGatewayConfig = { retryMax: 2, fallbackAttempts: 1, repairAttempts: 1 };

function makeGateway(): LlmGateway {
  return new LlmGateway({
    primary: makeAdapter(),
    gate: new SafeCapabilityGate(),
    validator: okValidator,
    sink: memSink,
    redactionBoundary: new DeterministicGatewayRedactionBoundary(),
    config: gatewayConfig,
  });
}

// extract(read-only)는 CDP 미사용 — provider.forLease 호출 시 명시 throw(브라우저 미구동 보장).
const noBrowserProvider = {
  forLease: () => {
    throw new Error("forLease called — d5c POC 는 read-only(extract)만, 브라우저 미구동");
  },
} as unknown as CdpSessionProvider;

function seedPageState(): PageState {
  return {
    url: { raw: "https://poc.example/reviews", canonical: "https://poc.example/reviews", pattern: "https://poc.example/*" },
    dom: { structuralHash: "d5c-seed", visibleTextHash: "d5c-seed", landmarks: [], frames: [] },
    auth: "anonymous",
    flags: {},
    matchedWhere: [],
  };
}
function ctx(): RunContext {
  return {
    runId: "d5c-run", tenantId: "00000000-0000-0000-0000-0000000000a1", nodeId: "grab", attempt: 1,
    siteProfileId: "d5c-site", browserIdentityId: "d5c-id", networkPolicyId: "d5c-np", leaseId: "d5c-lease",
    assetRefs: {}, abortSignal: new AbortController().signal, pageState: seedPageState(),
  };
}

async function main(): Promise<void> {
  const rows: Row[] = [];

  // P5b 팩토리 → production 경로 executor. deploy-time caller 와 동일 호출(gateway+정책 캡처, run-scoped 주입).
  const factory = createDomUtilityExecutorFactory(makeGateway(), {
    model: MODEL,
    promptTemplateVersion: "d5c-dom-poc@1",
    budget: { maxInputTokens: 100_000, maxOutputTokens: 256, maxCost: 10 },
  });
  const executor: ExecutorPlugin = factory(noBrowserProvider, { scenarioVersionId: "d5c-sv", browserIdentityVersion: 1 });

  // row1: 팩토리 산출 executor 의 capabilities(dom+utility 합성) — 배선 정합(라이브 호출 전 정적 확인).
  const caps = executor.capabilities();
  rows.push({
    n: 1,
    feature: "createDomUtilityExecutorFactory → composite(dom+utility) capabilities",
    status: caps.dom && !caps.vision && caps.utility ? "PASS" : "GAP",
    via: "ExecutorPlugin.capabilities()",
    evidence: cell(JSON.stringify(caps)),
  });

  // row2: dom extract 1회 라이브 — composite→StagehandDomExecutor→LlmGateway→CodexSseAdapter→Codex. 유효 StepResult 면 PASS.
  try {
    const res = await executor.execute(
      "grab.0",
      {
        type: "extract",
        instruction: "Return a small JSON object {\"rows\": [\"a\", \"b\"]} representing two sample review items. JSON only.",
        output: { schemaRef: "reviews", schemaVersion: "1", strict: false },
      },
      ctx(),
    );
    const ok = res.status === "success" && res.action === "extract";
    rows.push({
      n: 2,
      feature: "dom extract 라이브 — production 배선(factory→composite→dom→gateway→adapter→Codex)",
      status: ok ? "PASS" : "GAP",
      via: "ExecutorPlugin.execute(extract) → LlmGateway.call → CodexSseAdapter.streamCall(live)",
      evidence: redact(JSON.stringify({ status: res.status, action: res.action, exception: res.exception, finishReason: (res.output as { finishReason?: unknown })?.finishReason, extracted: res.extracted, sinkStored: lastSinkContent !== null })),
    });
  } catch (e) {
    rows.push({
      n: 2,
      feature: "dom extract 라이브 — production 배선(factory→composite→dom→gateway→adapter→Codex)",
      status: "ERROR",
      via: "ExecutorPlugin.execute(extract) → LlmGateway.call → CodexSseAdapter.streamCall(live)",
      evidence: err(e),
    });
  }

  // 출력 — D5 PoC 와 동형 PASS/GAP/ERROR 표(D5C-DOM-POC-EVIDENCE.md 로 옮김).
  console.log("\n| # | feature | status | via | evidence |");
  console.log("|---|---|---|---|---|");
  for (const r of rows) console.log(`| ${r.n} | ${r.feature} | ${r.status} | ${r.via} | ${r.evidence} |`);

  const anyError = rows.some((r) => r.status === "ERROR");
  const anyGap = rows.some((r) => r.status === "GAP");
  console.log(`\n${anyError ? "ERROR" : anyGap ? "GAP" : "PASS"}: D5c dom executor live PoC (${rows.length} rows)`);
  process.exit(anyError ? 1 : 0);
}

main().catch((e) => {
  console.error("d5c dom-poc fatal:", err(e));
  process.exit(1);
});
