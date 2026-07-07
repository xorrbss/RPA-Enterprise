import type { PoolClient } from "pg";

import { ApiResponseError } from "../runtime/errors";
import {
  isGraceActive,
  readAiRuntimePolicyRow,
  SAFE_REF_RE,
  SECRET_OR_RAW_RE,
  type AiRuntimePolicyRow,
} from "./ai-governance-policy";
import {
  evaluateEvidenceRequirements,
  readinessRequirements,
  type EvaluatedRequirement,
} from "./ai-governance-evidence-requirements";

export interface AiGovernanceReadinessSnapshot {
  readonly status: "pass" | "warning" | "blocked" | "deferred";
  readonly reasonCode: string | null;
  readonly detail: string;
  readonly evidence: readonly string[];
  readonly requiredAction: string | null;
  readonly signals: Readonly<Record<string, unknown>>;
}

export interface AiGovernanceReadinessConfig {
  readonly configuredModels?: readonly string[];
  readonly configuredPromptVersions?: readonly string[];
}

const AI_GOVERNANCE_READINESS_ENABLED_EVIDENCE = "ai_runtime_enabled=true";

export async function readAiGovernanceReadiness(
  client: PoolClient,
  tenantId: string,
  config: AiGovernanceReadinessConfig = {},
): Promise<AiGovernanceReadinessSnapshot> {
  const policy = await readAiRuntimePolicyRow(client, tenantId);
  const dbModels = await readConfiguredGatewayModels(client, tenantId);
  const configuredModels = normalizeConfiguredRuntimeRefs(config.configuredModels ?? []);
  const models = sortedUnique([...dbModels, ...configuredModels]);
  const observedPromptVersions = await readObservedPromptTemplateVersions(client, tenantId);
  const configuredPromptVersions = normalizeConfiguredRuntimeRefs(config.configuredPromptVersions ?? []);
  const promptVersions = sortedUnique([...observedPromptVersions, ...configuredPromptVersions]);
  const aiEnabled = models.length > 0 || promptVersions.length > 0;
  if (!aiEnabled) {
    return {
      status: "pass",
      reasonCode: null,
      detail: "No tenant LLM model policy or observed prompt template versions require runtime AI governance evidence yet.",
      evidence: ["ai_runtime_enabled=false", "models=0", "prompt_template_versions=0"],
      requiredAction: null,
      signals: { ai_runtime_enabled: false, models: [], prompt_template_versions: [], configured_models: [], configured_prompt_template_versions: [] },
    };
  }
  if (policy === null) {
    return {
      status: "deferred",
      reasonCode: "ai_runtime_policy_missing",
      detail: "LLM runtime use is configured, but no tenant AI runtime enforcement policy exists.",
      evidence: [
        AI_GOVERNANCE_READINESS_ENABLED_EVIDENCE,
        `models=${models.length}`,
        `configured_models=${configuredModels.length}`,
        `prompt_template_versions=${promptVersions.length}`,
        `configured_prompt_template_versions=${configuredPromptVersions.length}`,
      ],
      requiredAction: "Configure /v1/ai-governance/runtime-policy with observe/warn/block mode and owner-approved policy references.",
      signals: {
        ai_runtime_enabled: true,
        models,
        configured_models: configuredModels,
        prompt_template_versions: promptVersions,
        configured_prompt_template_versions: configuredPromptVersions,
        policy_mode: null,
      },
    };
  }

  const evaluated = await evaluateEvidenceRequirements(client, tenantId, readinessRequirements(models, promptVersions, tenantId));
  const issues = evaluated.filter((item) => item.status !== "valid");
  const failed = issues.filter((item) => item.status === "failed");
  const expired = issues.filter((item) => item.status === "expired");
  const missing = issues.filter((item) => item.status === "missing");
  const deferred = issues.filter((item) => item.status === "deferred");
  const graceActive = isGraceActive(policy);
  const evidence = [
    AI_GOVERNANCE_READINESS_ENABLED_EVIDENCE,
    `policy_mode=${policy.mode}`,
    `grace_active=${graceActive}`,
    `models=${models.length}`,
    `configured_models=${configuredModels.length}`,
    `prompt_template_versions=${promptVersions.length}`,
    `configured_prompt_template_versions=${configuredPromptVersions.length}`,
    `requirements=${evaluated.length}`,
    `valid=${evaluated.length - issues.length}`,
    `missing=${missing.length}`,
    `expired=${expired.length}`,
    `failed=${failed.length}`,
    `deferred=${deferred.length}`,
  ];

  if (failed.length > 0) {
    return {
      status: "blocked",
      reasonCode: "ai_governance_evidence_failed",
      detail: `AI governance has failed evidence: ${failed.map((item) => item.requirement.label).join(", ")}.`,
      evidence,
      requiredAction: "Resolve failed AI governance evidence before controlled production open.",
      signals: readinessSignals(policy, models, promptVersions, evaluated, configuredModels, configuredPromptVersions),
    };
  }

  if (issues.length > 0 && policy.mode === "block" && !graceActive) {
    return {
      status: "blocked",
      reasonCode: "ai_governance_block_missing_evidence",
      detail: `AI runtime policy is block, but required evidence is missing or expired: ${issues.map((item) => item.requirement.label).join(", ")}.`,
      evidence,
      requiredAction: "Record valid model registry, prompt registry, eval, and cost-control evidence or set an approved grace window.",
      signals: readinessSignals(policy, models, promptVersions, evaluated, configuredModels, configuredPromptVersions),
    };
  }

  if (issues.length > 0) {
    return {
      status: graceActive || policy.mode === "warn" ? "warning" : "deferred",
      reasonCode: graceActive ? "ai_governance_grace_active" : "ai_governance_evidence_incomplete",
      detail: `AI governance evidence is incomplete: ${issues.map((item) => item.requirement.label).join(", ")}.`,
      evidence,
      requiredAction: "Complete metadata-only AI governance evidence before removing grace or promoting to block mode.",
      signals: readinessSignals(policy, models, promptVersions, evaluated, configuredModels, configuredPromptVersions),
    };
  }

  return {
    status: "pass",
    reasonCode: null,
    detail: "AI runtime policy and required model/prompt/cost/eval evidence are valid.",
    evidence,
    requiredAction: null,
    signals: readinessSignals(policy, models, promptVersions, evaluated, configuredModels, configuredPromptVersions),
  };
}

