import { randomUUID } from "node:crypto";

import type { PoolClient } from "pg";

import type { LLMRequest } from "../../../ts/security-middleware-contract";
import { withTenantTx, type PgPool } from "../db/pool";
import type { AiGovernanceGatewayDecision, AiGovernanceGatewayGuard } from "../gateway/llm-gateway";
import { isRecord, type CommandResponse } from "./command";
import { ApiResponseError } from "../runtime/errors";

export type AiRuntimePolicyMode = "observe" | "warn" | "block";
type AiEvidenceType = "model_registry" | "prompt_registry" | "eval_result" | "cost_control";
type EvidenceRequirementStatus = "valid" | "missing" | "failed" | "expired" | "deferred";

interface AiRuntimePolicyRow {
  readonly id: string;
  readonly mode: AiRuntimePolicyMode;
  readonly subject_mapping_ref: string;
  readonly grace_until: Date | null;
  readonly emergency_override_owner_ref: string;
  readonly audit_action: "ai_governance.enforce";
  readonly policy_decision_ref: string;
  readonly evidence_ref: string | null;
  readonly updated_by: string;
  readonly created_at: Date;
  readonly updated_at: Date;
}

export interface AiRuntimePolicyInput {
  readonly mode: AiRuntimePolicyMode;
  readonly subjectMappingRef: string;
  readonly graceUntil: Date | null;
  readonly emergencyOverrideOwnerRef: string;
  readonly policyDecisionRef: string;
  readonly evidenceRef: string | null;
}

export interface AiGovernanceRuntimeDecision {
  readonly kind: "allow" | "warn" | "block";
  readonly mode: AiRuntimePolicyMode | "not_configured" | "not_applicable";
  readonly reason: string;
  readonly evidenceRefs: readonly string[];
  readonly policyDecisionRef?: string;
  readonly blockingRequirements: readonly string[];
}

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

interface EvidenceRequirement {
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

interface EvaluatedRequirement {
  readonly requirement: EvidenceRequirement;
  readonly status: EvidenceRequirementStatus;
  readonly evidenceRef: string | null;
  readonly policyDecisionRef: string | null;
}

const SAFE_REF_RE = /^[A-Za-z0-9][A-Za-z0-9_.:/@# -]*$/;
const SECRET_OR_RAW_RE = /(https?:\/\/|hooks\.slack\.com|\bbearer\s+[a-z0-9._~+/=-]{8,}|\b(api[_-]?key|access[_-]?key|private[_-]?key|secret|token|password|credential|authorization)\s*[:=]\s*\S{4,}|\b(token|password|secret)=)/i;
const AI_GOVERNANCE_READINESS_ENABLED_EVIDENCE = "ai_runtime_enabled=true";
const ISO_8601_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

export function parseAiRuntimePolicyRequest(raw: unknown): AiRuntimePolicyInput {
  if (!isRecord(raw)) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "ai_runtime_policy_body_expected_object" });
  const allowed = new Set([
    "mode",
    "subject_mapping_ref",
    "grace_until",
    "emergency_override_owner_ref",
    "policy_decision_ref",
    "evidence_ref",
  ]);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "ai_runtime_policy_unknown_field", field: key });
  }
  const mode = parsePolicyMode(raw.mode);
  const graceUntil = raw.grace_until === undefined || raw.grace_until === null || raw.grace_until === ""
    ? null
    : parseFutureIsoDate(raw.grace_until, "grace_until");
  return {
    mode,
    subjectMappingRef: parseSafePolicyRef(raw.subject_mapping_ref, "subject_mapping_ref", 300),
    graceUntil,
    emergencyOverrideOwnerRef: parseSafePolicyRef(raw.emergency_override_owner_ref, "emergency_override_owner_ref", 300),
    policyDecisionRef: parseSafePolicyRef(raw.policy_decision_ref, "policy_decision_ref", 300),
    evidenceRef: raw.evidence_ref === undefined || raw.evidence_ref === null || raw.evidence_ref === ""
      ? null
      : parseSafePolicyRef(raw.evidence_ref, "evidence_ref", 500),
  };
}

export async function readAiRuntimePolicy(client: PoolClient, tenantId: string): Promise<Record<string, unknown> | null> {
  const row = await readAiRuntimePolicyRow(client, tenantId);
  return row === null ? null : mapAiRuntimePolicy(row);
}

