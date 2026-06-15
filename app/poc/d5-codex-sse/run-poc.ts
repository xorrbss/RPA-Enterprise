/**
 * D5 라이브 PoC — Codex SSE 외부 사실 실측 (llm-gateway-adapter.md §7 line 143 / README §19).
 *
 * 닫아야 할 외부 사실은 라이브 provider 로만 확정된다(가정 금지):
 *   ① structured-output 스트리밍 지원 범위 → capabilities.jsonMode
 *   ② abort 시그널 규격 → signal.abort 시 SSE close + aborted 1회, hang 없음
 *   ③ maxContextTokens → 모델 실제 컨텍스트 한도
 *
 * 이 하니스는 **프로덕션 코드(app/src/gateway 의 CodexSseAdapter·FetchCodexSseTransport)를 그대로
 * 라이브 검증**한다 — 재구현 아님. 자격증명은 env 로만 주입하고 repo 에 남기지 않는다.
 *
 * 재현:
 *   CODEX_BASE_URL=https://host/v1 \
 *   CODEX_API_KEY=<SecretRef-resolved env value> \
 *   CODEX_MODEL=<model-id> \
 *   [CODEX_MAX_CONTEXT_TOKENS=<n>] \
 *   npm --prefix app/poc/d5-codex-sse install && npm --prefix app/poc/d5-codex-sse run poc
 *
 * 결과는 D3 PoC 와 동일한 PASS/GAP/ERROR 표로 stdout 에 출력 → D5-POC-EVIDENCE.md 에 옮긴다.
 */
import { CodexSseAdapter } from "../../src/gateway/codex-sse-adapter";
import { FetchCodexSseTransport } from "../../src/gateway/codex-sse-transport";
import type { LLMRequest, LLMStreamEvent } from "../../../ts/security-middleware-contract";
import { errorEvidence, markdownCell, redactEvidence, validateCodexBaseUrl, validateEvidenceAlias } from "./evidence-redaction";

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

const BASE_URL = validateCodexBaseUrl(env("CODEX_BASE_URL"));
const API_KEY = env("CODEX_API_KEY");
const MODEL = env("CODEX_MODEL");
const CONFIGURED_MAX_CTX = Number(process.env.CODEX_MAX_CONTEXT_TOKENS ?? "8192");
const EVIDENCE_ENDPOINT_ALIAS = validateEvidenceAlias(
  "CODEX_EVIDENCE_ENDPOINT_ALIAS",
  env("CODEX_EVIDENCE_ENDPOINT_ALIAS"),
);
const EVIDENCE_MODEL_ALIAS = validateEvidenceAlias("CODEX_EVIDENCE_MODEL_ALIAS", env("CODEX_EVIDENCE_MODEL_ALIAS"));

// LLMRequest 의 브랜드 필드는 PoC 테스트 데이터다. 프로덕션 redaction/멱등 경계는 Gateway 책임이므로
// 여기서는 어댑터/전송의 라이브 동작만 본다(브랜드 캐스팅은 하니스 한정).
function buildRequest(userText: string, maxOutputTokens = 256): LLMRequest {
  return {
    model: MODEL,
    promptTemplateVersion: "d5-poc@1",
    messages: [
      { role: "system", content: "You are a terse assistant for a PoC. Answer briefly." as never },
      { role: "user", content: userText as never },
    ],
    metadata: {
      tenantId: "poc-tenant" as never,
      runId: "poc-run" as never,
      stepId: "poc-step" as never,
      attempt: 1,
      primitive: "extract",
      correlationId: "poc-corr" as never,
    },
    budget: { maxInputTokens: 100_000, maxOutputTokens, maxCost: 10 },
    sampling: { temperature: 0 },
    idempotencyKey: "poc-idem" as never,
    requestHash: "poc-hash" as never,
  };
}

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

