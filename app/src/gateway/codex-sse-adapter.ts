/**
 * Codex SSE 어댑터 — 안전 경로 골격 (D5 — llm-gateway-adapter.md §1·§3·§4·§7).
 *
 * `LLMBackendAdapter`(ts/security-middleware-contract.ts 고정 타입) 구현. OpenAI 호환
 * `/v1/chat/completions` SSE(`stream:true`)를 표준 `LLMStreamEvent`(§3)로 정규화한다.
 *
 * **안전 경로(README §19 / llm-gateway-adapter §7)**: Codex 의 structured-output 스트리밍 실범위·abort
 * 규격·maxContextTokens 는 라이브로만 확정되는 외부 사실이라, `capabilities()` 는 **보수적 기본**(jsonMode=false 등)
 * 으로 동작한다 — 미지원 가정 하에 Gateway 가 prompt-schema+strict(§7)로 대체. 라이브 capability PoC 확정 시
 * config 로 켠다. 본 어댑터는 `json_delta` 를 native 로 가정하지 않고 텍스트 스트림으로 처리한다(false success 방지).
 *
 * 전송(transport)은 주입형으로 분리 — 라이브 `FetchCodexSseTransport` vs 테스트용 fake. 정규화·예산·abort·
 * 타임아웃 로직은 키/엔드포인트 없이 오프라인 검증 가능하다.
 */
import type {
  AdapterErrorCode,
  LLMBackendAdapter,
  LLMRequest,
  LLMStreamEvent,
  ModelCapabilities,
} from "../../../ts/security-middleware-contract";

