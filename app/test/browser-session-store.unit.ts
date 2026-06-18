/**
 * 단위 테스트 — BrowserSessionStore 의 보안 핵심(DB 불필요): PgBrowserSessionStore fail-closed 생성자 게이트 +
 * DevPlaintextSessionEncryptor 라운드트립 + sessionKey. load/save(DB)는 dev e2e(session-reuse)가 실증.
 *
 * 핵심 단언(적대 검증의 critical fix): dev-plaintext 암호화기로는 명시 allowDevPlaintext 없이 PgBrowserSessionStore 가
 * **생성 자체를 거부**(throw) — prod 에서 평문 세션이 at-rest 로 새는 것을 구조적으로 차단. 실행: tsx test/browser-session-store.unit.ts
 */
import type { Pool } from "pg";

import {
  AesGcmSessionEncryptor,
  DevPlaintextSessionEncryptor,
  PgBrowserSessionStore,
  sessionKey,
  type SessionEncryptor,
} from "../src/runtime/browser-session-store";

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const fakePool = {} as unknown as Pool; // 생성자 게이트만 검증(load/save 미호출 → pool 미사용).

function caught(fn: () => void): Error | undefined {
  try {
    fn();
    return undefined;
  } catch (e) {
    return e instanceof Error ? e : new Error(String(e));
  }
}

async function main(): Promise<void> {
  // 1) fail-closed: dev-plaintext 암호화기 + allowDevPlaintext 미지정 → 생성자 throw.
  {
    const err = caught(() => new PgBrowserSessionStore({ pool: fakePool, encryptor: new DevPlaintextSessionEncryptor() }));
    check("dev-plaintext + allowDevPlaintext 미지정 → 생성자 throw", err !== undefined && /allowDevPlaintext/.test(err.message));
  }

  // 2) dev-plaintext + allowDevPlaintext=true → 생성 허용(비프로덕션 명시 옵트인).
  {
    const err = caught(() => new PgBrowserSessionStore({ pool: fakePool, encryptor: new DevPlaintextSessionEncryptor() }, { allowDevPlaintext: true }));
    check("dev-plaintext + allowDevPlaintext=true → 생성 허용", err === undefined);
  }

  // 3) kind:'kms' 암호화기(실 암호화기 대역) → allowDevPlaintext 없이도 생성 허용(prod 경로).
  {
    const kms: SessionEncryptor = {
      kind: "kms",
      encrypt: (b) => ({ ciphertext: b, kid: "kms-1" }),
      decrypt: (c) => c,
    };
    const err = caught(() => new PgBrowserSessionStore({ pool: fakePool, encryptor: kms }));
    check("kms 암호화기 → allowDevPlaintext 없이 생성 허용(prod)", err === undefined);
  }

  // 4) DevPlaintextSessionEncryptor 라운드트립(identity) + kid='dev-plaintext'.
  {
    const enc = new DevPlaintextSessionEncryptor();
    const plain = Buffer.from(JSON.stringify({ cookies: [{ name: "rpa_sess", value: "1" }] }), "utf8");
    const { ciphertext, kid } = enc.encrypt(plain);
    const back = enc.decrypt(ciphertext, kid);
    check("dev encryptor 라운드트립 + kid=dev-plaintext", kid === "dev-plaintext" && back.toString("utf8") === plain.toString("utf8"));
  }

  // 5) sessionKey — identityKey 기본 ''.
  {
    const enc = new AesGcmSessionEncryptor(Buffer.alloc(32, 7), "session-kid-1");
    const plain = Buffer.from(JSON.stringify({ cookies: [{ name: "secure", value: "1" }] }), "utf8");
    const { ciphertext, kid } = enc.encrypt(plain);
    const back = enc.decrypt(ciphertext, kid);
    check("AES-GCM encryptor 라운드트립 + ciphertext 비평문", kid === "session-kid-1" && back.equals(plain) && !ciphertext.equals(plain));
    const tampered = Buffer.from(ciphertext);
    tampered[tampered.length - 1] ^= 1;
    const err = caught(() => { enc.decrypt(tampered, kid); });
    check("AES-GCM tamper → decrypt throw", err !== undefined);
  }

  // 6) sessionKey — identityKey 기본 ''.
  {
    const k = sessionKey("t1", "s1", "b1");
    check("sessionKey identityKey 기본 ''", k.identityKey === "" && k.tenantId === "t1" && k.siteProfileId === "s1" && k.browserIdentityId === "b1");
  }

  if (failures > 0) {
    console.error(`\nFAIL: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nPASS: BrowserSessionStore fail-closed 게이트 + 암호화기 green");
  process.exit(0);
}

main().catch((e) => {
  console.error("unit fatal:", e);
  process.exit(1);
});
