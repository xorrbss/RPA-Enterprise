/**
 * 통합 — POST /v1/sites/{id}/session/capture/complete (P3, 운영자-로컬 캡처 완료). 실 PostgreSQL.
 *
 * 실행(temp PG15 게이트):
 *   node scripts/db-temp-postgres-gate.mjs -- npx tsx app/test/api-sessions-capture-complete.int.ts
 * 검증: 캡처 완료 → 200 captured + browser_sessions 봉투 저장(load 가능) + capture_sessions status CAS, 멱등 replay,
 *       404(미존재 capture), 422(비-active capture·malformed body·멱등키 누락), RBAC(viewer→403), cross-tenant 격리,
 *       sessionStore 미주입 시 라우트 미등록(404).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { SignJWT } from "jose";

import { JwtAuthenticationBoundary, hmacJwtVerifier } from "../src/api/auth";
import { PgControlPlaneIdempotencyStore } from "../src/api/idempotency";
import { RoleMatrixRbacMiddleware } from "../src/api/rbac";
import type { RunEnqueuer } from "../src/api/run-queue";
import { buildServer } from "../src/api/server";
import { createPool, withTenantTx } from "../src/db/pool";
import { PgBrowserSessionStore, DevPlaintextSessionEncryptor, sessionKey } from "../src/runtime/browser-session-store";
import type { SecretRef } from "../../ts/core-types";
import type { SignedCommandRegistry } from "../../ts/security-middleware-contract";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCHEMA = "rpa_capture_complete_int";
const TENANT_A = "00000000-0000-0000-0000-0000000000a1";
const TENANT_B = "00000000-0000-0000-0000-0000000000b2";
const SITE = "70000000-0000-0000-0000-0000000000c1";
const BID = "9b000000-0000-0000-0000-0000000000c2";
const CAP = "c0000000-0000-0000-0000-0000000000c3";
const CAP_EXPIRED = "c0000000-0000-0000-0000-0000000000c4";

const SECRET = new TextEncoder().encode("capture-complete-int-secret-do-not-use-in-prod-0123456789");
const signedCommandRegistry: SignedCommandRegistry = {
  async listAllowedCommandRefs() {
    return { kind: "available", snapshot: { sourceRef: "secret://staging/registry" as SecretRef, commands: [] } };
  },
};

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}
const mint = (claims: Record<string, unknown>): Promise<string> =>
  new SignJWT(claims).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("5m").sign(SECRET);

type Pool = ReturnType<typeof createPool>;

async function main(): Promise<void> {
  const pool = createPool({ options: `-c search_path=${SCHEMA},public` });
  const store = new PgBrowserSessionStore({ pool, encryptor: new DevPlaintextSessionEncryptor() }, { allowDevPlaintext: true });
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
    // 시드: 사이트 + browser_identity + capture_sessions(awaiting_login, 그리고 expired 1건).
    await withTenantTx(pool, TENANT_A, async (c) => {
      await c.query(`INSERT INTO site_profiles (id, tenant_id, name, url_pattern, risk) VALUES ($1,$2,'cap site','https://x.example','green')`, [SITE, TENANT_A]);
      await c.query(`INSERT INTO browser_identities (id, tenant_id, site_profile_id, label, version) VALUES ($1,$2,$3,'id',1)`, [BID, TENANT_A, SITE]);
      await c.query(`INSERT INTO capture_sessions (id, tenant_id, site_profile_id, browser_identity_id, login_url, status) VALUES ($1,$2,$3,$4,'https://login.x','awaiting_login')`, [CAP, TENANT_A, SITE, BID]);
      await c.query(`INSERT INTO capture_sessions (id, tenant_id, site_profile_id, browser_identity_id, login_url, status) VALUES ($1,$2,$3,$4,'https://login.x','expired')`, [CAP_EXPIRED, TENANT_A, SITE, BID]);
    });

    const noopEnqueuer: RunEnqueuer = { async enqueueRunClaim() {}, async enqueueRunAbort() {}, async enqueueSinkDeliver() {} };
    const baseDeps = {
      pool,
      auth: new JwtAuthenticationBoundary(hmacJwtVerifier(SECRET)),
      rbac: new RoleMatrixRbacMiddleware(),
      idempotency: new PgControlPlaneIdempotencyStore(pool),
      enqueuer: noopEnqueuer,
      signedCommandRegistry,
    };
    const app = buildServer({ ...baseDeps, sessionStore: store });
    const appNoStore = buildServer(baseDeps); // sessionStore 미주입 → 라우트 미등록
    await app.ready();
    await appNoStore.ready();
    try {
      const operator = await mint({ sub: "11111111-0000-0000-0000-000000000001", tenant_id: TENANT_A, roles: ["operator"] });
      const viewer = await mint({ sub: "v1", tenant_id: TENANT_A, roles: ["viewer"] });
      const operatorB = await mint({ sub: "11111111-0000-0000-0000-0000000000b1", tenant_id: TENANT_B, roles: ["operator"] });
      const cookies = [{ name: "sess", value: "secret-cookie-val", domain: ".x.example", path: "/" }];
      const post = (token: string, target: typeof app, key: string | undefined, body: Record<string, unknown>) =>
        target
          .inject({
            method: "POST",
            url: `/v1/sites/${SITE}/session/capture/complete`,
            headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(key !== undefined ? { "idempotency-key": key } : {}) },
            payload: body,
          })
          .then((r) => r);

      // 1) operator 캡처 완료 → 200 captured.
      const r1 = await post(operator, app, "key1", { capture_session_id: CAP, cookies });
      check("operator capture/complete → 200 captured", r1.statusCode === 200 && JSON.parse(r1.body).status === "captured", `${r1.statusCode} ${r1.body}`);

      // 2) browser_sessions 봉투 저장 + load 가능(쿠키 라운드트립).
      const loaded = await withTenantTx(pool, TENANT_A, () => store.load(sessionKey(TENANT_A, SITE, BID)));
      check("browser_sessions 봉투 저장·load(쿠키 라운드트립)", loaded !== null && loaded.cookies.length === 1 && loaded.cookies[0]?.value === "secret-cookie-val", JSON.stringify(loaded));

      // 3) capture_sessions status CAS=captured.
      const st = await withTenantTx(pool, TENANT_A, async (c) => (await c.query<{ status: string }>(`SELECT status FROM capture_sessions WHERE id=$1::uuid`, [CAP])).rows[0]?.status);
      check("capture_sessions status=captured", st === "captured", st);

      // 4) 멱등 replay(동일 키) → 200 동일.
      const r2 = await post(operator, app, "key1", { capture_session_id: CAP, cookies });
      check("멱등 replay → 200 captured(동일)", r2.statusCode === 200 && JSON.parse(r2.body).status === "captured");

      // 5) 미존재 capture → 404.
      const r404 = await post(operator, app, "key2", { capture_session_id: "c0000000-0000-0000-0000-0000000000ff", cookies });
      check("미존재 capture_session → 404", r404.statusCode === 404);

      // 6) 비-active(expired) capture → 422 거부(조용한 덮어쓰기 금지).
      const rExp = await post(operator, app, "key3", { capture_session_id: CAP_EXPIRED, cookies });
      check("expired capture/complete → 422(거부)", rExp.statusCode === 422, `${rExp.statusCode} ${rExp.body}`);

      // 7) viewer → 403(RBAC).
      const rViewer = await post(viewer, app, "key4", { capture_session_id: CAP, cookies });
      check("viewer capture/complete → 403", rViewer.statusCode === 403);

      // 8) malformed body(쿠키 없음) → 422.
      const rBad = await post(operator, app, "key5", { capture_session_id: CAP });
      check("쿠키 없는 body → 422", rBad.statusCode === 422);

      // 9) 멱등키 누락 → 422.
      const rNoKey = await post(operator, app, undefined, { capture_session_id: CAP, cookies });
      check("멱등키 누락 → 422", rNoKey.statusCode === 422, `${rNoKey.statusCode}`);

      // 10) cross-tenant(테넌트 B operator가 A의 capture) → 404(RLS 비노출).
      const rXt = await post(operatorB, app, "key6", { capture_session_id: CAP, cookies });
      check("cross-tenant capture → 404", rXt.statusCode === 404);

      // 11) sessionStore 미주입 앱 → 라우트 미등록(404, 메서드 없음).
      const rNoStore = await post(operator, appNoStore, "key7", { capture_session_id: CAP, cookies });
      check("sessionStore 미주입 → 라우트 미등록(404)", rNoStore.statusCode === 404);
    } finally {
      await app.close();
      await appNoStore.close();
    }

    if (failures > 0) {
      console.error(`\nFAIL: ${failures} check(s) failed`);
      process.exit(1);
    }
    console.log("\nPASS: POST /v1/sites/{id}/session/capture/complete integration green");
    process.exit(0);
  } finally {
    await pool.end().catch(() => undefined);
  }
}

main().catch((e) => {
  console.error("capture-complete int fatal:", e);
  process.exit(1);
});
