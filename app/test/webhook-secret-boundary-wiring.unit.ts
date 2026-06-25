/**
 * 단위 — 인바운드 웹훅 시크릿 경계 합성루트 배선 (적대감사 #C1). startApi 가 buildApiWebhookSecretBoundary 로
 * webhookSecretBoundary 를 구성·주입하지 않아 모든 서명 웹훅이 500(webhook_secret_boundary_not_configured)으로
 * 죽던 dead-path 회귀 방지. deny_all → undefined(fail-closed, 기존 동작) / vault 구성 → boundary 활성.
 * (main.ts 는 isDirectEntrypoint 가드로 import 시 부작용 없음.)
 */
import type { Pool } from "pg";

import { buildApiWebhookSecretBoundary } from "../src/main";

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail !== undefined ? ` — ${detail}` : ""}`);
  }
}

const fakePool = {} as Pool; // 생성만 검증(resolve 미호출 → pool/네트워크 미사용).

// 1) deny_all → undefined (Vault 미구성: 웹훅 발화 fail-closed, 수정 전후 동일 동작 보존).
check("deny_all → undefined (fail-closed)", buildApiWebhookSecretBoundary(fakePool, { mode: "deny_all" }) === undefined);

// 2) vault 구성 → boundary 활성(#C1 dead-path 수정). 생성 시 네트워크 미발생, resolveAuthorized 보유.
const active = buildApiWebhookSecretBoundary(fakePool, {
  mode: "vault",
  vaultApi: { addr: "https://vault.test", mount: "secret", roleId: "r", secretId: "s" },
  sourceRef: "secret://test/registry",
});
check(
  "vault 구성 → webhookSecretBoundary 활성(connector 시크릿 해소 가능)",
  active !== undefined && typeof active.resolveAuthorized === "function",
  String(active),
);

if (failures > 0) {
  console.error(`\nwebhook-secret-boundary-wiring.unit: ${failures} FAIL`);
  process.exit(1);
}
console.log("\nwebhook-secret-boundary-wiring.unit: ALL PASS");
