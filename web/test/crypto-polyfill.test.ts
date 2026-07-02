import { afterEach, describe, expect, test, vi } from "vitest";

// 비보안 컨텍스트(사내망 HTTP)에는 crypto.randomUUID 가 없다 — 폴리필이 진입 시점에 채우는지 검증.
const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis.crypto, "randomUUID");

function stubRandomUUID(value: unknown): void {
  Object.defineProperty(globalThis.crypto, "randomUUID", { value, configurable: true, writable: true });
}

describe("crypto-polyfill", () => {
  afterEach(() => {
    if (originalDescriptor !== undefined) {
      Object.defineProperty(globalThis.crypto, "randomUUID", originalDescriptor);
    } else {
      delete (globalThis.crypto as { randomUUID?: unknown }).randomUUID;
    }
    vi.resetModules();
  });

  test("randomUUID 부재 환경에서 UUIDv4 폴백을 설치한다", async () => {
    stubRandomUUID(undefined);
    await import("../src/crypto-polyfill");

    const make = globalThis.crypto.randomUUID.bind(globalThis.crypto);
    const first = make();
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(make()).not.toBe(first);
  });

  test("네이티브 구현이 있으면 교체하지 않는다", async () => {
    const native = (): string => "native-uuid";
    stubRandomUUID(native);
    await import("../src/crypto-polyfill");

    expect(globalThis.crypto.randomUUID).toBe(native);
  });
});
