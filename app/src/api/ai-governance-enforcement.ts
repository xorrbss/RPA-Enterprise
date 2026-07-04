import type { PoolClient } from "pg";

import type { LLMRequest } from "../../../ts/security-middleware-contract";
import { withTenantTx, type PgPool } from "../db/pool";
import type { AiGovernanceGatewayDecision, AiGovernanceGatewayGuard } from "../gateway/llm-gateway";
import { ApiResponseError } from "../runtime/errors";
import { isGraceActive, readAiRuntimePolicyRow, type AiRuntimePolicyMode } from "./ai-governance-policy";
import { evaluateEvidenceRequirements, runtimeRequirements } from "./ai-governance-evidence-requirements";

export interface AiGovernanceRuntimeDecision {
  readonly kind: "allow" | "warn" | "block";
  readonly mode: AiRuntimePolicyMode | "not_configured" | "not_applicable";
  readonly reason: string;
  readonly evidenceRefs: readonly string[];
  readonly policyDecisionRef?: string;
  readonly blockingRequirements: readonly string[];
}

export async function evaluateAiGovernanceRuntime(
  client: PoolClient,
  input: { readonly tenantId: string; readonly model: string | null; readonly promptTemplateVersion: string | null },
): Promise<AiGovernanceRuntimeDecision> {
  if (input.model === null && input.promptTemplateVersion === null) {
    return {
      kind: "allow",
      mode: "not_applicable",
      reason: "ai_runtime_not_applicable",
      evidenceRefs: [],
      blockingRequirements: [],
    };
  }
  const policy = await readAiRuntimePolicyRow(client, input.tenantId);
  if (policy === null) {
    return {
      kind: "allow",
      mode: "not_configured",
      reason: "ai_runtime_policy_missing",
      evidenceRefs: [],
      blockingRequirements: [],
    };
  }

  const requirements = runtimeRequirements(input.model, input.promptTemplateVersion, input.tenantId);
  const evaluated = await evaluateEvidenceRequirements(client, input.tenantId, requirements);
  const issues = evaluated.filter((item) => item.status !== "valid");
  const evidenceRefs = evaluated.map((item) => item.evidenceRef).filter((ref): ref is string => ref !== null);
  if (issues.length === 0) {
    return {
      kind: "allow",
      mode: policy.mode,
      reason: "ai_governance_evidence_valid",
      evidenceRefs,
      policyDecisionRef: policy.policy_decision_ref,
      blockingRequirements: [],
    };
  }

  const graceActive = isGraceActive(policy);
  const reason = issues.some((item) => item.status === "failed")
    ? "ai_governance_evidence_failed"
    : graceActive
      ? "ai_governance_grace_active"
      : "ai_governance_evidence_incomplete";
  const blockingRequirements = issues.map((item) => `${item.requirement.evidenceType}:${item.requirement.subjectRef}:${item.status}`);
  if (policy.mode === "block" && !graceActive) {
    return {
      kind: "block",
      mode: policy.mode,
      reason,
      evidenceRefs,
      policyDecisionRef: policy.policy_decision_ref,
      blockingRequirements,
    };
  }
  return {
    kind: policy.mode === "warn" || graceActive ? "warn" : "allow",
    mode: policy.mode,
    reason,
    evidenceRefs,
    policyDecisionRef: policy.policy_decision_ref,
    blockingRequirements,
  };
}

export function assertAiGovernanceRuntimeAllowed(decision: AiGovernanceRuntimeDecision): void {
  if (decision.kind !== "block") return;
  throw new ApiResponseError("AI_GOVERNANCE_POLICY_BLOCKED", {
    reason: decision.reason,
    mode: decision.mode,
    blocking_requirements: decision.blockingRequirements,
    policy_decision_ref: decision.policyDecisionRef ?? null,
  });
}

export class PgAiGovernanceGatewayGuard implements AiGovernanceGatewayGuard {
  constructor(private readonly pool: PgPool) {}

  async evaluate(req: LLMRequest): Promise<AiGovernanceGatewayDecision> {
    return withTenantTx(this.pool, req.metadata.tenantId, (client) =>
      evaluateAiGovernanceRuntime(client, {
        tenantId: req.metadata.tenantId,
        model: req.model,
        promptTemplateVersion: req.promptTemplateVersion,
      }),
    );
  }
}