async function readConfiguredGatewayModels(client: PoolClient, tenantId: string): Promise<string[]> {
  const result = await client.query<{ model: string }>(
    `SELECT model
       FROM gateway_policies
      WHERE tenant_id = $1::uuid
      ORDER BY model ASC`,
    [tenantId],
  );
  return result.rows.map((row) => row.model);
}

async function readObservedPromptTemplateVersions(client: PoolClient, tenantId: string): Promise<string[]> {
  const result = await client.query<{ prompt_template_version: string }>(
    `SELECT DISTINCT prompt_template_version
       FROM (
              SELECT prompt_template_version
                FROM stagehand_calls
               WHERE tenant_id = $1::uuid
                 AND prompt_template_version IS NOT NULL
              UNION
              SELECT prompt_template_version
                FROM scenario_generation_llm_calls
               WHERE tenant_id = $1::uuid
                 AND prompt_template_version IS NOT NULL
             ) versions
      ORDER BY prompt_template_version ASC`,
    [tenantId],
  );
  return result.rows.map((row) => row.prompt_template_version);
}

function readinessSignals(
  policy: AiRuntimePolicyRow,
  models: readonly string[],
  promptVersions: readonly string[],
  evaluated: readonly EvaluatedRequirement[],
  configuredModels: readonly string[] = [],
  configuredPromptVersions: readonly string[] = [],
): Readonly<Record<string, unknown>> {
  return {
    ai_runtime_enabled: true,
    policy_mode: policy.mode,
    grace_active: isGraceActive(policy),
    models,
    configured_models: configuredModels,
    prompt_template_versions: promptVersions,
    configured_prompt_template_versions: configuredPromptVersions,
    requirements: evaluated.map((item) => ({
      evidence_type: item.requirement.evidenceType,
      subject_ref: item.requirement.subjectRef,
      status: item.status,
    })),
  };
}

function normalizeConfiguredRuntimeRefs(values: readonly string[]): string[] {
  return sortedUnique(values.map((value) => {
    const trimmed = value.trim();
    if (trimmed.length === 0 || trimmed.length > 300 || !SAFE_REF_RE.test(trimmed) || SECRET_OR_RAW_RE.test(trimmed)) {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_ai_governance_configured_runtime_ref" });
    }
    return trimmed;
  }));
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}
