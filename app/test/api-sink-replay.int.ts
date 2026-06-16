/**
 * 통합 테스트 — sink-DLQ replay 라우트(api-surface §4, release-decisions D8-A3).
 *   POST /v1/dlq/{id}/replay?kind=sink → 새 sink_deliver attempt 인큐(상태전이 아님), 202(accepted).
 *
 * 실행(temp PG15 게이트):
 *   node scripts/db-temp-postgres-gate.mjs -- npm --prefix app exec tsx -- app/test/api-sink-replay.int.ts
 *
 * 검증: operator 202 + sink_deliver 인큐(normalizedRecordId·sinkConfigId), viewer 403(키 미소모·미인큐),
 *   cross-tenant 404(RLS), dead_letter 아님(delivered/미존재) 404, kind 무효 422, Idempotency-Key 누락 422,
 *   멱등 재생(동일 키 → 인큐 1회), kind=workitem 회귀(기본 경로 무결). 실 재전달은 worker egress 의존(범위 밖).
 *   in-handler sink_dlq.replay 인가 게이트(RQ-028): viewer 거부는 preHandler(dlq.replay)에서 먼저 막혀
 *   in-handler deny 분기가 미도달이고, 실 매트릭스는 두 액션 역할집합이 동일(D8-A3)이라 어떤 역할로도 도달
 *   불가 → 분기 RBAC(dlq.replay allow / sink_dlq.replay deny)로 그 분기를 구동(403·미소모·미인큐) + 동일
 *   RBAC의 workitem 통과(202)로 403이 in-handler 고유임을 증명한다.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { SignJWT } from "jose";

import { JwtAuthenticationBoundary, hmacJwtVerifier } from "../src/api/auth";
import { PgControlPlaneIdempotencyStore } from "../src/api/idempotency";
import { RoleMatrixRbacMiddleware } from "../src/api/rbac";
import type { RunEnqueuer, SinkDeliverEnqueueInput } from "../src/api/run-queue";
import { buildServer } from "../src/api/server";
import { createPool, withTenantTx } from "../src/db/pool";
import { ingestRawItem } from "../src/runtime/pipeline/raw-ingest";
import { normalizeRecord } from "../src/runtime/pipeline/normalize";
import { deliverNormalizedRecord } from "../src/runtime/pipeline/sink-delivery";
import type { SecretRef } from "../../ts/core-types";
import {
  SINK_DELIVERY_LOCAL_TEST_SCHEMA_REF,
  type SinkDeliveryDecision,
  type SinkDeliveryPort,
  type SinkDeliveryRequest,
} from "../../ts/runtime-contract";
import type {
  AuthenticatedPrincipal,
  AuthorizationCheck,
  AuthorizationDecision,
  RbacMiddleware,
  SignedCommandRegistry,
} from "../../ts/security-middleware-contract";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCHEMA = "rpa_sink_replay_int";

const TENANT_A = "00000000-0000-0000-0000-0000000000a1";
const TENANT_B = "00000000-0000-0000-0000-0000000000b2";
const ABSENT = "60000000-0000-0000-0000-0000000000ff";
const SINK_CONFIG = "50000000-0000-0000-0000-000000000001";
const SCHEMA_REF = "schemas/review@1";
const CORR = "70000000-0000-0000-0000-000000000001";

// workitem 회귀용.
const WI_ABANDONED = "61000000-0000-0000-0000-000000000001";
const DL_WORKITEM = "63000000-0000-0000-0000-000000000001";
// RQ-028 split-RBAC 검증용(다른 테스트와 독립한 별도 행).
const WI_SPLIT = "61000000-0000-0000-0000-000000000002";
const DL_WI_SPLIT = "63000000-0000-0000-0000-000000000002";

const SECRET = new TextEncoder().encode("sink-replay-int-secret-do-not-use-in-prod-0123456789");
const signedCommandRegistry: SignedCommandRegistry = {
  async listAllowedCommandRefs() {
    return { kind: "available", snapshot: { sourceRef: "secret://staging/registry" as SecretRef, commands: [] } };
  },
};

// RQ-028: in-handler sink_dlq.replay 인가 게이트(dlq.ts)를 구동하는 분기 RBAC test double.
//   실 매트릭스(D8-A3, rbac.ts)는 dlq.replay와 sink_dlq.replay의 역할집합이 동일해, preHandler(dlq.replay)를
//   통과한 어떤 principal도 in-handler(sink_dlq.replay)에서 거부되지 않는다 → 게이트 deny 분기가 도달 불가.
//   이 double은 dlq.replay만 allow / sink_dlq.replay만 deny해 그 분기를 명시 구동한다(다른 액션은 평가 안 함).
class SplitSinkDenyRbac implements RbacMiddleware {
  async authorize(principal: AuthenticatedPrincipal, check: AuthorizationCheck): Promise<AuthorizationDecision> {
    if (check.action === "sink_dlq.replay") {
      return { kind: "deny", action: "sink_dlq.replay", code: "AUTHZ_FORBIDDEN", reason: "rq028_split_deny" };
    }
    return { kind: "allow", principal, action: check.action };
  }
}

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function mint(claims: Record<string, unknown>): Promise<string> {
  return new SignJWT(claims).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("5m").sign(SECRET);
}

type Pool = ReturnType<typeof createPool>;

class FakeSinkPort implements SinkDeliveryPort {
  readonly binding = {
    kind: "test_fake" as const,
    backendAlias: "local-test-fake" as const,
    evidenceSchemaRef: SINK_DELIVERY_LOCAL_TEST_SCHEMA_REF,
    testOnly: true as const,
  };
  constructor(private readonly behavior: (req: SinkDeliveryRequest) => SinkDeliveryDecision) {}
  async deliver(input: SinkDeliveryRequest): Promise<SinkDeliveryDecision> {
    return this.behavior(input);
  }
}

async function seedNormalized(pool: Pool, tenant: string, naturalKey: string): Promise<string> {
  return withTenantTx(pool, tenant, async (c) => {
    const raw = await ingestRawItem(c, {
      tenantId: tenant, connectorId: "reviews", targetId: "20000000-0000-0000-0000-0000000000e1",
      sourceItemKey: naturalKey, collectionAttemptId: "40000000-0000-0000-0000-0000000000aa",
      rawPayload: { nk: naturalKey }, correlationId: CORR,
    });
    const norm = await normalizeRecord(c, {
      tenantId: tenant, rawItemId: raw.rawItemId, schemaRef: SCHEMA_REF, naturalKey,
      record: { nk: naturalKey }, dedupAction: "insert",
    });
    return norm.normalizedRecordId;
  });
}

/** dead_letter sink 행 시드: maxAttempts=1 + transient_failed → 첫 attempt가 dead_letter. */
async function seedSinkDeadLetter(pool: Pool, tenant: string, naturalKey: string): Promise<{ id: string; nr: string }> {
  const nr = await seedNormalized(pool, tenant, naturalKey);
  const out = await deliverNormalizedRecord(
    { pool, port: new FakeSinkPort(() => ({ kind: "transient_failed", reason: "seed dead_letter" })), policy: { source: "ops-defaults.md#sink.delivery", maxAttempts: 1 } },
    { tenantId: tenant, normalizedRecordId: nr, sinkConfigId: SINK_CONFIG, correlationId: CORR },
  );
  if (out.status !== "dead_letter" || out.sinkDeliveryId === undefined) {
    throw new Error(`seedSinkDeadLetter expected dead_letter, got ${out.status}`);
  }
  return { id: out.sinkDeliveryId, nr };
}

