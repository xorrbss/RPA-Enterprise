import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";

import { withTenantTx } from "../db/pool";
import { isRecord, runIdempotentCommand } from "./command";
import { ApiResponseError } from "./errors";
import { requirePrincipal, type ApiServerDeps } from "./server";

interface ConcurrencyPolicyRow {
  readonly credential_ref: string;
  readonly site_profile_id: string;
  readonly site_name: string | null;
  readonly max_concurrency: number;
  readonly active_leases: string;
}

interface ConcurrencyPolicyItem {
  readonly credential_ref: string;
  readonly site_profile_id: string;
  readonly site_name: string | null;
  readonly max_concurrency: number;
  readonly active_leases: number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// DG-4 purpose 화이트리스트: 자격증명 fill 전용 경로만 등록 가능. resume_token_hmac·signed_command·
// object_store·browser_session 등 비-자격증명 purpose 경로를 "자격증명"으로 등록하는 우회를 차단한다.
const CREDENTIAL_PURPOSES = new Set(["executor"]);

// ⛔ 시크릿 *값* 유입 차단(방어심층). 앱은 SecretRef(경로 식별자)만 관리하고 값은 out-of-band(Vault/KMS).
//   이 필드명이 body 에 있으면 조용히 무시하지 않고 loud 거부한다("조용한 false 금지").
const FORBIDDEN_VALUE_FIELDS = [
  "value",
  "secret",
  "secret_value",
  "password",
  "passphrase",
  "plaintext",
  "plain_secret",
  "token",
] as const;

/**
 * credential_ref 등록 시점 검증. 런타임 `refNamespaceDenial`(vault-secret-store-boundary.ts)이 resolve
 * 시점에 identity·purpose 결속까지 **권위적으로** 재검증한다 — 여기서는 등록 조기 피드백 + purpose
 * 화이트리스트(자격증명 전용)다. 위반 사유(deny) 또는 null(통과). 시크릿 값/전체경로는 사유에 안 담는다.
 */
function credentialRefDenial(ref: string): string | null {
  if (ref.includes("%")) return "percent-encoding not allowed";
  const segs = ref.split("/");
  if (segs.some((s) => s === "" || s === "." || s === "..")) return "empty or path-traversal segment";
  if (segs.length < 5 || segs[0] !== "rpa") return "must follow rpa/<env>/<runtime>/<purpose>/<name>";
  if (!CREDENTIAL_PURPOSES.has(segs[3] ?? "")) return `purpose segment is not a credential purpose`;
  return null;
}

export function registerConcurrencyPolicyRoutes(app: FastifyInstance, deps: ApiServerDeps): void {
  // 자격증명 동시성 정책 + 현재 사용량(거버넌스 가시화, D5). 정책당 max_concurrency 와 status='active' 또한
  // 만료 전(locked_until>now) lease 수를 합산해 운영자가 동시성 한도 대비 사용률을 본다. 정책 미설정 시 빈 목록.
  app.get("/v1/credentials/concurrency", { config: { rbacAction: "ops_alert.read" } }, async (request, reply) => {
    const principal = requirePrincipal(request);
    const items = await withTenantTx(deps.pool, principal.tenantId, async (client) =>
      readConcurrencyPolicies(client, principal.tenantId),
    );
    reply.code(200).send({ items, next_cursor: null });
  });

  // DG-4 등록/갱신: 자격증명 *참조*(SecretRef 경로) ↔ 사이트 바인딩과 동시성 한도를 콘솔에서 관리한다(admin).
  //   ⛔ 시크릿 값은 절대 받지 않는다 — SecretRef 식별자 + max_concurrency 만. 값은 out-of-band(Vault/KMS).
  //   동일 (ref, site) 재등록은 max_concurrency 갱신(upsert) — 새 ref 로 회전 시 새 ref 등록 후 옛 ref 삭제.
  app.post("/v1/credentials", { config: { rbacAction: "credential.manage" } }, async (request, reply) => {
    const body = isRecord(request.body) ? request.body : {};
    const forbidden = FORBIDDEN_VALUE_FIELDS.find((field) => field in body);
    if (forbidden !== undefined) {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "secret_value_not_accepted", field: forbidden });
    }
    const credentialRef = typeof body.credential_ref === "string" ? body.credential_ref.trim() : "";
    const siteProfileId = typeof body.site_profile_id === "string" ? body.site_profile_id : "";
    const maxConcurrency =
      typeof body.max_concurrency === "number" && Number.isInteger(body.max_concurrency) ? body.max_concurrency : null;
    if (credentialRef.length === 0) {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "missing_credential_ref", field: "credential_ref" });
    }
    const refDenial = credentialRefDenial(credentialRef);
    if (refDenial !== null) {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "credential_ref_invalid", detail: refDenial, field: "credential_ref" });
    }
    if (!UUID_RE.test(siteProfileId)) {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_site_profile_id", field: "site_profile_id" });
    }
    if (maxConcurrency === null || maxConcurrency < 1) {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_max_concurrency", field: "max_concurrency" });
    }
    const result = await runIdempotentCommand(
      deps,
      request,
      "registerCredentialBinding",
      `/v1/credentials/${encodeURIComponent(credentialRef)}/${siteProfileId}`,
      async (client, tenantId) => {
        // 사이트 존재 + tenant 일치(복합 FK 가 강제하지만 명시적 404 로 부재를 알린다).
        const site = await client.query<{ id: string }>(
          `SELECT id::text AS id FROM site_profiles WHERE tenant_id = $1::uuid AND id = $2::uuid`,
          [tenantId, siteProfileId],
        );
        if (site.rows[0] === undefined) throw new ApiResponseError("RESOURCE_NOT_FOUND");
        await client.query(
          `INSERT INTO credential_concurrency_policies (tenant_id, credential_ref, site_profile_id, max_concurrency)
             VALUES ($1::uuid, $2, $3::uuid, $4)
           ON CONFLICT (tenant_id, credential_ref, site_profile_id)
             DO UPDATE SET max_concurrency = EXCLUDED.max_concurrency`,
          [tenantId, credentialRef, siteProfileId, maxConcurrency],
        );
        return {
          status: 200,
          body: { credential_ref: credentialRef, site_profile_id: siteProfileId, max_concurrency: maxConcurrency },
        };
      },
    );
    reply.code(result.status).send(result.body);
  });

  // DG-4 삭제: 바인딩 제거. DG4-D2 — 활성·미만료 lease 가 있으면 거부(in-flight run 의 자격증명 사용 보호).
  app.delete<{ Querystring: { credential_ref?: string; site_profile_id?: string } }>(
    "/v1/credentials",
    { config: { rbacAction: "credential.manage" } },
    async (request, reply) => {
      const credentialRef = typeof request.query.credential_ref === "string" ? request.query.credential_ref.trim() : "";
      const siteProfileId = typeof request.query.site_profile_id === "string" ? request.query.site_profile_id : "";
      if (credentialRef.length === 0) {
        throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "missing_credential_ref", field: "credential_ref" });
      }
      if (!UUID_RE.test(siteProfileId)) {
        throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_site_profile_id", field: "site_profile_id" });
      }
      const result = await runIdempotentCommand(
        deps,
        request,
        "deleteCredentialBinding",
        `/v1/credentials/${encodeURIComponent(credentialRef)}/${siteProfileId}`,
        async (client, tenantId) => {
          const active = await client.query(
            `SELECT 1 FROM credential_leases
              WHERE tenant_id = $1::uuid AND credential_ref = $2 AND site_profile_id = $3::uuid
                AND status = 'active' AND locked_until > now() LIMIT 1`,
            [tenantId, credentialRef, siteProfileId],
          );
          if (active.rows[0] !== undefined) {
            throw new ApiResponseError("WORKITEM_CHECKOUT_CONFLICT", { reason: "active_credential_leases" });
          }
          const del = await client.query(
            `DELETE FROM credential_concurrency_policies
              WHERE tenant_id = $1::uuid AND credential_ref = $2 AND site_profile_id = $3::uuid`,
            [tenantId, credentialRef, siteProfileId],
          );
          if (del.rowCount === 0) throw new ApiResponseError("RESOURCE_NOT_FOUND");
          return { status: 200, body: { credential_ref: credentialRef, site_profile_id: siteProfileId, deleted: true } };
        },
      );
      reply.code(result.status).send(result.body);
    },
  );
}

