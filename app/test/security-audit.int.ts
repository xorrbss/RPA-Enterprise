/**
 * D4.4 durable security audit writer integration.
 *
 * Runs under the temp PostgreSQL 15 gate with a non-BYPASSRLS app role.
 * The writer must append to tenant-scoped PostgreSQL audit_log before returning
 * protected security-boundary decisions.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { FakeSecretStore, asSecretRef } from "../../security/compliance-scaffold";
import {
  SECURITY_AUDIT_PAYLOAD_SCHEMA_REF,
  type CorrelationId,
  type IdempotencyKey,
  type IsoDateTime,
  type PrincipalId,
  type SecurityAuditDecisionAppendInput,
  type TenantId,
} from "../../ts/security-middleware-contract";
import { createPool, withTenantTx } from "../src/db/pool";
import { PgDurableSecurityAuditDecisionWriter } from "../src/api/security-audit";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCHEMA = "rpa_security_audit_int";
const TENANT = "00000000-0000-0000-0000-0000000000ad" as TenantId;
const SUBJECT = "10000000-0000-0000-0000-0000000000ad" as PrincipalId;
const CORRELATION = "20000000-0000-0000-0000-0000000000ad" as CorrelationId;
const RETENTION_UNTIL = "2026-09-12T00:00:00Z" as IsoDateTime;

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` - ${detail}` : ""}`);
  }
}

async function expectReject(label: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
    check(label, false, "expected rejection");
  } catch (err) {
    check(label, String(err).includes("security audit append failed closed"), String(err));
  }
}

function auditInput(
  idempotencyKey: string,
  overrides: Partial<SecurityAuditDecisionAppendInput> = {},
): SecurityAuditDecisionAppendInput {
  return {
    tenantId: TENANT,
    actor: { subjectId: SUBJECT, roles: ["admin"] },
    action: "artifact.read",
    outcome: "deny",
    resource: { kind: "artifact", id: "artifact-audit-int" },
    reason: "integration:artifact_read_denied",
    correlationId: CORRELATION,
    idempotencyKey: idempotencyKey as IdempotencyKey,
    occurredAt: "2026-06-14T00:00:00Z" as IsoDateTime,
    retentionUntil: RETENTION_UNTIL,
    payloadSchemaRef: SECURITY_AUDIT_PAYLOAD_SCHEMA_REF,
    failClosed: true,
    payload: { decision_kind: "artifact.read", artifact_id: "artifact-audit-int" },
    ...overrides,
  };
}

interface AuditRow {
  sequence_no: number;
  previous_hash: string | null;
  hash: string;
  action: string;
  outcome: string;
  payload_schema_ref: string;
  retention_until: string | null;
  payload: { decision_kind?: string };
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
    console.log("migrations applied (concurrency -> core)");

    const writer = new PgDurableSecurityAuditDecisionWriter(pool);
    const first = await writer.recordDecision(auditInput("audit-int-1"), { kind: "blocked" });
    check("first decision returned only after append", first.decision.kind === "blocked");
    check("first audit sequence=1", first.auditRecord.sequence === 1, String(first.auditRecord.sequence));
    check("first audit previousHash=GENESIS", first.auditRecord.previousHash === "GENESIS", first.auditRecord.previousHash);

    const second = await writer.recordDecision(
      auditInput("audit-int-2", {
        action: "network.request",
        outcome: "blocked",
        resource: { kind: "network_policy", id: "network-policy-audit-int" },
        reason: "integration:domain_policy_blocked",
        occurredAt: "2026-06-14T00:00:01Z" as IsoDateTime,
        payload: { decision_kind: "network.request", url: "https://blocked.example/path" },
      }),
      { kind: "blocked" },
    );
    check("second audit sequence=2", second.auditRecord.sequence === 2, String(second.auditRecord.sequence));
    check("second audit links first hash", second.auditRecord.previousHash === first.auditRecord.hash);

    await withTenantTx(pool, TENANT, async (c) => {
      const rows = await c.query<AuditRow>(
        `SELECT sequence_no::int, previous_hash, hash, action, outcome,
                payload_schema_ref, retention_until::text, payload
           FROM audit_log
          WHERE tenant_id=$1::uuid
          ORDER BY sequence_no`,
        [TENANT],
      );
      check("two durable audit rows persisted", rows.rowCount === 2, `rowCount=${rows.rowCount}`);
      check("first row has tenant-local genesis", rows.rows[0]?.previous_hash === null, JSON.stringify(rows.rows[0]));
      check("second row chains to first", rows.rows[1]?.previous_hash === rows.rows[0]?.hash, JSON.stringify(rows.rows));
      check(
        "all rows use security payload schema",
        rows.rows.every((row) => row.payload_schema_ref === SECURITY_AUDIT_PAYLOAD_SCHEMA_REF),
        JSON.stringify(rows.rows),
      );
      check(
        "all rows persist retention_until",
        rows.rows.every((row) => row.retention_until?.startsWith("2026-09-12")),
        JSON.stringify(rows.rows),
      );
      check(
        "payload is safe JSON metadata",
        rows.rows.map((row) => row.payload.decision_kind).join(",") === "artifact.read,network.request",
        JSON.stringify(rows.rows),
      );
    });

    await expectReject("duplicate idempotency key fails closed", () =>
      writer.recordDecision(auditInput("audit-int-1"), { kind: "must_not_return" }),
    );
    await expectReject("invalid retention timestamp fails closed", () =>
      writer.recordDecision(
        auditInput("audit-int-bad-retention", { retentionUntil: "not-a-date" as IsoDateTime }),
        { kind: "must_not_return" },
      ),
    );
    await expectReject("bare date occurredAt fails closed", () =>
      writer.recordDecision(
        auditInput("audit-int-bad-occurred-date", { occurredAt: "2026-06-14" as IsoDateTime }),
        { kind: "must_not_return" },
      ),
    );
    await expectReject("natural-language occurredAt fails closed", () =>
      writer.recordDecision(
        auditInput("audit-int-bad-occurred-human", { occurredAt: "June 14 2026" as IsoDateTime }),
        { kind: "must_not_return" },
      ),
    );
    await expectReject("malformed retention offset fails closed", () =>
      writer.recordDecision(
        auditInput("audit-int-bad-retention-offset", { retentionUntil: "2026-09-12T00:00:00+0900" as IsoDateTime }),
        { kind: "must_not_return" },
      ),
    );
    await expectReject("calendar-invalid retention fails closed", () =>
      writer.recordDecision(
        auditInput("audit-int-bad-retention-calendar", { retentionUntil: "2026-02-31T00:00:00Z" as IsoDateTime }),
        { kind: "must_not_return" },
      ),
    );
    await expectReject("non-security audit action fails closed", () =>
      writer.recordDecision(
        auditInput("audit-int-bad-action", { action: "executor.invocation.record" as never }),
        { kind: "must_not_return" },
      ),
    );

    const store = new FakeSecretStore({ "secret://tenant/security-audit-int": "security-audit-secret-token" });
    const secret = await store.resolve(asSecretRef("secret://tenant/security-audit-int"));
    await expectReject("PlainSecret payload fails closed", () =>
      writer.recordDecision(
        auditInput("audit-int-secret-payload", {
          action: "secret.resolve",
          outcome: "allow",
          resource: { kind: "secret", id: "secret://tenant/security-audit-int" },
          reason: "integration:plain_secret_payload",
          payload: { secret },
        }),
        { kind: "must_not_return" },
      ),
    );

    await withTenantTx(pool, TENANT, async (c) => {
      const rows = await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM audit_log WHERE tenant_id=$1::uuid`, [TENANT]);
      check("failed audit attempts insert no rows", rows.rows[0]?.n === 2, `n=${rows.rows[0]?.n}`);
    });
  } finally {
    await pool.end();
  }

  if (failures > 0) {
    console.error(`\nFAIL: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nPASS: D4.4 durable security audit PostgreSQL integration green");
}

main().catch((err) => {
  console.error("FAIL: security audit integration threw:", err);
  process.exit(1);
});
