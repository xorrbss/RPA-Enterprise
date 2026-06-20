/**
 * 자연어 generation 런타임 target 추론·검증 (scenario-generations.ts 분해 — 동작 무변경 이동).
 *
 * prompt/start_url → site_profile·browser_identity·network_policy 런타임 target 해소(site-resolution 경유) +
 * 명시 target 실행가능성 blocker 판정. route(generateScenario)·persist 양쪽이 호출(단방향). leaf 의존만
 * (pg·site-resolution·url leaf·GenerationRequest 타입). 내부 isInferenceMiss는 비-export.
 */
import type { PoolClient } from "pg";

import { originOf, resolveSiteProfileId, type SiteResolutionCode, SiteResolutionError } from "../runtime/site-resolution";
import type { GenerationRequest } from "./scenario-generation-types";
import { extractFirstHttpUrl, hostOfHttpUrl, isHostAllowed } from "./scenario-generation-url";

export async function runtimeTargetBlocker(
  client: PoolClient,
  tenantId: string,
  target: NonNullable<GenerationRequest["target"]>,
  startUrl?: string,
): Promise<string | undefined> {
  const site = await client.query<{ risk: string; approved: boolean; url_pattern: string }>(
    `SELECT risk, approved, url_pattern FROM site_profiles WHERE tenant_id=$1::uuid AND id=$2::uuid`,
    [tenantId, target.site_profile_id],
  );
  const siteRow = site.rows[0];
  if (siteRow === undefined) return "site_profile_not_found";
  if (siteRow.risk === "red" && siteRow.approved !== true) return "site_profile_blocked";
  if (startUrl !== undefined && originOf(siteRow.url_pattern) !== originOf(startUrl)) {
    return "target_start_url_site_mismatch";
  }
  const identity = await client.query<{ site_profile_id: string | null }>(
    `SELECT site_profile_id::text AS site_profile_id FROM browser_identities WHERE tenant_id=$1::uuid AND id=$2::uuid`,
    [tenantId, target.browser_identity_id],
  );
  const identityRow = identity.rows[0];
  if (identityRow === undefined) return "browser_identity_not_found";
  if (identityRow.site_profile_id !== target.site_profile_id) return "browser_identity_site_mismatch";
  const network = await client.query<{ allowed_domains: string[] }>(
    `SELECT allowed_domains FROM network_policies WHERE tenant_id=$1::uuid AND id=$2::uuid`,
    [tenantId, target.network_policy_id],
  );
  const networkRow = network.rows[0];
  if (networkRow === undefined) return "network_policy_not_found";
  const siteHost = hostOfHttpUrl(siteRow.url_pattern);
  if (siteHost === null || !isHostAllowed(siteHost, networkRow.allowed_domains)) {
    return "network_policy_domain_mismatch";
  }
  return undefined;
}

export async function inferRuntimeTargetForRequest(
  client: PoolClient,
  tenantId: string,
  request: GenerationRequest,
): Promise<GenerationRequest> {
  if (request.target !== undefined) return request;
  const startUrl = request.startUrl ?? extractFirstHttpUrl(request.prompt);
  if (startUrl === undefined) return request;

  const target = await inferRuntimeTargetForStartUrl(client, tenantId, startUrl);
  if (target === undefined) return request;

  return {
    ...request,
    ...(request.startUrl !== undefined ? {} : { startUrl }),
    target,
  };
}

export async function inferRuntimeTargetForStartUrl(
  client: PoolClient,
  tenantId: string,
  startUrl: string,
): Promise<GenerationRequest["target"]> {
  const siteProfileId = await resolveSiteProfileId(client, { tenantId, entryUrlRef: startUrl }).catch((error: unknown) => {
    if (error instanceof SiteResolutionError && isInferenceMiss(error.code)) return null;
    throw error;
  });
  if (siteProfileId === null) return undefined;

  const identity = await client.query<{ id: string }>(
    `SELECT id::text AS id
       FROM browser_identities
      WHERE tenant_id=$1::uuid AND site_profile_id=$2::uuid
      ORDER BY version DESC, created_at DESC, id DESC
      LIMIT 1`,
    [tenantId, siteProfileId],
  );
  const identityId = identity.rows[0]?.id;
  if (identityId === undefined) return undefined;

  const startHost = hostOfHttpUrl(startUrl);
  if (startHost === null) return undefined;
  const network = await client.query<{ id: string; allowed_domains: string[] }>(
    `SELECT id::text AS id, allowed_domains
       FROM network_policies
      WHERE tenant_id=$1::uuid
      ORDER BY created_at DESC, id DESC
      LIMIT 50`,
    [tenantId],
  );
  const matchingNetworkPolicies = network.rows.filter((row) => isHostAllowed(startHost, row.allowed_domains));
  if (matchingNetworkPolicies.length !== 1) return undefined;
  const networkPolicyId = matchingNetworkPolicies[0]?.id;
  if (networkPolicyId === undefined) return undefined;

  return {
    site_profile_id: siteProfileId,
    browser_identity_id: identityId,
    network_policy_id: networkPolicyId,
  };
}

function isInferenceMiss(code: SiteResolutionCode): boolean {
  return code === "SITE_PROFILE_UNRESOLVED" || code === "SITE_PROFILE_AMBIGUOUS";
}