/** OpenAI 호환 스트리밍 청크(소비 필드만). */
export interface OpenAiSseChunk {
  choices?: ReadonlyArray<{
    delta?: { content?: string | null };
    finish_reason?: "stop" | "length" | "tool_calls" | "content_filter" | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
}

/** 전송 경계: 정규화된 OpenAI SSE 청크를 방출. 라이브 fetch impl 과 fake(test) 가 이 인터페이스를 구현. */
export interface CodexSseTransport {
  open(req: LLMRequest, signal: AbortSignal): AsyncIterable<OpenAiSseChunk>;
}

export interface CodexSseConfig {
  model: string;
  /** 외부 사실(라이브 확정) — 미정 시 보수적 상한. capabilities.maxContextTokens. */
  maxContextTokens: number;
  /** ops-defaults §4 llm.stream_idle_timeout(기본 20s). */
  idleTimeoutMs: number;
  /** ops-defaults §4 llm.stream_wall_timeout(기본 120s). */
  wallTimeoutMs: number;
  /** 모델별 단가(외부 사실) — 미설정(0) 시 비용 강제 미적용, output 토큰 상한만 강제. */
  pricePer1kInputUsd: number;
  pricePer1kOutputUsd: number;
  /** 안전 경로: 라이브 capability PoC(README §19) 확정 전까지 보수적 기본을 override 만 허용. */
  capabilities?: Partial<Pick<ModelCapabilities, "domReasoning" | "vision" | "jsonMode" | "toolCall" | "sse">>;
}

const APPROX_CHARS_PER_TOKEN = 4;
const estTokens = (s: string): number => Math.ceil(s.length / APPROX_CHARS_PER_TOKEN);

function mapFinish(fr: NonNullable<NonNullable<OpenAiSseChunk["choices"]>[number]["finish_reason"]>) {
  return fr === "tool_calls" ? ("tool_call" as const) : fr;
}

/** 전송 예외 → AdapterErrorCode(§4). 상태코드 단서로 분류, 불명은 CONNECTION_FAILED(retryable). */
function classifyTransportError(cause: unknown): { code: AdapterErrorCode; retryable: boolean } {
  const text = cause instanceof Error ? cause.message : String(cause);
  if (/\b429\b|rate.?limit/i.test(text)) return { code: "RATE_LIMIT", retryable: true };
  if (/\b5\d\d\b/.test(text)) return { code: "BACKEND_ERROR", retryable: true };
  return { code: "CONNECTION_FAILED", retryable: true };
}

type NextOutcome =
  | { kind: "chunk"; value: OpenAiSseChunk }
  | { kind: "end" }
  | { kind: "timeout" }
  | { kind: "aborted" };

/** it.next() 를 타임아웃/abort 와 race. 패자(미해결 next)는 호출측 finally 의 it.return() 으로 정리. */
async function raceNext(
  it: AsyncIterator<OpenAiSseChunk>,
  ms: number,
  signal: AbortSignal,
): Promise<NextOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race<NextOutcome>([
      it.next().then((r) => (r.done ? { kind: "end" } : { kind: "chunk", value: r.value })),
      new Promise<NextOutcome>((resolve) => {
        timer = setTimeout(() => resolve({ kind: "timeout" }), ms);
      }),
      new Promise<NextOutcome>((resolve) => {
        if (signal.aborted) return resolve({ kind: "aborted" });
        onAbort = () => resolve({ kind: "aborted" });
        signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

export class CodexSseAdapter implements LLMBackendAdapter {
  readonly id = "codex-sse";

  constructor(
    private readonly transport: CodexSseTransport,
    private readonly cfg: CodexSseConfig,
    private readonly now: () => number = Date.now,
  ) {}

  capabilities(): ModelCapabilities {
    const c = this.cfg.capabilities ?? {};
    // 안전 경로: 라이브 capability PoC(README §19) 확정 전까지 보수적. jsonMode=false →
    // structured output 은 Gateway 가 prompt-schema+strict(§7)로 대체(어댑터는 텍스트 스트림만).
    return {
      domReasoning: c.domReasoning ?? true,
      vision: c.vision ?? false,
      jsonMode: c.jsonMode ?? false,
      toolCall: c.toolCall ?? false,
      sse: c.sse ?? true,
      maxContextTokens: this.cfg.maxContextTokens,
    };
  }

  async *streamCall(req: LLMRequest, signal: AbortSignal): AsyncIterable<LLMStreamEvent> {
    if (signal.aborted) {
      yield { type: "aborted" };
      return;
    }
    yield { type: "open" };

    const startedAt = this.now();
    let inputTokens = req.messages.reduce(
      (n, m) => n + (typeof m.content === "string" ? estTokens(m.content) : 0),
      0,
    );
    let outputTokens = 0;
    let usageEstimated = true;
    let lastEventAt = this.now();

    const cost = (): number =>
      (inputTokens / 1000) * this.cfg.pricePer1kInputUsd +
      (outputTokens / 1000) * this.cfg.pricePer1kOutputUsd;
    const overBudget = (): boolean =>
      outputTokens > req.budget.maxOutputTokens || cost() > req.budget.maxCost;

    // 내부 AbortController: 외부 abort 를 전달하되, 어댑터가 멈추기로 한 모든 경로(타임아웃·예산·에러)에서도
    // 전송을 close 한다(fetch 연결·미해결 next 누수 방지). raceNext 는 외부 signal 로 즉시 abort 감지.
    const ac = new AbortController();
    const onExt = () => ac.abort();
    if (signal.aborted) ac.abort();
    else signal.addEventListener("abort", onExt, { once: true });

    const it = this.transport.open(req, ac.signal)[Symbol.asyncIterator]();
    try {
      for (;;) {
        if (this.now() - startedAt >= this.cfg.wallTimeoutMs) {
          yield this.err("STREAM_TIMEOUT", false, "wall-clock timeout");
          return;
        }
        if (this.now() - lastEventAt >= this.cfg.idleTimeoutMs) {
          yield this.err("STREAM_IDLE_TIMEOUT", true, "no token within idle timeout");
          return;
        }
        const wallLeft = this.cfg.wallTimeoutMs - (this.now() - startedAt);
        const idleLeft = this.cfg.idleTimeoutMs - (this.now() - lastEventAt);

        let r: NextOutcome;
        try {
          r = await raceNext(it, Math.max(1, Math.min(wallLeft, idleLeft)), signal);
        } catch (cause) {
          // 전송 실패(연결/HTTP) → §4 분류 후 1회 방출. 부분 누적 폐기(false success 방지).
          const { code, retryable } = classifyTransportError(cause);
          yield this.err(code, retryable, cause instanceof Error ? cause.message : String(cause));
          return;
        }

        if (r.kind === "aborted") {
          // signal.abort → 연결 close 후 aborted 1회(§3). 진행 토큰 과금 중단.
          yield { type: "aborted" };
          return;
        }
        if (r.kind === "timeout") {
          const wall = this.now() - startedAt >= this.cfg.wallTimeoutMs;
          yield wall
            ? this.err("STREAM_TIMEOUT", false, "wall-clock timeout")
            : this.err("STREAM_IDLE_TIMEOUT", true, "idle timeout");
          return;
        }
        if (r.kind === "end") {
          // done 없이 스트림 종료 — 누적분으로 usage+done(stop) 마감.
          yield { type: "usage", inputTokens, outputTokens, cost: cost(), estimated: usageEstimated };
          yield { type: "done", finishReason: "stop" };
          return;
        }

        lastEventAt = this.now();
        const choice = r.value.choices?.[0];

        const text = choice?.delta?.content;
        if (typeof text === "string" && text.length > 0) {
          outputTokens += estTokens(text);
          yield { type: "text_delta", text };
        }
        const u = r.value.usage;
        if (u) {
          if (typeof u.prompt_tokens === "number") inputTokens = u.prompt_tokens;
          if (typeof u.completion_tokens === "number") {
            outputTokens = u.completion_tokens;
            usageEstimated = false;
          }
        }

        // §3 [FIX #4]: 스트림 중 예산 강제 — 누적(미수신 시 추정)이 상한 초과 시 즉시 중단.
        if (overBudget()) {
          yield this.err("BUDGET_EXCEEDED", false, "budget exceeded mid-stream");
          return;
        }

        const fr = choice?.finish_reason;
        if (fr) {
          yield { type: "usage", inputTokens, outputTokens, cost: cost(), estimated: usageEstimated };
          yield { type: "done", finishReason: mapFinish(fr) };
          return;
        }
      }
    } finally {
      // 전송 정리(가정 금지: 미해결 next 누수·연결 누수 방지).
      signal.removeEventListener("abort", onExt);
      ac.abort();
      await it.return?.(undefined);
    }
  }

  private err(code: AdapterErrorCode, retryable: boolean, message: string): LLMStreamEvent {
    return { type: "error", code, retryable, message };
  }
}
