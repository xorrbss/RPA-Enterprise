/**
 * 자연어 generation 런타임 target 추론·검증 (scenario-generations.ts 분해 — 동작 무변경 이동).
 *
 * prompt/start_url → site_profile·browser_identity·network_policy 런타임 target 해소(site-resolution 경유) +
 * 명시 target 실행가능성 blocker 판정. route(generateScenario)·persist 양쪽이 호출(단방향). leaf 의존만
 * (pg·site-resolution·url leaf·GenerationRequest 타입). 내부 siteResolutionInferenceBlocker(SiteResolutionError
 * → 추론 blocker 매핑)는 비-export.
 */
import type { PoolClient } from "pg";

import { originOf, resolveSiteProfileId, SiteResolutionError } from "../runtime/site-resolution";
import type { GenerationRequest, RuntimeTargetInferenceBlocker } from "./scenario-generation-types";
import { extractFirstHttpUrl, hostOfHttpUrl, isHostAllowed } from "./scenario-generation-url";

/**
 * 런타임 target 추론 결과: 단일 후보 확정(target) 또는 구체 실패 사유(blocker) 중 하나.
 * undefined 로 뭉개던 기존 동작을 대체해 사유를 호출측으로 보존한다(조용한 unknown 금지).
 */
export type RuntimeTargetInference =
  | { target: NonNullable<GenerationRequest["target"]>; blocker?: undefined }
  | { target?: undefined; blocker: RuntimeTargetInferenceBlocker };

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

  const inference = await inferRuntimeTargetForStartUrl(client, tenantId, startUrl);
  if (inference.target === undefined) {
    return { ...request, inferenceBlocker: inference.blocker };
  }

  return {
    ...request,
    ...(request.startUrl !== undefined ? {} : { startUrl }),
    target: inference.target,
  };
}

export async function inferRuntimeTargetForStartUrl(
  client: PoolClient,
  tenantId: string,
  startUrl: string,
): Promise<RuntimeTargetInference> {
  let siteProfileId: string;
  try {
    siteProfileId = await resolveSiteProfileId(client, { tenantId, entryUrlRef: startUrl });
  } catch (error: unknown) {
    const blocker = siteResolutionInferenceBlocker(error);
    if (blocker === undefined) throw error;
    return { blocker };
  }

  const identity = await client.query<{ id: string }>(
    `SELECT id::text AS id
       FROM browser_identities
      WHERE tenant_id=$1::uuid AND site_profile_id=$2::uuid
      ORDER BY version DESC, created_at DESC, id DESC
      LIMIT 1`,
    [tenantId, siteProfileId],
  );
  const identityId = identity.rows[0]?.id;
  if (identityId === undefined) return { blocker: "browser_identity_unresolved_for_start_url" };

  const startHost = hostOfHttpUrl(startUrl);
  // resolveSiteProfileId 가 origin(http(s))을 이미 검증하므로 startHost===null 은 사실상 도달 불가지만,
  // 방어적으로 network 후보 부재와 동일하게 닫는다(조용한 통과 금지).
  if (startHost === null) return { blocker: "network_policy_unresolved_for_start_url" };
  const network = await client.query<{ id: string; allowed_domains: string[] }>(
    `SELECT id::text AS id, allowed_domains
       FROM network_policies
      WHERE tenant_id=$1::uuid
      ORDER BY created_at DESC, id DESC
      LIMIT 50`,
    [tenantId],
  );
  const matchingNetworkPolicies = network.rows.filter((row) => isHostAllowed(startHost, row.allowed_domains));
  if (matchingNetworkPolicies.length === 0) return { blocker: "network_policy_unresolved_for_start_url" };
  if (matchingNetworkPolicies.length > 1) return { blocker: "network_policy_ambiguous_for_start_url" };
  const networkPolicyId = matchingNetworkPolicies[0]?.id;
  if (networkPolicyId === undefined) return { blocker: "network_policy_unresolved_for_start_url" };

  return {
    target: {
      site_profile_id: siteProfileId,
      browser_identity_id: identityId,
      network_policy_id: networkPolicyId,
    },
  };
}

/** SiteResolutionError 의 추론-단계 코드를 fine-grained inference blocker 로 매핑. 비-추론 코드는 undefined(재-throw 신호). */
function siteResolutionInferenceBlocker(error: unknown): RuntimeTargetInferenceBlocker | undefined {
  if (!(error instanceof SiteResolutionError)) return undefined;
  if (error.code === "SITE_PROFILE_UNRESOLVED") return "site_profile_unresolved_for_start_url";
  if (error.code === "SITE_PROFILE_AMBIGUOUS") return "site_profile_ambiguous_for_start_url";
  return undefined;
}