async function collect(
  stream: AsyncIterable<LLMStreamEvent>,
  onEvent?: (e: LLMStreamEvent) => void | Promise<void>,
): Promise<LLMStreamEvent[]> {
  const events: LLMStreamEvent[] = [];
  for await (const e of stream) {
    events.push(e);
    if (onEvent) await onEvent(e);
  }
  return events;
}

const textOf = (events: LLMStreamEvent[]): string =>
  events
    .filter((e): e is Extract<LLMStreamEvent, { type: "text_delta" }> => e.type === "text_delta")
    .map((e) => e.text)
    .join("");

const kinds = (events: LLMStreamEvent[]): string => events.map((e) => e.type).join(",");

/** ① 기본 SSE 스트리밍 — 안전경로 어댑터가 open→text_delta→usage→done 정규화. */
async function test1Basic(): Promise<Row> {
  try {
    const adapter = makeAdapter();
    const events = await collect(adapter.streamCall(buildRequest("Say the single word: pong."), new AbortController().signal));
    const text = textOf(events);
    const done = events.find((e) => e.type === "done");
    const ok = events[0]?.type === "open" && text.length > 0 && done !== undefined;
    return {
      n: 1,
      feature: "기본 SSE 스트리밍(안전경로 정규화)",
      status: ok ? "PASS" : "GAP",
      via: "CodexSseAdapter.streamCall + FetchCodexSseTransport",
      evidence: `events=[${kinds(events)}] textLen=${text.length}`,
    };
  } catch (e) {
    return { n: 1, feature: "기본 SSE 스트리밍(안전경로 정규화)", status: "ERROR", via: "streamCall", evidence: errorEvidence(e) };
  }
}

/** ② structured-output via prompt-schema(안전경로) — 모델이 지시만으로 유효 JSON 을 내는가. */
async function test2PromptSchema(): Promise<Row> {
  const prompt =
    'Return ONLY a JSON object matching {"city": string, "country": string} for the capital of France. No prose, no code fence.';
  try {
    const adapter = makeAdapter();
    const events = await collect(adapter.streamCall(buildRequest(prompt), new AbortController().signal));
    const text = textOf(events).trim().replace(/^```(?:json)?|```$/g, "").trim();
    let parsed: unknown;
    let valid = false;
    try {
      parsed = JSON.parse(text);
      valid =
        typeof parsed === "object" &&
        parsed !== null &&
        typeof (parsed as Record<string, unknown>).city === "string" &&
        typeof (parsed as Record<string, unknown>).country === "string";
    } catch {
      valid = false;
    }
    return {
      n: 2,
      feature: "structured-output(안전경로 prompt-schema+strict 검증)",
      status: valid ? "PASS" : "GAP",
      via: "prompt 지시 → 텍스트 스트림 → JSON.parse + shape 검증",
      evidence: valid ? `parsed=${redactEvidence(JSON.stringify(parsed))}` : `non-conforming text="${redactEvidence(text.slice(0, 120))}"`,
    };
  } catch (e) {
    return { n: 2, feature: "structured-output(안전경로 prompt-schema)", status: "ERROR", via: "streamCall", evidence: errorEvidence(e) };
  }
}

/**
 * ③ native response_format json_schema + stream(빠른경로 프로브) — provider 가 수용하고
 * 유효 스트리밍 JSON 을 내는지 직접 POST 로 실측. 결과가 capabilities.jsonMode 를 확정한다.
 * (프로덕션 안전경로 전송은 response_format 을 보내지 않으므로 여기서만 직접 프로브.)
 */
