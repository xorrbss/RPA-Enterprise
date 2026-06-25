/**
 * BrowserSessionStore 컨텍스트 바인딩 통합 (적대감사 #C2 — at-rest cross-identity 세션 치환 방어). 실 PostgreSQL.
 *
 * 봉투암호화 평문에 세션 컨텍스트 태그(tenant|site|identity|identityKey)를 포함하므로 GCM 인증 태그가 ctx 까지 보호한다.
 * at-rest 에서 ciphertext 를 다른 행(다른 정체성, 동일 kid/key)으로 옮겨도 load 의 ctx 검증이 cross-identity 치환을 거부한다.
 * 복호 실패(변조·손상)·레거시(ctx 없는) ciphertext 는 cold start(null) — 조용한 잘못된 세션 금지.
 *
 * 실행: node scripts/db-temp-postgres-gate.mjs -- npx tsx app/test/browser-session-store.int.ts
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createPool, withTenantTx } from "../src/db/pool";
import { AesGcmSessionEncryptor, PgBrowserSessionStore, sessionKey } from "../src/runtime/browser-session-store";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCHEMA = "rpa_bsession_store_int";
const TENANT = "00000000-0000-0000-0000-0000000000e1";
const SITE = "40000000-0000-0000-0000-000000000f31";
const IDENTITY_A = "40000000-0000-0000-0000-000000000f32";
const IDENTITY_B = "40000000-0000-0000-0000-000000000f33";

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

async function main(): Promise<void> {
  const pool = createPool({ options: `-c search_path=${SCHEMA},public` });
  const encryptor = new AesGcmSessionEncryptor(Buffer.alloc(32, 7), "session-kid-1");
  const store = new PgBrowserSessionStore({ pool, encryptor });
  try {
    const setup = await pool.connect();
    try {
      await setup.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
      await setup.query(`CREATE SCHEMA ${SCHEMA}`);
      await setup.query(`SET search_path = ${SCHEMA}, public`);
      await setup.query(readFileSync(`${ROOT}db/migration_concurrency_idempotency.sql`, "utf8"));
      await setup.query(readFileSync(`${ROOT}db/migration_core_entities.sql`, "utf8"));
    } finally {
      setup.release();
    }
    await withTenantTx(pool, TENANT, async (c) => {
      await c.query(`INSERT INTO site_profiles (id, tenant_id, name, url_pattern, risk, approved) VALUES ($1,$2,'ok','https://ok.example/*','green',true)`, [SITE, TENANT]);
      await c.query(`INSERT INTO browser_identities (id, tenant_id, site_profile_id, label) VALUES ($1,$2,$3,'A'),($4,$2,$3,'B')`, [IDENTITY_A, TENANT, SITE, IDENTITY_B]);
    });

    const keyA = sessionKey(TENANT, SITE, IDENTITY_A);
    const keyB = sessionKey(TENANT, SITE, IDENTITY_B);

    // 1) 동일 키 라운드트립 — ctx 일치 → 쿠키 복원.
    await store.save(keyA, { cookies: [{ name: "sess", value: "A" } as never] });
    const a = await store.load(keyA);
    check("동일 키 라운드트립 → 쿠키 복원", a !== null && a.cookies.length === 1 && (a.cookies[0] as { value?: string }).value === "A", JSON.stringify(a));

    // 2) cross-identity 치환: A 행 ciphertext 를 B 행으로 복사(동일 kid/key) → load(B) 거부(ctx 불일치 → null).
    await withTenantTx(pool, TENANT, async (c) => {
      const row = await c.query<{ ciphertext: Buffer; enc_kid: string }>(
        `SELECT ciphertext, enc_kid FROM browser_sessions WHERE tenant_id=$1::uuid AND browser_identity_id=$2::uuid`, [TENANT, IDENTITY_A],
      );
      await c.query(
        `INSERT INTO browser_sessions (tenant_id, site_profile_id, browser_identity_id, identity_key, ciphertext, enc_kid, session_generation, created_at, updated_at)
         VALUES ($1::uuid,$2::uuid,$3::uuid,'',$4,$5,1,now(),now())`,
        [TENANT, SITE, IDENTITY_B, row.rows[0]!.ciphertext, row.rows[0]!.enc_kid],
      );
    });
    const b = await store.load(keyB);
    check("cross-identity 치환(A→B ciphertext 이동) → load(B) 거부(null)", b === null, JSON.stringify(b));

    // 3) 변조 ciphertext → 복호 실패 → cold start(null, throw 아님).
    await withTenantTx(pool, TENANT, async (c) => {
      await c.query(`UPDATE browser_sessions SET ciphertext = set_byte(ciphertext, length(ciphertext)-1, (get_byte(ciphertext, length(ciphertext)-1) # 1)) WHERE tenant_id=$1::uuid AND browser_identity_id=$2::uuid`, [TENANT, IDENTITY_A]);
    });
    let threw = false;
    let tampered: unknown = "unset";
    try { tampered = await store.load(keyA); } catch { threw = true; }
    check("변조 ciphertext → cold start(null) (throw 아님)", threw === false && tampered === null, `threw=${threw} val=${JSON.stringify(tampered)}`);

    // 4) 레거시(ctx 없는 평문) ciphertext → cold start(null).
    await withTenantTx(pool, TENANT, async (c) => {
      const legacy = encryptor.encrypt(Buffer.from(JSON.stringify({ cookies: [{ name: "x", value: "1" }] }), "utf8"));
      await c.query(`UPDATE browser_sessions SET ciphertext=$3, enc_kid=$4 WHERE tenant_id=$1::uuid AND browser_identity_id=$2::uuid`, [TENANT, IDENTITY_A, legacy.ciphertext, legacy.kid]);
    });
    const legacyLoad = await store.load(keyA);
    check("레거시(ctx 없는) ciphertext → cold start(null)", legacyLoad === null, JSON.stringify(legacyLoad));
  } finally {
    await pool.end();
  }

  if (failures > 0) {
    console.error(`\nFAIL: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nPASS: BrowserSessionStore 컨텍스트 바인딩 — 동일키 라운드트립 + cross-identity 치환/변조/레거시 거부 (적대감사 #C2)");
  process.exit(0);
}

main().catch((e) => {
  console.error("browser-session-store int fatal:", e);
  process.exit(1);
});
