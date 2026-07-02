/**
 * crypto.randomUUID 폴백 — 반드시 앱의 다른 모듈보다 먼저 import 되어야 한다(main.tsx 최상단).
 *
 * crypto.randomUUID 는 secure context(HTTPS·localhost) 전용이라 사내망 HTTP(IP 접속) 배포에서는
 * 존재하지 않는다. 콘솔의 모든 명령이 멱등키 생성에 이를 사용하므로, 미존재 환경에서는 사람 확인
 * 검토 패널과 전체 쓰기 동작이 크래시한다(2026-07-02 감사 L1). getRandomValues 는 비보안
 * 컨텍스트에서도 동작하므로 이를 기반으로 한 UUIDv4 로 채운다.
 */
const cryptoObj = globalThis.crypto;
if (typeof cryptoObj !== "undefined" && typeof cryptoObj.randomUUID !== "function") {
  const fallbackRandomUUID = (): string => {
    const bytes = new Uint8Array(16);
    cryptoObj.getRandomValues(bytes);
    bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
    bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  };
  (cryptoObj as { randomUUID: () => string }).randomUUID = fallbackRandomUUID;
}

export {};