export async function upsertAiRuntimePolicy(
  client: PoolClient,
  tenantId: string,
  updatedBy: string,
  input: AiRuntimePolicyInput,
): Promise<CommandResponse> {
  const existing = await readAiRuntimePolicyRow(client, tenantId);
  const values = [
    input.mode,
    input.subjectMappingRef,
    input.graceUntil?.toISOString() ?? null,
    input.emergencyOverrideOwnerRef,
    input.policyDecisionRef,
    input.evidenceRef,
    updatedBy,
  ];
  if (existing === null) {
    const result = await client.query<AiRuntimePolicyRow>(
      `INSERT INTO ai_runtime_policies (
         id, tenant_id, mode, subject_mapping_ref, grace_until,
         emergency_override_owner_ref, policy_decision_ref, evidence_ref, updated_by
       )
       VALUES ($1::uuid, $2::uuid, $3, $4, $5::timestamptz, $6, $7, $8, $9)
       RETURNING id::text, mode, subject_mapping_ref, grace_until,
                 emergency_override_owner_ref, audit_action, policy_decision_ref,
                 evidence_ref, updated_by, created_at, updated_at`,
      [randomUUID(), tenantId, ...values],
    );
    return { status: 201, body: mapAiRuntimePolicy(result.rows[0]) };
  }

  const result = await client.query<AiRuntimePolicyRow>(
    `UPDATE ai_runtime_policies
        SET mode = $2,
            subject_mapping_ref = $3,
            grace_until = $4::timestamptz,
            emergency_override_owner_ref = $5,
            policy_decision_ref = $6,
            evidence_ref = $7,
            updated_by = $8,
            updated_at = now()
      WHERE tenant_id = $1::uuid
        AND id = $9::uuid
        AND deleted_at IS NULL
      RETURNING id::text, mode, subject_mapping_ref, grace_until,
                emergency_override_owner_ref, audit_action, policy_decision_ref,
                evidence_ref, updated_by, created_at, updated_at`,
    [tenantId, ...values, existing.id],
  );
  return { status: 200, body: mapAiRuntimePolicy(result.rows[0]) };
}

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

function mapAiRuntimePolicy(row: AiRuntimePolicyRow): Record<string, unknown> {
  return {
    policy_id: row.id,
    mode: row.mode,
    subject_mapping_ref: row.subject_mapping_ref,
    grace_until: row.grace_until?.toISOString() ?? null,
    emergency_override_owner_ref: row.emergency_override_owner_ref,
    audit_action: row.audit_action,
    policy_decision_ref: row.policy_decision_ref,
    evidence_ref: row.evidence_ref,
    updated_by: row.updated_by,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

async function readAiRuntimePolicyRow(client: PoolClient, tenantId: string): Promise<AiRuntimePolicyRow | null> {
  const result = await client.query<AiRuntimePolicyRow>(
    `SELECT id::text, mode, subject_mapping_ref, grace_until,
            emergency_override_owner_ref, audit_action, policy_decision_ref,
            evidence_ref, updated_by, created_at, updated_at
       FROM ai_runtime_policies
      WHERE tenant_id = $1::uuid
        AND deleted_at IS NULL
      ORDER BY updated_at DESC, id DESC
      LIMIT 1`,
    [tenantId],
  );
  return result.rows[0] ?? null;
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

function readinessRequirements(models: readonly string[], promptVersions: readonly string[], tenantId: string): EvidenceRequirement[] {
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

function runtimeRequirements(model: string | null, promptVersion: string | null, tenantId: string): EvidenceRequirement[] {
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

async function evaluateEvidenceRequirements(
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

function modelSubject(model: string): string {
  return `model:${model}`;
}

function promptSubject(promptTemplateVersion: string): string {
  return `prompt:${promptTemplateVersion}`;
}

function tenantCostControlSubject(tenantId?: string): string {
  return tenantId === undefined ? "tenant:current:ai_cost_control" : `tenant:${tenantId}:ai_cost_control`;
}

function isGraceActive(policy: Pick<AiRuntimePolicyRow, "grace_until">): boolean {
  return policy.grace_until !== null && policy.grace_until.getTime() > Date.now();
}

function parsePolicyMode(raw: unknown): AiRuntimePolicyMode {
  if (raw === "observe" || raw === "warn" || raw === "block") return raw;
  throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_ai_runtime_policy_mode" });
}

function parseFutureIsoDate(raw: unknown, field: string): Date {
  if (typeof raw !== "string" || raw.length === 0) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_iso_datetime", field });
  if (!isStrictIsoDateTime(raw)) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_iso_datetime", field });
  const date = new Date(raw);
  if (!Number.isFinite(date.getTime())) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_iso_datetime", field });
  if (date.getTime() <= Date.now()) throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: `${field}_must_be_future`, field });
  return date;
}

function isStrictIsoDateTime(value: string): boolean {
  const match = ISO_8601_RE.exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, offsetText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (month < 1 || month > 12) return false;
  if (hour > 23 || minute > 59 || second > 59) return false;
  if (offsetText !== "Z") {
    const offsetHour = Number(offsetText.slice(1, 3));
    const offsetMinute = Number(offsetText.slice(4, 6));
    if (offsetHour > 23 || offsetMinute > 59) return false;
  }
  return day >= 1 && day <= daysInMonth(year, month);
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function parseSafePolicyRef(raw: unknown, field: string, max: number): string {
  if (typeof raw !== "string") throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: `invalid_${field}` });
  const value = raw.trim();
  if (value.length === 0 || value.length > max || !SAFE_REF_RE.test(value)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: `invalid_${field}` });
  }
  if (SECRET_OR_RAW_RE.test(value)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "secret_material_or_raw_endpoint_forbidden", field });
  }
  return value;
}
