import type { AuthenticatedPrincipal } from "../../../ts/security-middleware-contract";
import type { CompileOutcome } from "./compile-pipeline";

export type ScenarioPlannerId = "deterministic_mvp" | "llm_v1";

export type GenerationMode = "draft_only" | "save" | "save_and_run";
export type GenerationStatus = "drafted" | "saved" | "run_queued" | "blocked" | "failed";

export interface EvidencePolicy {
  screenshot: "never" | "failure" | "each_step";
  video: "never" | "failure" | "always";
}

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
