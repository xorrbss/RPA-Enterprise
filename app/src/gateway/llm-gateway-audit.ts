/**
 * Gateway 보안 감사 append 헬퍼 — prompt.inspect(§4 step2 redaction/injection 판정) + ai_governance.enforce
 * 결정의 fail-closed durable 기록(LlmGateway.call 경로 전용). append 실패는 CONTROL_PLANE_INTERNAL_ERROR 로 종결.
 */
import { randomUUID } from "node:crypto";

import type {
  CorrelationId,
  DurableSecurityAuditDecisionWriter,
  GatewayRedactionBoundary,
  IdempotencyKey,
  IsoDateTime,
  LLMRequest,
  PrincipalId,
  Role,
} from "../../../ts/security-middleware-contract";
import { SECURITY_AUDIT_PAYLOAD_SCHEMA_REF } from "../../../ts/security-middleware-contract";
import { GatewayError } from "./gateway-errors";
import type { AiGovernanceGatewayDecision } from "./llm-gateway";

const PROMPT_INSPECT_AUDIT_RETENTION_DAYS = 90;
const AI_GOVERNANCE_AUDIT_RETENTION_DAYS = 365;

export async function recordPromptInspectDecision(
  securityAudit: DurableSecurityAuditDecisionWriter,
  req: LLMRequest,
  result: Awaited<ReturnType<GatewayRedactionBoundary["redactForGateway"]>>,
  input: { phase: "initial" | "repair"; messageIndex: number },
): Promise<void> {
  const occurredAt = new Date();
  const actor = req.metadata.auditActor ?? runtimePromptInspectActor();
  const outcome = result.kind === "blocked" ? "blocked" : "allow";
  try {
    await securityAudit.recordDecision(
      {
        tenantId: req.metadata.tenantId,
        actor,
        action: "prompt.inspect",
        outcome,
        resource: { kind: "run", id: req.metadata.runId },
        reason: result.kind === "blocked" ? "prompt_injection_detected" : "prompt_inspection_clean",
        correlationId: req.metadata.correlationId as CorrelationId,
        idempotencyKey: randomUUID() as IdempotencyKey,
        occurredAt: occurredAt.toISOString() as IsoDateTime,
        retentionUntil: new Date(
          occurredAt.getTime() + PROMPT_INSPECT_AUDIT_RETENTION_DAYS * 24 * 60 * 60 * 1000,
        ).toISOString() as IsoDateTime,
        payloadSchemaRef: SECURITY_AUDIT_PAYLOAD_SCHEMA_REF,
        failClosed: true,
        payload: {
          decision_kind: "prompt.inspect",
          phase: input.phase,
          message_index: input.messageIndex,
          primitive: req.metadata.primitive,
          step_id: req.metadata.stepId,
          attempt: req.metadata.attempt,
          prompt_template_version: req.promptTemplateVersion,
          model: req.model,
          evidence_signals: result.kind === "blocked" ? result.evidence.map((e) => e.signal) : [],
        },
      },
      { prompt_inspection: outcome, phase: input.phase },
    );
  } catch {
    throw new GatewayError("CONTROL_PLANE_INTERNAL_ERROR", "prompt inspect audit append failed closed");
  }
}

export async function recordAiGovernanceDecision(
  securityAudit: DurableSecurityAuditDecisionWriter,
  req: LLMRequest,
  result: AiGovernanceGatewayDecision,
): Promise<void> {
  const occurredAt = new Date();
  const actor = req.metadata.auditActor ?? runtimePromptInspectActor();
  const outcome = result.kind === "block" ? "blocked" : "allow";
  try {
    await securityAudit.recordDecision(
      {
        tenantId: req.metadata.tenantId,
        actor,
        action: "ai_governance.enforce",
        outcome,
        resource: { kind: "run", id: req.metadata.runId },
        reason: result.reason,
        correlationId: req.metadata.correlationId as CorrelationId,
        idempotencyKey: randomUUID() as IdempotencyKey,
        occurredAt: occurredAt.toISOString() as IsoDateTime,
        retentionUntil: new Date(
          occurredAt.getTime() + AI_GOVERNANCE_AUDIT_RETENTION_DAYS * 24 * 60 * 60 * 1000,
        ).toISOString() as IsoDateTime,
        payloadSchemaRef: SECURITY_AUDIT_PAYLOAD_SCHEMA_REF,
        failClosed: true,
        payload: {
          decision_kind: "ai_governance.enforce",
          enforcement_result: result.kind,
          mode: result.mode,
          primitive: req.metadata.primitive,
          step_id: req.metadata.stepId,
          attempt: req.metadata.attempt,
          prompt_template_version: req.promptTemplateVersion,
          model: req.model,
          evidence_refs: result.evidenceRefs,
          blocking_requirements: result.blockingRequirements,
          policy_decision_ref: result.policyDecisionRef ?? null,
        },
      },
      { ai_governance: result.kind, mode: result.mode },
    );
  } catch {
    throw new GatewayError("CONTROL_PLANE_INTERNAL_ERROR", "AI governance audit append failed closed");
  }
}

function runtimePromptInspectActor(): { subjectId: PrincipalId; roles: readonly Role[] } {
  return { subjectId: "runtime-worker" as PrincipalId, roles: ["operator"] };
}
