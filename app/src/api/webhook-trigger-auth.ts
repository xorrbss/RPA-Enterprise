import { createHmac, timingSafeEqual } from "node:crypto";

import type { PlainSecret } from "../../../ts/core-types";

const WEBHOOK_SIGNATURE_RE = /^sha256=([a-f0-9]{64})$/i;

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value)) ?? "null";
}

export function webhookSigningPayload(timestamp: string, eventId: string, body: unknown): string {
  return `${timestamp}.${eventId}.${canonicalJson(body)}`;
}

export function verifyWebhookSignature(
  secret: PlainSecret | string,
  signatureHeader: string,
  payload: string,
): boolean {
  const match = WEBHOOK_SIGNATURE_RE.exec(signatureHeader);
  if (match === null) return false;

  const expected = createHmac("sha256", secret).update(payload).digest();
  const provided = Buffer.from(match[1].toLowerCase(), "hex");
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item));
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const item = value[key];
      if (item !== undefined) out[key] = canonicalize(item);
    }
    return out;
  }
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