async function test3NativeJsonMode(): Promise<Row> {
  const body = {
    model: MODEL,
    stream: true,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "capital",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["city", "country"],
          properties: { city: { type: "string" }, country: { type: "string" } },
        },
      },
    },
    messages: [{ role: "user", content: "Capital of France as JSON." }],
  };
  try {
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${API_KEY}`, accept: "text/event-stream" },
      body: JSON.stringify(body),
    });
    if (!res.ok || res.body === null) {
      const detail = await res.text().catch(() => "");
      return {
        n: 3,
        feature: "native json_schema 스트리밍(빠른경로 → jsonMode)",
        status: "GAP",
        via: "직접 POST response_format:{json_schema} stream:true",
        evidence: `HTTP ${res.status} ${redactEvidence(res.statusText)} ${redactEvidence(detail.slice(0, 160))} → jsonMode=false(안전경로 유지)`,
      };
    }
    // 스트림 누적 후 JSON 유효성 확인.
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let assembled = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        for (const line of frame.split("\n")) {
          const t = line.trim();
          if (!t.startsWith("data:")) continue;
          const data = t.slice(5).trim();
          if (data === "[DONE]") continue;
          try {
            const chunk = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string | null } }> };
            assembled += chunk.choices?.[0]?.delta?.content ?? "";
          } catch {
            /* keepalive */
          }
        }
      }
    }
    reader.releaseLock();
    let valid = false;
    try {
      const p = JSON.parse(assembled.trim()) as Record<string, unknown>;
      valid = typeof p.city === "string" && typeof p.country === "string";
    } catch {
      valid = false;
    }
    return {
      n: 3,
      feature: "native json_schema 스트리밍(빠른경로 → jsonMode)",
      status: valid ? "PASS" : "GAP",
      via: "직접 POST response_format:{json_schema} stream:true",
      evidence: valid
        ? `accepted + valid streamed JSON → jsonMode=true 활성 가능. assembled=${redactEvidence(assembled.slice(0, 120))}`
        : `accepted but JSON invalid → jsonMode=false 유지. assembled="${redactEvidence(assembled.slice(0, 120))}"`,
    };
  } catch (e) {
    return { n: 3, feature: "native json_schema 스트리밍(빠른경로)", status: "ERROR", via: "직접 POST", evidence: errorEvidence(e) };
  }
}

/** ④ abort 시그널 규격 — 첫 토큰 후 abort → aborted 1회 + 연결 close + hang 없음. */
async function test4Abort(): Promise<Row> {
  try {
    const adapter = makeAdapter();
    const ac = new AbortController();
    const start = Date.now();
    let firstTokenSeen = false;
    let abortedSeen = false;
    let postAbortDeltas = 0;
    const events = await collect(adapter.streamCall(buildRequest("Count slowly from 1 to 100, one number per line."), ac.signal), (e) => {
      if (e.type === "text_delta") {
        if (!firstTokenSeen) {
          firstTokenSeen = true;
          ac.abort(); // 첫 토큰 직후 중단
        } else if (abortedSeen) {
          postAbortDeltas++;
        }
      }
      if (e.type === "aborted") abortedSeen = true;
    });
    const elapsed = Date.now() - start;
    // 합격: aborted 방출 + wall timeout(120s) 훨씬 이전에 종결(hang 없음) + abort 후 토큰 과금 누수 없음.
    const noHang = elapsed < 30_000;
    const ok = abortedSeen && noHang && postAbortDeltas === 0;
    return {
      n: 4,
      feature: "abort 시그널 규격(close + aborted 1회, hang 없음)",
      status: ok ? "PASS" : "GAP",
      via: "signal.abort() 첫 토큰 후 → 내부 AbortController close",
      evidence: `events=[${kinds(events)}] aborted=${abortedSeen} elapsedMs=${elapsed} postAbortDeltas=${postAbortDeltas}`,
    };
  } catch (e) {
    return { n: 4, feature: "abort 시그널 규격", status: "ERROR", via: "signal.abort", evidence: errorEvidence(e) };
  }
}

/** ⑤ maxContextTokens — /models 메타데이터 프로브. 없으면 GAP(보수적 config 유지 권고). */
async function test5MaxContext(): Promise<Row> {
  try {
    const res = await fetch(`${BASE_URL}/models`, { headers: { authorization: `Bearer ${API_KEY}` } });
    if (!res.ok) {
      return {
        n: 5,
        feature: "maxContextTokens(모델 한도 실측)",
        status: "GAP",
        via: "GET /models",
        evidence: `HTTP ${res.status} → 메타데이터 없음. 보수적 config(${CONFIGURED_MAX_CTX}) 유지 권고`,
      };
    }
    const body = (await res.json()) as { data?: Array<Record<string, unknown>> };
    const entry = body.data?.find((m) => m.id === MODEL);
    const ctx =
      entry &&
      (entry.context_length ??
        entry.max_context_length ??
        (entry as { context_window?: number }).context_window ??
        ((entry as { meta?: { context_length?: number } }).meta?.context_length));
    if (typeof ctx === "number" && ctx > 0) {
      return {
        n: 5,
        feature: "maxContextTokens(모델 한도 실측)",
        status: "PASS",
        via: "GET /models 메타데이터",
        evidence: `modelAlias=${EVIDENCE_MODEL_ALIAS} context=${ctx} (config 권장값=${ctx})`,
      };
    }
    return {
      n: 5,
      feature: "maxContextTokens(모델 한도 실측)",
      status: "GAP",
      via: "GET /models 메타데이터",
      evidence: `model entry 에 context 필드 없음 → 보수적 config(${CONFIGURED_MAX_CTX}) 유지 권고`,
    };
  } catch (e) {
    return { n: 5, feature: "maxContextTokens", status: "ERROR", via: "GET /models", evidence: errorEvidence(e) };
  }
}

async function main(): Promise<void> {
  console.log(
    `# D5 Codex SSE 라이브 PoC\n- endpointAlias: ${markdownCell(EVIDENCE_ENDPOINT_ALIAS)}\n- modelAlias: ${markdownCell(EVIDENCE_MODEL_ALIAS)}\n`,
  );
  const rows: Row[] = [];
  rows.push(await test1Basic());
  rows.push(await test2PromptSchema());
  rows.push(await test3NativeJsonMode());
  rows.push(await test4Abort());
  rows.push(await test5MaxContext());

  console.log("\n| # | 필요 기능 | 상태 | 경로(via) | 증거 |");
  console.log("|---|---|---|---|---|");
  for (const r of rows) {
    console.log(`| ${r.n} | ${markdownCell(r.feature)} | \`${r.status}\` | ${markdownCell(r.via)} | ${markdownCell(r.evidence)} |`);
  }
  const pass = rows.filter((r) => r.status === "PASS").length;
  console.log(`\n결과: ${pass}/${rows.length} PASS`);
  console.log("\n## capabilities 결론(라이브 확정값)");
  const jsonMode = rows[2].status === "PASS";
  console.log(`- jsonMode = ${jsonMode}  (false 면 Gateway prompt-schema+strict 안전경로 유지)`);
  console.log(`- abort 규격 = ${rows[3].status === "PASS" ? "확정(close+aborted, hang 없음)" : "재확인 필요"}`);
  console.log(`- maxContextTokens = ${rows[4].status === "PASS" ? "메타데이터 확정" : `보수적 config(${CONFIGURED_MAX_CTX}) 유지`}`);

  const mandatory = new Set([1, 2, 4]);
  const missingMandatory = rows.filter((r) => mandatory.has(r.n) && r.status !== "PASS");
  if (missingMandatory.length > 0) {
    console.error(
      `\nFAIL: mandatory D5 live checks must PASS for release evidence: ${missingMandatory
        .map((r) => `#${r.n}=${r.status}`)
        .join(", ")}`,
    );
    console.error("Optional GAP is allowed only for #3 native json_schema and #5 model metadata fallback.");
  }

  const errored = rows.some((r) => r.status === "ERROR");
  process.exitCode = errored || missingMandatory.length > 0 ? 1 : 0;
}

void main();
