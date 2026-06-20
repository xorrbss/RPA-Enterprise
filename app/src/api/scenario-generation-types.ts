import type { AuthenticatedPrincipal } from "../../../ts/security-middleware-contract";
import type { CompileOutcome } from "./compile-pipeline";

export type ScenarioPlannerId = "deterministic_mvp" | "llm_v1";

export type GenerationMode = "draft_only" | "save" | "save_and_run";
export type GenerationStatus = "drafted" | "saved" | "run_queued" | "blocked" | "failed";

export interface EvidencePolicy {
  screenshot: "never" | "failure" | "each_step";
  video: "never" | "failure" | "always";
}

/**
 * start_url 기반 런타임 target 추론이 단일 후보로 좁히지 못한 구체 사유.
 * 명시 target 검증(runtimeTargetBlocker)의 `*_not_found`/`*_mismatch` 와는 별개 경로다(추론 vs 명시).
 * "조용한 false/unknown 금지": 0건/다건/후보부재를 generic blocker로 뭉개지 않고 사유를 보존한다.
 */
export type RuntimeTargetInferenceBlocker =
  | "site_profile_unresolved_for_start_url"
  | "site_profile_ambiguous_for_start_url"
  | "browser_identity_unresolved_for_start_url"
  | "network_policy_unresolved_for_start_url"
  | "network_policy_ambiguous_for_start_url";

export interface GenerationRequest {
  prompt: string;
  name?: string;
  mode: GenerationMode;
  planner?: ScenarioPlannerId;
  startUrl?: string;
  target?: {
    site_profile_id: string;
    browser_identity_id: string;
    network_policy_id: string;
  };
  params: Record<string, unknown>;
  model?: string | null;
  evidence: EvidencePolicy;
  /**
   * 추론이 실패했을 때(target 미확정) 그 구체 사유. inferRuntimeTargetForRequest 가 채우고
   * finalizePlannerEvidence 가 blocker 로 방출한다. target 이 확정되면 설정되지 않는다(상호 배타).
   */
  inferenceBlocker?: RuntimeTargetInferenceBlocker;
}

export interface GenerationRunRequest {
  target?: NonNullable<GenerationRequest["target"]>;
  startUrl?: string;
  params: Record<string, unknown>;
  paramsProvided: boolean;
  model?: string | null;
  evidence?: EvidencePolicy;
}

export interface GenerationPlan {
  planner: ScenarioPlannerId;
  request: GenerationRequest;
  promptHash: string;
  draftIr: Record<string, unknown>;
  blockers: readonly string[];
}

export interface GenerationCapabilities {
  videoRecording: boolean;
}

export interface ScenarioPlannerContext {
  readonly tenantId: string;
  readonly correlationId: string;
  readonly generationId: string;
  readonly principal?: Pick<AuthenticatedPrincipal, "subjectId" | "roles">;
}

export interface ScenarioPlanner {
  readonly id: ScenarioPlannerId;
  plan(
    request: GenerationRequest,
    capabilities: GenerationCapabilities,
    context: ScenarioPlannerContext,
  ): GenerationPlan | Promise<GenerationPlan>;
  repair?(input: ScenarioPlannerRepairInput): GenerationPlan | Promise<GenerationPlan>;
}

export interface ScenarioPlannerRepairInput {
  readonly request: GenerationRequest;
  readonly capabilities: GenerationCapabilities;
  readonly context: ScenarioPlannerContext;
  readonly failedPlan: GenerationPlan;
  readonly compileError: Extract<CompileOutcome, { ok: false }>;
  readonly attempt: number;
}