/** delivered sink 행 시드(= DLQ에 없음). */
async function seedSinkDelivered(pool: Pool, tenant: string, naturalKey: string): Promise<string> {
  const nr = await seedNormalized(pool, tenant, naturalKey);
  const out = await deliverNormalizedRecord(
    { pool, port: new FakeSinkPort(() => ({ kind: "delivered", receiptRef: "rcpt" })), policy: { source: "ops-defaults.md#sink.delivery", maxAttempts: 2 } },
    { tenantId: tenant, normalizedRecordId: nr, sinkConfigId: SINK_CONFIG, correlationId: CORR },
  );
  if (out.status !== "delivered" || out.sinkDeliveryId === undefined) {
    throw new Error(`seedSinkDelivered expected delivered, got ${out.status}`);
  }
  return out.sinkDeliveryId;
}

async function idemRowCount(pool: Pool, key: string): Promise<number> {
  return withTenantTx(pool, TENANT_A, async (c) => {
    const r = await c.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM control_plane_idempotency_keys WHERE endpoint='replaySinkDeadLetter' AND idempotency_key=$1`,
      [key],
    );
    return r.rows[0]?.n ?? 0;
  });
}

async function main(): Promise<void> {
  const pool = createPool({ options: `-c search_path=${SCHEMA},public` });
  try {
    const concurrencySql = readFileSync(`${ROOT}db/migration_concurrency_idempotency.sql`, "utf8");
    const coreSql = readFileSync(`${ROOT}db/migration_core_entities.sql`, "utf8");
    const setup = await pool.connect();
    try {
      await setup.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
      await setup.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
      await setup.query(`SET search_path = ${SCHEMA}, public`);
      await setup.query(concurrencySql);
      await setup.query(coreSql);
    } finally {
      setup.release();
    }
    console.log("migrations applied (concurrency → core)");

    const dlOk = await seedSinkDeadLetter(pool, TENANT_A, "nk-ok");
    const dlViewer = await seedSinkDeadLetter(pool, TENANT_A, "nk-viewer");
    const dlIdem = await seedSinkDeadLetter(pool, TENANT_A, "nk-idem");
    const dlDelivered = await seedSinkDelivered(pool, TENANT_A, "nk-delivered");
    const dlB = await seedSinkDeadLetter(pool, TENANT_B, "nk-b");
    const dlSplit = await seedSinkDeadLetter(pool, TENANT_A, "nk-split"); // RQ-028 in-handler deny 대상.
    // workitem 회귀용 dead_letter(abandoned workitem). WI_SPLIT은 RQ-028 split-RBAC가 preHandler를 통과함을 보일 행.
    await withTenantTx(pool, TENANT_A, (c) =>
      c.query(
        `INSERT INTO workitems (id, tenant_id, connector_id, unique_reference, status, attempts)
         VALUES ($1,$2,'sinkrepl','wi-abandoned','abandoned',4), ($3,$2,'sinkrepl','wi-split','abandoned',4)`,
        [WI_ABANDONED, TENANT_A, WI_SPLIT],
      ),
    );
    await withTenantTx(pool, TENANT_A, (c) =>
      c.query(
        `INSERT INTO dead_letter (id, tenant_id, workitem_id, reason_code, replayable)
         VALUES ($1,$2,$3,'WORKITEM_CHECKOUT_CONFLICT',true), ($4,$2,$5,'WORKITEM_CHECKOUT_CONFLICT',true)`,
        [DL_WORKITEM, TENANT_A, WI_ABANDONED, DL_WI_SPLIT, WI_SPLIT],
      ),
    );
    console.log("seeded sink dead-letters + delivered + workitem dl");

    const sinkEnqueued: SinkDeliverEnqueueInput[] = [];
    const enqueuer: RunEnqueuer = {
      async enqueueRunClaim() {},
      async enqueueRunAbort() {},
      async enqueueSinkDeliver(_client, input) {
        sinkEnqueued.push(input);
      },
    };
    const app = buildServer({
      pool,
      auth: new JwtAuthenticationBoundary(hmacJwtVerifier(SECRET)),
      rbac: new RoleMatrixRbacMiddleware(),
      idempotency: new PgControlPlaneIdempotencyStore(pool),
      enqueuer,
      signedCommandRegistry,
    });
    await app.ready();
    try {
      const op = await mint({ sub: "op", tenant_id: TENANT_A, roles: ["operator"] });
      const viewer = await mint({ sub: "vi", tenant_id: TENANT_A, roles: ["viewer"] });

      const sinkReplay = (id: string, key: string, token = op) =>
        app.inject({
          method: "POST",
          url: `/v1/dlq/${id}/replay?kind=sink`,
          headers: { authorization: `Bearer ${token}`, "idempotency-key": key },
        });

      // 1) operator sink replay → 202 enqueued + sink_deliver 인큐(정확한 식별자).
      const r1 = await sinkReplay(dlOk.id, "sink-ok");
      check("operator sink replay → 202", r1.statusCode === 202, r1.body);
      check("body kind=sink, status=enqueued", r1.json().kind === "sink" && r1.json().status === "enqueued", r1.body);
      check("one sink_deliver enqueued", sinkEnqueued.length === 1, JSON.stringify(sinkEnqueued));
      check(
        "enqueue carries normalizedRecordId + sinkConfigId",
        sinkEnqueued[0]?.normalizedRecordId === dlOk.nr && sinkEnqueued[0]?.sinkConfigId === SINK_CONFIG,
        JSON.stringify(sinkEnqueued[0]),
      );

      // 2) viewer → 403 AUTHZ_FORBIDDEN(키 미소모·미인큐).
      const r2 = await sinkReplay(dlViewer.id, "sink-viewer", viewer);
      check("viewer sink replay → 403 AUTHZ_FORBIDDEN", r2.statusCode === 403 && r2.json().code === "AUTHZ_FORBIDDEN", r2.body);
      check("viewer deny key unused", (await idemRowCount(pool, "sink-viewer")) === 0);
      check("viewer deny did not enqueue", sinkEnqueued.length === 1);

      // 3) cross-tenant → 404(RLS 은닉·미인큐).
      const r3 = await sinkReplay(dlB.id, "sink-cross");
      check("cross-tenant sink replay → 404", r3.statusCode === 404 && r3.json().code === "RESOURCE_NOT_FOUND", r3.body);
      check("cross-tenant did not enqueue", sinkEnqueued.length === 1);

      // 4) 미존재 id → 404.
      const r4 = await sinkReplay(ABSENT, "sink-absent");
      check("absent sink id → 404", r4.statusCode === 404 && r4.json().code === "RESOURCE_NOT_FOUND", r4.body);

      // 5) delivered(=DLQ 아님) → 404(상태 dead_letter만 replay 대상).
      const r5 = await sinkReplay(dlDelivered, "sink-delivered");
      check("delivered (not dead_letter) → 404", r5.statusCode === 404 && r5.json().code === "RESOURCE_NOT_FOUND", r5.body);
      check("delivered did not enqueue", sinkEnqueued.length === 1);

      // 6) kind 무효 → 422 invalid_kind.
      const r6 = await app.inject({
        method: "POST",
        url: `/v1/dlq/${dlOk.id}/replay?kind=bogus`,
        headers: { authorization: `Bearer ${op}`, "idempotency-key": "sink-badkind" },
      });
      check("invalid kind → 422 IR_SCHEMA_INVALID", r6.statusCode === 422 && r6.json().code === "IR_SCHEMA_INVALID", r6.body);
      check("invalid kind reason", r6.json().details?.reason === "invalid_kind", r6.body);

      // 7) Idempotency-Key 누락(kind=sink) → 422.
      const r7 = await app.inject({
        method: "POST",
        url: `/v1/dlq/${dlOk.id}/replay?kind=sink`,
        headers: { authorization: `Bearer ${op}` },
      });
      check("missing Idempotency-Key → 422", r7.statusCode === 422 && r7.json().code === "IR_SCHEMA_INVALID", r7.body);

      // 8) 멱등 재생: 동일 키 두 번 → 둘 다 202, 인큐는 1회(work 미재실행).
      const enqueuedBefore = sinkEnqueued.length;
      const i1 = await sinkReplay(dlIdem.id, "sink-idem");
      const i2 = await sinkReplay(dlIdem.id, "sink-idem");
      check("idem first → 202", i1.statusCode === 202, i1.body);
      check("idem replay → 202 (same)", i2.statusCode === 202, i2.body);
      check("idempotent replay enqueues once", sinkEnqueued.length === enqueuedBefore + 1, JSON.stringify(sinkEnqueued));

      // 9) kind=workitem 회귀: 기본 경로(상태전이 W10) 무결 — abandoned dead_letter → 202 new.
      const w1 = await app.inject({
        method: "POST",
        url: `/v1/dlq/${DL_WORKITEM}/replay`,
        headers: { authorization: `Bearer ${op}`, "idempotency-key": "wi-regression" },
      });
      check("workitem replay (default kind) → 202 new", w1.statusCode === 202 && w1.json().status === "new", w1.body);

      // 10) RQ-028: in-handler sink_dlq.replay 인가 게이트(dlq.ts:50-61) 검증 — 분기 RBAC로 구동.
      //   실 매트릭스(D8-A3)는 dlq.replay와 sink_dlq.replay 역할집합이 동일해 in-handler deny 분기가 어떤
      //   역할로도 도달 불가 → split RBAC(dlq.replay allow / sink_dlq.replay deny)로 그 분기를 명시 구동한다.
      //   동일 RBAC로 workitem(기본 kind)은 통과(202)함을 동반 단언 → 403이 preHandler(dlq.replay)가 아니라
      //   in-handler(sink_dlq.replay)에서 났음을 증명한다(in-handler 게이트를 제거하면 sink 403/미인큐 검사가 깨진다).
      const splitApp = buildServer({
        pool,
        auth: new JwtAuthenticationBoundary(hmacJwtVerifier(SECRET)),
        rbac: new SplitSinkDenyRbac(),
        idempotency: new PgControlPlaneIdempotencyStore(pool),
        enqueuer,
        signedCommandRegistry,
      });
      await splitApp.ready();
      try {
        const enqBefore = sinkEnqueued.length;
        const s = await splitApp.inject({
          method: "POST",
          url: `/v1/dlq/${dlSplit.id}/replay?kind=sink`,
          headers: { authorization: `Bearer ${op}`, "idempotency-key": "sink-split-deny" },
        });
        check("split-RBAC sink replay → 403 AUTHZ_FORBIDDEN (in-handler gate)", s.statusCode === 403 && s.json().code === "AUTHZ_FORBIDDEN", s.body);
        check("in-handler deny: key unused", (await idemRowCount(pool, "sink-split-deny")) === 0);
        check("in-handler deny: did not enqueue", sinkEnqueued.length === enqBefore, JSON.stringify(sinkEnqueued));
        // 같은 split-RBAC로 workitem(기본 kind)은 preHandler(dlq.replay) 통과 → 202. 위 403이 in-handler 고유임을 증명.
        const w = await splitApp.inject({
          method: "POST",
          url: `/v1/dlq/${DL_WI_SPLIT}/replay`,
          headers: { authorization: `Bearer ${op}`, "idempotency-key": "wi-split-pass" },
        });
        check("split-RBAC workitem replay → 202 (preHandler dlq.replay 허용; 403은 in-handler 고유)", w.statusCode === 202 && w.json().status === "new", w.body);
      } finally {
        await splitApp.close();
      }
    } finally {
      await app.close();
    }
  } finally {
    await pool.end();
  }

  if (failures > 0) {
    console.error(`\nFAIL: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nPASS: sink-DLQ replay route (D8-A3 enqueue) integration green");
  process.exit(0);
}

main().catch((err) => {
  console.error("FAIL: integration test threw:", err);
  process.exit(1);
});
