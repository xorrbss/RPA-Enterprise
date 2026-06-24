/**
 * RQ-016 challenge suspension 포트 통합. 실 PostgreSQL.
 *
 * PgChallengeSuspensionPort.suspendForChallenge 가 공급된 tenant tx 안에서: human_tasks row 생성(kind=
 * createHumanTask.humanTaskKind, 하드코딩 아님) + human_task.created 발행(닫힌 빈 payload) + runs.bookmark 영속
 * 하는지 검증. createHumanTask/startBookmark pending 부재 시 loud throw. (R4·R11 은 coordinator/후속 — 포트는 run 재전이 안 함.)
 *
 * 실행(temp PG15 게이트):
 *   node scripts/db-temp-postgres-gate.mjs -- npm --prefix app exec -- tsx app/test/challenge-suspension-port.int.ts
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { ClassifiedException, RedactedString } from "../../ts/core-types";
import type { SideEffectCmd } from "../../ts/state-machine-types";
import { createPool, withTenantTx } from "../src/db/pool";
import { PgChallengeSuspensionPort } from "../src/runtime/challenge-suspension-port";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCHEMA = "rpa_challenge_suspension_int";
const TENANT = "00000000-0000-0000-0000-0000000000a1";
const SCEN = "70000000-0000-0000-0000-0000000000f1";
const SVER = "70000000-0000-0000-0000-0000000000f2";
const RUN_CAPTCHA = "71000000-0000-0000-0000-0000000000f1";
const RUN_MFA = "71000000-0000-0000-0000-0000000000f2";
const RUN_NEG = "71000000-0000-0000-0000-0000000000f3";
const RUN_FORM = "71000000-0000-0000-0000-0000000000f4";
const CORR = "20000000-0000-0000-0000-0000000000f1";

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

async function caught(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
    return undefined;
  } catch (e) {
    return e;
  }
}

const exception: ClassifiedException = {
  class: "challenge",
  code: "CHALLENGE_UNRESOLVED",
  message: "challenge requires human assist" as RedactedString,
};

function pending(kind: "captcha" | "mfa"): readonly SideEffectCmd[] {
  return [
    { kind: "createHumanTask", humanTaskKind: kind },
    { kind: "startBookmark" },
  ];
}

async function main(): Promise<void> {
  const pool = createPool({ options: `-c search_path=${SCHEMA},public` });
  const port = new PgChallengeSuspensionPort();
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
      await c.query(`INSERT INTO scenarios (id, tenant_id, name) VALUES ($1,$2,'suspension')`, [SCEN, TENANT]);
      await c.query(
        `INSERT INTO scenario_versions (id, tenant_id, scenario_id, version, promotion_status, ir)
         VALUES ($1,$2,$3,1,'draft','{"nodes":[]}'::jsonb)`,
        [SVER, TENANT, SCEN],
      );
      // R4 적용 후 상태(suspending)로 시드 — 포트는 run 상태를 보거나 바꾸지 않는다(coordinator 가 R4 소유).
      for (const rid of [RUN_CAPTCHA, RUN_MFA, RUN_NEG, RUN_FORM]) {
        await c.query(
          `INSERT INTO runs (id, tenant_id, scenario_version_id, status, correlation_id)
           VALUES ($1,$2,$3,'suspending',$4)`,
          [rid, TENANT, SVER, CORR],
        );
      }
    });

    // 1) captcha/mfa: kind 가 createHumanTask 에서 전파되는지(하드코딩 아님) + human_task.created + bookmark.
    for (const tc of [
      { rid: RUN_CAPTCHA, kind: "captcha" as const, step: "challenge#1" },
      { rid: RUN_MFA, kind: "mfa" as const, step: "challenge#2" },
    ]) {
      const res = await withTenantTx(pool, TENANT, (c) =>
        port.suspendForChallenge(c, {
          tenantId: TENANT,
          runId: tc.rid,
          stepId: tc.step,
          attempt: 0,
          correlationId: CORR,
          exception,
          pendingSideEffects: pending(tc.kind),
        }),
      );
      check(`suspendForChallenge(${tc.kind}) → emittedEvents 1건`, res.emittedEvents.length === 1, String(res.emittedEvents.length));

      const ht = await withTenantTx(pool, TENANT, async (c) => {
        const r = await c.query<{ kind: string; state: string; expires_in_future: boolean }>(
          `SELECT kind, state, expires_at > now() AS expires_in_future FROM human_tasks WHERE run_id=$1::uuid`,
          [tc.rid],
        );
        return r.rows;
      });
      check(`human_tasks 1건 (kind=${tc.kind}, state=open, 하드코딩 아님)`, ht.length === 1 && ht[0]?.kind === tc.kind && ht[0]?.state === "open", JSON.stringify(ht));

      check(`human_tasks default expires_at future (${tc.kind})`, ht[0]?.expires_in_future === true, JSON.stringify(ht));

      const evs = await withTenantTx(pool, TENANT, async (c) => {
        const r = await c.query<{ event_type: string }>(`SELECT event_type FROM events_outbox WHERE run_id=$1::uuid`, [tc.rid]);
        return r.rows.map((x) => x.event_type);
      });
      check(`outbox 에 human_task.created (${tc.kind})`, evs.includes("human_task.created"), evs.join(","));

      const bm = await withTenantTx(pool, TENANT, async (c) => {
        const r = await c.query<{ bookmark: { stepId?: string; reason?: string } | null }>(`SELECT bookmark FROM runs WHERE id=$1::uuid`, [tc.rid]);
        return r.rows[0]?.bookmark ?? null;
      });
      check(`runs.bookmark 영속(stepId=${tc.step}, reason=challenge)`, bm?.stepId === tc.step && bm?.reason === "challenge", JSON.stringify(bm));
    }

    {
      await withTenantTx(pool, TENANT, (c) =>
        port.suspendForChallenge(c, {
          tenantId: TENANT,
          runId: RUN_FORM,
          stepId: "human-task#form",
          attempt: 0,
          correlationId: CORR,
          exception,
          pendingSideEffects: pending("mfa"),
          assigneeRole: "reviewer",
          onTimeout: "escalate",
          timeoutMs: 45 * 60 * 1000,
          payload: { invoice_id: "INV-9" },
          resultSchema: {
            version: "business_form_v1",
            fields: [{ key: "total", label: "Total", type: "number", required: true }],
          },
          artifactRefs: ["artifact.invoice.scan"],
          reason: "human_task",
        }),
      );
      const row = await withTenantTx(pool, TENANT, async (c) => {
        const r = await c.query<{ payload: Record<string, unknown>; result_schema: Record<string, unknown>; artifact_refs: string[]; on_timeout: string; timeout_roughly_45m: boolean }>(
          `SELECT payload, result_schema, artifact_refs, on_timeout,
                  expires_at > now() + interval '44 minutes' AND expires_at < now() + interval '46 minutes' AS timeout_roughly_45m
             FROM human_tasks WHERE run_id=$1::uuid`,
          [RUN_FORM],
        );
        return r.rows[0];
      });
      check("human_task form payload 저장", row?.payload.invoice_id === "INV-9", JSON.stringify(row));
      check("human_task form result_schema 저장", row?.result_schema.version === "business_form_v1", JSON.stringify(row));
      check("human_task form artifact_refs 저장", row?.artifact_refs[0] === "artifact.invoice.scan", JSON.stringify(row));
      check("human_task on_timeout 저장", row?.on_timeout === "escalate", JSON.stringify(row));
    }

    // 2) 음성: createHumanTask 부재 → throw(조용한 false 금지).
    const eNoCreate = await caught(
      withTenantTx(pool, TENANT, (c) =>
        port.suspendForChallenge(c, {
          tenantId: TENANT, runId: RUN_NEG, stepId: "c#3", attempt: 0, correlationId: CORR, exception,
          pendingSideEffects: [{ kind: "startBookmark" }],
        }),
      ),
    );
    check("createHumanTask pending 부재 → throw", eNoCreate instanceof Error, String(eNoCreate));

    // 3) 음성: startBookmark 부재 → throw.
    const eNoBookmark = await caught(
      withTenantTx(pool, TENANT, (c) =>
        port.suspendForChallenge(c, {
          tenantId: TENANT, runId: RUN_NEG, stepId: "c#4", attempt: 0, correlationId: CORR, exception,
          pendingSideEffects: [{ kind: "createHumanTask", humanTaskKind: "captcha" }],
        }),
      ),
    );
    check("startBookmark pending 부재 → throw", eNoBookmark instanceof Error, String(eNoBookmark));

    // 음성 케이스는 human_tasks 를 남기지 않아야(throw 가 tx 롤백). RUN_NEG human_tasks 0건.
    const negHt = await withTenantTx(pool, TENANT, async (c) => {
      const r = await c.query<{ n: string }>(`SELECT count(*)::text AS n FROM human_tasks WHERE run_id=$1::uuid`, [RUN_NEG]);
      return r.rows[0]?.n ?? "?";
    });
    check("음성 케이스 human_tasks 0건(tx 롤백)", negHt === "0", negHt);
  } finally {
    await pool.end();
  }

  if (failures > 0) {
    console.error(`\nFAIL: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nPASS: challenge suspension 포트 — human_tasks 생성 + human_task.created + bookmark (RQ-016)");
  process.exit(0);
}

main().catch((e) => {
  console.error("challenge-suspension-port int fatal:", e);
  process.exit(1);
});