async function readConcurrencyPolicies(client: PoolClient, tenantId: string): Promise<readonly ConcurrencyPolicyItem[]> {
  const result = await client.query<ConcurrencyPolicyRow>(
    `SELECT
        p.credential_ref,
        p.site_profile_id::text AS site_profile_id,
        sp.name AS site_name,
        p.max_concurrency,
        COALESCE(l.active_leases, 0)::text AS active_leases
       FROM credential_concurrency_policies p
       LEFT JOIN site_profiles sp ON sp.tenant_id = p.tenant_id AND sp.id = p.site_profile_id
       LEFT JOIN (
         SELECT credential_ref, site_profile_id, count(*) AS active_leases
           FROM credential_leases
          WHERE tenant_id = $1::uuid AND status = 'active' AND locked_until > now()
          GROUP BY credential_ref, site_profile_id
       ) l ON l.credential_ref = p.credential_ref AND l.site_profile_id = p.site_profile_id
      WHERE p.tenant_id = $1::uuid
      ORDER BY sp.name NULLS LAST, p.credential_ref`,
    [tenantId],
  );
  return result.rows.map((row) => ({
    credential_ref: row.credential_ref,
    site_profile_id: row.site_profile_id,
    site_name: row.site_name,
    max_concurrency: row.max_concurrency,
    active_leases: Number(row.active_leases),
  }));
}
