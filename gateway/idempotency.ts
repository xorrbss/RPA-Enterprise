import type {
  LLMCallIdempotencyStore,
  LLMIdempotencyReservation,
  LLMRequest,
  LLMResponse,
} from "../ts/security-middleware-contract";

type LLMIdempotencyRecord =
  | { status: "processing"; callId: string; requestHash: string }
  | { status: "succeeded"; callId: string; requestHash: string; response: LLMResponse }
  | { status: "failed"; callId: string; requestHash: string; error: string };

export class InMemoryLLMCallIdempotencyStore implements LLMCallIdempotencyStore {
  private readonly records = new Map<string, LLMIdempotencyRecord>();
  private sequence = 0;

  async reserve(req: LLMRequest): Promise<LLMIdempotencyReservation> {
    const key = llmIdempotencyRecordKey(req);
    const existing = this.records.get(key);
    if (existing !== undefined) {
      if (existing.requestHash !== String(req.requestHash)) {
        return { kind: "blocked", reason: "request_hash_mismatch" };
      }
      if (existing.status === "succeeded") return { kind: "replay", response: existing.response };
      return { kind: "in_flight", callId: existing.callId };
    }

    const callId = `fake-call-${++this.sequence}`;
    this.records.set(key, { status: "processing", callId, requestHash: String(req.requestHash) });
    return { kind: "reserved", callId, idempotencyKey: req.idempotencyKey };
  }

  async complete(callId: string, response: LLMResponse): Promise<void> {
    const [key, record] = this.findByCallId(callId);
    this.records.set(key, { status: "succeeded", callId, requestHash: record.requestHash, response });
  }

  async fail(callId: string, error: string): Promise<void> {
    const [key, record] = this.findByCallId(callId);
    this.records.set(key, { status: "failed", callId, requestHash: record.requestHash, error });
  }

  private findByCallId(callId: string): [string, LLMIdempotencyRecord] {
    for (const entry of this.records.entries()) {
      if (entry[1].callId === callId) return entry;
    }
    throw new Error(`unknown LLM call id ${callId}`);
  }
}

function llmIdempotencyRecordKey(req: LLMRequest): string {
  return JSON.stringify([String(req.metadata.tenantId), String(req.idempotencyKey)]);
}
