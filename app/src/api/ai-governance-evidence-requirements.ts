import type { PoolClient } from "pg";

type AiEvidenceType = "model_registry" | "prompt_registry" | "eval_result" | "cost_control";
type EvidenceRequirementStatus = "valid" | "missing" | "failed" | "expired" | "deferred";

export interface EvidenceRequirement {
  readonly evidenceType: AiEvidenceType;
  readonly subjectRef: string;
  readonly label: string;
}

interface LatestEvidence {
  readonly evidence_type: AiEvidenceType;
  readonly subject_ref: string;
  readonly status: "valid" | "failed" | "deferred";
  readonly expires_at: Date | null;
  readonly evidence_ref: string | null;
  readonly policy_decision_ref: string | null;
}

export interface EvaluatedRequirement {
  readonly requirement: EvidenceRequirement;
  readonly status: EvidenceRequirementStatus;
  readonly evidenceRef: string | null;
  readonly policyDecisionRef: string | null;
}

export function readinessRequirements(models: readonly string[], promptVersions: readonly string[], tenantId: string): EvidenceRequirement[] {
  const requirements = new Map<string, EvidenceRequirement>();
  for (const model of models) {
    addRequirement(requirements, { evidenceType: "model_registry", subjectRef: modelSubject(model), label: `model_registry:${model}` });
  }
  if (models.length > 0) {
    addRequirement(requirements, {
      evidenceType: "cost_control",
      subjectRef: tenantCostControlSubject(tenantId),
      label: "cost_control:tenant",
    });
  }
  for (const version of promptVersions) {
    addRequirement(requirements, { evidenceType: "prompt_registry", subjectRef: promptSubject(version), label: `prompt_registry:${version}` });
    addRequirement(requirements, { evidenceType: "eval_result", subjectRef: promptSubject(version), label: `eval_result:${version}` });
  }
  return [...requirements.values()];
}

export function runtimeRequirements(model: string | null, promptVersion: string | null, tenantId: string): EvidenceRequirement[] {
  const requirements = new Map<string, EvidenceRequirement>();
  if (model !== null) {
    addRequirement(requirements, { evidenceType: "model_registry", subjectRef: modelSubject(model), label: `model_registry:${model}` });
    addRequirement(requirements, {
      evidenceType: "cost_control",
      subjectRef: tenantCostControlSubject(tenantId),
      label: "cost_control:tenant",
    });
  }
  if (promptVersion !== null) {
    addRequirement(requirements, { evidenceType: "prompt_registry", subjectRef: promptSubject(promptVersion), label: `prompt_registry:${promptVersion}` });
    addRequirement(requirements, { evidenceType: "eval_result", subjectRef: promptSubject(promptVersion), label: `eval_result:${promptVersion}` });
  }
  return [...requirements.values()];
}

function addRequirement(requirements: Map<string, EvidenceRequirement>, requirement: EvidenceRequirement): void {
  requirements.set(`${requirement.evidenceType}:${requirement.subjectRef}`, requirement);
}

export async function evaluateEvidenceRequirements(
  client: PoolClient,
  tenantId: string,
  requirements: readonly EvidenceRequirement[],
): Promise<EvaluatedRequirement[]> {
  const out: EvaluatedRequirement[] = [];
  for (const requirement of requirements) {
    const result = await client.query<LatestEvidence>(
      `SELECT evidence_type, subject_ref, status, expires_at, evidence_ref, policy_decision_ref
         FROM ai_governance_evidence
        WHERE tenant_id = $1::uuid
          AND evidence_type = $2
          AND subject_ref = $3
          AND deleted_at IS NULL
        ORDER BY evidence_at DESC, recorded_at DESC, id DESC
        LIMIT 1`,
      [tenantId, requirement.evidenceType, requirement.subjectRef],
    );
    const latest = result.rows[0];
    if (latest === undefined) {
      out.push({ requirement, status: "missing", evidenceRef: null, policyDecisionRef: null });
      continue;
    }
    if (latest.status === "failed") {
      out.push({ requirement, status: "failed", evidenceRef: latest.evidence_ref, policyDecisionRef: latest.policy_decision_ref });
      continue;
    }
    if (latest.status === "deferred") {
      out.push({ requirement, status: "deferred", evidenceRef: latest.evidence_ref, policyDecisionRef: latest.policy_decision_ref });
      continue;
    }
    if (latest.expires_at !== null && latest.expires_at.getTime() <= Date.now()) {
      out.push({ requirement, status: "expired", evidenceRef: latest.evidence_ref, policyDecisionRef: latest.policy_decision_ref });
      continue;
    }
    out.push({ requirement, status: "valid", evidenceRef: latest.evidence_ref, policyDecisionRef: latest.policy_decision_ref });
  }
  return out;
}

function modelSubject(model: string): string {
  return `model:${model}`;
}

function promptSubject(promptTemplateVersion: string): string {
  return `prompt:${promptTemplateVersion}`;
}

function tenantCostControlSubject(tenantId?: string): string {
  return tenantId === undefined ? "tenant:current:ai_cost_control" : `tenant:${tenantId}:ai_cost_control`;
}
