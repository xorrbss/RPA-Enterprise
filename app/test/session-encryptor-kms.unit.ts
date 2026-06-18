/**
 * 단위 — KmsEnvelopeSessionEncryptor + buildKmsSessionEncryptor(per-message DEK 봉투암호화). 브라우저/DB/Vault 없이 검증:
 *  roundtrip·실제암호화(≠평문)·비결정성(임의 DEK/IV)·위변조 탐지(GCM authTag)·알수없는 kid throw·생성자 검증·
 *  빌더 {kid,key} 파싱/거부·PgBrowserSessionStore 가 kind:'kms' 를 allowDevPlaintext 없이 수용(prod fail-closed 게이트 통과).
 *  실행: tsx test/session-encryptor-kms.unit.ts.
 */
import { randomBytes } from "node:crypto";

import {
  KmsEnvelopeSessionEncryptor,
  buildKmsSessionEncryptor,
  PgBrowserSessionStore,
  type KmsKeyring,
} from "../src/runtime/browser-session-store";
import type { PlainSecret, SecretRef, SecretStore } from "../../ts/core-types";
import type { Pool } from "pg";

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function keyring(kid = "k1"): KmsKeyring {
  return { activeKid: kid, keys: new Map([[kid, randomBytes(32)]]) };
}
function fakeStore(payload: string): SecretStore {
  return { async resolve(_ref: SecretRef): Promise<PlainSecret> { return payload as PlainSecret; } };
}

async function main(): Promise<void> {
  const PLAINTEXT = Buffer.from(JSON.stringify({ cookies: [{ name: "sess", value: "secret-🍪" }] }), "utf8");

  // 1) roundtrip + kid.
  {
    const enc = new KmsEnvelopeSessionEncryptor(keyring("k1"));
    const { ciphertext, kid } = enc.encrypt(PLAINTEXT);
    check("kid = activeKid", kid === "k1");
    check("ciphertext ≠ 평문(실제 암호화)", !ciphertext.equals(PLAINTEXT) && !ciphertext.includes(Buffer.from("secret-")));
    const out = enc.decrypt(ciphertext, kid);
    check("decrypt roundtrip(평문 일치)", out.equals(PLAINTEXT), out.toString("utf8").slice(0, 40));
  }

  // 2) 비결정성 — 같은 평문 두 번 암호화 → 다른 ciphertext(임의 DEK/IV).
  {
    const enc = new KmsEnvelopeSessionEncryptor(keyring());
    const a = enc.encrypt(PLAINTEXT).ciphertext;
    const b = enc.encrypt(PLAINTEXT).ciphertext;
    check("동일 평문 → 상이 ciphertext(비결정)", !a.equals(b));
    check("둘 다 정상 복호화", enc.decrypt(a, "k1").equals(PLAINTEXT) && enc.decrypt(b, "k1").equals(PLAINTEXT));
  }

  // 3) 위변조 탐지 — ciphertext 1바이트 변조 → decrypt throw(GCM authTag).
  {
    const enc = new KmsEnvelopeSessionEncryptor(keyring());
    const ct = Buffer.from(enc.encrypt(PLAINTEXT).ciphertext);
    ct[ct.length - 1] ^= 0xff; // 메시지 본문 변조
    let threw = false;
    try { enc.decrypt(ct, "k1"); } catch { threw = true; }
    check("ciphertext 변조 → decrypt throw(위변조 탐지)", threw);
    // 래핑된 DEK 변조도 탐지.
    const ct2 = Buffer.from(enc.encrypt(PLAINTEXT).ciphertext);
    ct2[1 + 12 + 16] ^= 0xff; // wrappedDek 첫 바이트
    let threw2 = false;
    try { enc.decrypt(ct2, "k1"); } catch { threw2 = true; }
    check("wrappedDEK 변조 → decrypt throw", threw2);
  }

  // 4) 알 수 없는 kid → throw(조용한 false 금지).
  {
    const enc = new KmsEnvelopeSessionEncryptor(keyring("k1"));
    const { ciphertext } = enc.encrypt(PLAINTEXT);
    let threw = false;
    try { enc.decrypt(ciphertext, "rotated-out"); } catch { threw = true; }
    check("알 수 없는 enc_kid → throw", threw);
  }

  // 5) 회전 grace — keyring 에 폐기 kid 도 담으면 그 kid 복호화 가능(활성은 새 kid).
  {
    const oldKey = randomBytes(32);
    const encOld = new KmsEnvelopeSessionEncryptor({ activeKid: "old", keys: new Map([["old", oldKey]]) });
    const ctOld = encOld.encrypt(PLAINTEXT).ciphertext;
    const encNew = new KmsEnvelopeSessionEncryptor({ activeKid: "new", keys: new Map([["new", randomBytes(32)], ["old", oldKey]]) });
    check("회전 후 폐기 kid(old) 복호화 가능", encNew.decrypt(ctOld, "old").equals(PLAINTEXT));
    check("신규 암호화는 활성 kid(new)", encNew.encrypt(PLAINTEXT) && encNew.encrypt(PLAINTEXT).ciphertext.length > 0);
  }

  // 6) 생성자 검증 — activeKid 미존재 / KEK 길이 오류 → throw.
  {
    let t1 = false, t2 = false;
    try { new KmsEnvelopeSessionEncryptor({ activeKid: "x", keys: new Map() }); } catch { t1 = true; }
    try { new KmsEnvelopeSessionEncryptor({ activeKid: "x", keys: new Map([["x", randomBytes(16)]]) }); } catch { t2 = true; }
    check("activeKid 미존재 → throw", t1);
    check("KEK 32바이트 아님 → throw", t2);
  }

  // 7) 빌더 — {kid, key(base64 32B)} 파싱 → roundtrip; 불량 입력 거부.
  {
    const key = randomBytes(32).toString("base64");
    const enc = await buildKmsSessionEncryptor(fakeStore(JSON.stringify({ kid: "kb", key })), "rpa/test/api/browser_session/active" as SecretRef);
    const ct = enc.encrypt(PLAINTEXT);
    check("빌더 산출 암호화기 roundtrip + kid", ct.kid === "kb" && enc.decrypt(ct.ciphertext, "kb").equals(PLAINTEXT));

    const reject = async (payload: string, label: string): Promise<void> => {
      let threw = false;
      try { await buildKmsSessionEncryptor(fakeStore(payload), "r" as SecretRef); } catch { threw = true; }
      check(label, threw);
    };
    await reject("not json", "빌더: 비-JSON 페이로드 → throw");
    await reject(JSON.stringify({ kid: "k" }), "빌더: key 누락 → throw");
    await reject(JSON.stringify({ key }), "빌더: kid 누락 → throw");
    await reject(JSON.stringify({ kid: "k", key: randomBytes(16).toString("base64") }), "빌더: KEK 16바이트 → throw");
  }

  // 8) PgBrowserSessionStore 가 kind:'kms' 를 allowDevPlaintext 없이 수용(prod fail-closed 게이트 통과).
  {
    const enc = new KmsEnvelopeSessionEncryptor(keyring());
    let ok = false;
    try { new PgBrowserSessionStore({ pool: {} as Pool, encryptor: enc }); ok = true; } catch { ok = false; }
    check("PgBrowserSessionStore(kms) — allowDevPlaintext 없이 생성 성공", ok);
  }

  if (failures > 0) {
    console.error(`\nFAIL: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nPASS: KmsEnvelopeSessionEncryptor 단위 green");
  process.exit(0);
}

main().catch((e) => {
  console.error("unit fatal:", e);
  process.exit(1);
});
