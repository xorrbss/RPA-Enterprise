import type {
  ControlPlaneHandler,
  ControlPlaneRequestContext,
  ControlPlaneResponse,
} from "../ts/control-plane-contract";
import type { ControlPlaneHandlerMap } from "./operation-registry";
import type { ApiErrorResponseCode } from "./errors";
import { ApiResponseException } from "./errors";
import type {
  ArtifactAccessGate,
  ArtifactAccessSubject,
  ArtifactRedactionStatus,
  IsoDateTime,
  RunId,
  TenantId,
} from "../ts/security-middleware-contract";
import type { HumanTaskKind, HumanTaskState, RunState, WorkitemState } from "../ts/state-machine-types";
import { HUMANTASK_TERMINAL, RUN_TERMINAL } from "../ts/state-machine-types";

export interface MinimalRun {
  run_id: string;
  tenant_id: string;
  scenario_version_id: string;
  status: RunState;
  attempts: number;
  as_of: string;
  workitem_id?: string;
  worker_id?: string | null;
  progress_node?: string | null;
}

export interface MinimalHumanTask {
  human_task_id: string;
  tenant_id: string;
  state: HumanTaskState;
  kind: HumanTaskKind;
  assignee?: string;
  assignee_role?: string;
  run_id?: string;
  timeout_at?: string;
  on_timeout?: "fail" | "escalate";
  payload?: unknown;
}

export interface MinimalWorkitem {
  workitem_id: string;
  tenant_id: string;
  status: WorkitemState;
  attempts: number;
  unique_reference?: string;
  checked_out_by?: string | null;
  checked_out_at?: string | null;
  run_id?: string;
  target_id?: string;
}

export interface MinimalArtifact {
  artifact_id: string;
  tenant_id: string;
  run_id?: string;
  type?: string;
  media_type?: string | null;
  filename?: string | null;
  byte_size?: number | null;
  duration_ms?: number | null;
  redaction_status: ArtifactRedactionStatus;
  retention_until?: string | null;
  legal_hold?: boolean;
  created_at?: string;
  deleted_at?: string;
  quarantine?: boolean;
  ref: string;
  body: unknown;
}

export interface MinimalGatewayPolicy {
  id: string;
  tenant_id: string;
  model: string;
  version: number;
  capabilities: Readonly<Record<string, unknown>>;
  budget: Readonly<Record<string, unknown>>;
  fallback_config?: unknown;
  is_default?: boolean;
}

export interface MinimalSite {
  site_profile_id: string;
  tenant_id: string;
  risk: "red" | "amber" | "green";
  approved: boolean;
  approval_reason?: string;
  approval_expires_at?: string;
  circuit_state?: "closed" | "open" | "half_open";
}

export interface MinimalControlPlaneSeed {
  runs?: readonly MinimalRun[];
  humanTasks?: readonly MinimalHumanTask[];
  workitems?: readonly MinimalWorkitem[];
  artifacts?: readonly MinimalArtifact[];
  gatewayPolicies?: readonly MinimalGatewayPolicy[];
  sites?: readonly MinimalSite[];
}

export interface MinimalControlPlaneServices {
  createRun(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse>;
  getRun(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse>;
  listRuns(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse>;
  listRunArtifacts(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse>;
  abortRun(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse>;
  validateScenario(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse>;
  promoteScenario(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse>;
  archiveScenario(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse>;
  listScenarioVersions(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse>;
  getScenarioVersion(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse>;
  rollbackScenario(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse>;
  listHumanTasks(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse>;
  startHumanTask(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse>;
  resolveHumanTask(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse>;
  assignHumanTask(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse>;
  escalateHumanTask(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse>;
  listWorkitems(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse>;
  replayDeadLetter(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse>;
  getArtifact(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse>;
  listGatewayPolicies(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse>;
  getGatewayPolicy(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse>;
  createGatewayPolicy(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse>;
  updateGatewayPolicy(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse>;
  deleteGatewayPolicy(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse>;
  listSites(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse>;
  approveSite(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse>;
}

export class InMemoryControlPlaneServices implements MinimalControlPlaneServices {
  private runSequence = 0;
  private readonly runs = new Map<string, MinimalRun>();
  private readonly humanTasks = new Map<string, MinimalHumanTask>();
  private readonly workitems = new Map<string, MinimalWorkitem>();
  private readonly artifacts = new Map<string, MinimalArtifact>();
  private readonly gatewayPolicies = new Map<string, MinimalGatewayPolicy>();
  private readonly sites = new Map<string, MinimalSite>();
  private readonly artifactGate: ArtifactAccessGate;

  constructor(artifactGate: ArtifactAccessGate, seed: MinimalControlPlaneSeed = {}) {
    this.artifactGate = artifactGate;
    for (const run of seed.runs ?? []) this.runs.set(key(run.tenant_id, run.run_id), { ...run });
    for (const task of seed.humanTasks ?? []) {
      this.humanTasks.set(key(task.tenant_id, task.human_task_id), { ...task });
    }
    for (const item of seed.workitems ?? []) this.workitems.set(key(item.tenant_id, item.workitem_id), { ...item });
    for (const artifact of seed.artifacts ?? []) {
      this.artifacts.set(key(artifact.tenant_id, artifact.artifact_id), { ...artifact });
    }
    for (const policy of seed.gatewayPolicies ?? []) {
      this.gatewayPolicies.set(key(policy.tenant_id, policy.model), { ...policy });
    }
    for (const site of seed.sites ?? []) this.sites.set(key(site.tenant_id, site.site_profile_id), { ...site });
  }

  async createRun(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse> {
    const body = requireBody(ctx);
    const runId = `run-${++this.runSequence}`;
    const params = requireRecord(body, "params");
    const asOf = typeof params.as_of === "string" ? params.as_of : new Date().toISOString();
    const run: MinimalRun = {
      run_id: runId,
      tenant_id: tenant(ctx),
      scenario_version_id: requireString(body, "scenario_version_id"),
      status: "queued",
      attempts: 0,
      as_of: asOf,
      workitem_id: optionalString(body, "workitem_id"),
      worker_id: null,
      progress_node: null,
    };
    this.runs.set(key(run.tenant_id, run.run_id), run);
    return { status: 201, body: run };
  }

  async getRun(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse> {
    const run = this.runs.get(key(tenant(ctx), requireParam(ctx, "run_id")));
    if (run === undefined) throw new ApiResponseException("RUN_NOT_FOUND");
    return { status: 200, body: run };
  }

  async listRuns(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse> {
    const status = optionalQueryString(ctx, "status");
    const scenarioVersionId = optionalQueryString(ctx, "scenario_version_id");
    const items = [...this.runs.values()].filter(
      (run) =>
        run.tenant_id === tenant(ctx) &&
        (status === undefined || run.status === status) &&
        (scenarioVersionId === undefined || run.scenario_version_id === scenarioVersionId),
    );
    return page(items);
  }

  async listRunArtifacts(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse> {
    const runId = requireParam(ctx, "run_id");
    const items = [...this.artifacts.values()]
      .filter(
        (artifact) =>
          artifact.tenant_id === tenant(ctx) &&
          artifact.run_id === runId &&
          artifact.deleted_at === undefined &&
          artifact.quarantine !== true &&
          (artifact.redaction_status === "redacted" || artifact.redaction_status === "not_required"),
      )
      .map((artifact) => ({
        artifact_id: artifact.artifact_id,
        type: artifact.type ?? "artifact",
        media_type: artifact.media_type ?? null,
        filename: artifact.filename ?? null,
        byte_size: artifact.byte_size ?? null,
        duration_ms: artifact.duration_ms ?? null,
        redaction_status: artifact.redaction_status,
        retention_until: artifact.retention_until ?? null,
        legal_hold: artifact.legal_hold ?? false,
        created_at: artifact.created_at ?? "1970-01-01T00:00:00.000Z",
      }));
    return page(items);
  }

  async abortRun(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse> {
    const run = this.runs.get(key(tenant(ctx), requireParam(ctx, "run_id")));
    if (run === undefined) throw new ApiResponseException("RUN_NOT_FOUND");
    if (RUN_TERMINAL.includes(run.status) || run.status === "completing") {
      throw new ApiResponseException("RUN_ALREADY_TERMINAL");
    }
    if (run.status === "suspending") {
      throw new ApiResponseException("WORKITEM_CHECKOUT_CONFLICT", {
        reason: "run_bookmark_in_progress",
        status: run.status,
      });
    }

    run.status = "cancelled";
    this.runs.set(key(run.tenant_id, run.run_id), run);
    return { status: 202, body: run };
  }

  async validateScenario(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse> {
    requireParam(ctx, "scenario_id");
    requireBody(ctx);
    return {
      status: 200,
      body: {
        valid: true,
        diagnostics: [],
      },
    };
  }

  async promoteScenario(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse> {
    const nextVersion = requireIfMatchNextVersion(ctx, "SCENARIO_VERSION_CONFLICT");
    const scenarioId = requireParam(ctx, "scenario_id");
    const body = requireBody(ctx);
    const response = {
      scenario_id: scenarioId,
      tenant_id: tenant(ctx),
      version: nextVersion,
      promoted_target: requireString(body, "target"),
    };
    return { status: 200, headers: { ETag: String(nextVersion) }, body: response };
  }

  async archiveScenario(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse> {
    if (ctx.ifMatch?.kind !== "match") {
      throw new ApiResponseException("SCENARIO_VERSION_CONFLICT");
    }
    const scenarioId = requireParam(ctx, "scenario_id");
    const response = {
      scenario_id: scenarioId,
      tenant_id: tenant(ctx),
      version: ctx.ifMatch.currentVersion,
      archived: true,
    };
    return { status: 200, headers: { ETag: String(ctx.ifMatch.currentVersion) }, body: response };
  }

  async listScenarioVersions(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse> {
    const scenarioId = requireParam(ctx, "scenario_id");
    return page([{
      scenario_id: scenarioId,
      version_id: `${scenarioId}:v1`,
      version: 1,
      promotion_status: "draft",
    }]);
  }

  async getScenarioVersion(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse> {
    const scenarioId = requireParam(ctx, "scenario_id");
    const version = Number(requireParam(ctx, "version"));
    const safeVersion = Number.isFinite(version) && version > 0 ? version : 1;
    return {
      status: 200,
      headers: { ETag: String(safeVersion) },
      body: {
        scenario_id: scenarioId,
        version_id: `${scenarioId}:v${safeVersion}`,
        version: safeVersion,
        promotion_status: "draft",
        ir: { meta: { name: scenarioId, version: safeVersion }, start: "done", nodes: { done: { terminal: "success" } } },
      },
    };
  }

  async rollbackScenario(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse> {
    const nextVersion = requireIfMatchNextVersion(ctx, "SCENARIO_VERSION_CONFLICT");
    const scenarioId = requireParam(ctx, "scenario_id");
    const sourceVersion = Number(requireParam(ctx, "version"));
    const response = {
      scenario_id: scenarioId,
      tenant_id: tenant(ctx),
      version: nextVersion,
      promotion_status: "draft",
      rolled_back_from: Number.isFinite(sourceVersion) ? sourceVersion : ctx.params.version,
    };
    return { status: 200, headers: { ETag: String(nextVersion) }, body: response };
  }

  async listHumanTasks(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse> {
    const status = optionalQueryString(ctx, "status");
    const kindFilter = optionalQueryString(ctx, "kind");
    const assignee = optionalQueryString(ctx, "assignee");
    const items = [...this.humanTasks.values()].filter(
      (task) =>
        task.tenant_id === tenant(ctx) &&
        (status === undefined || task.state === status) &&
        (kindFilter === undefined || task.kind === kindFilter) &&
        (assignee === undefined || task.assignee === assignee),
    );
    return page(items);
  }

  async startHumanTask(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse> {
    const task = this.requireHumanTask(ctx);
    ensureHumanTaskOpen(task);
    task.state = "in_progress";
    return { status: 200, body: task };
  }

  async resolveHumanTask(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse> {
    const task = this.requireHumanTask(ctx);
    requireBody(ctx);
    ensureHumanTaskOpen(task);
    task.state = "resolved";
    return { status: 200, body: task };
  }

  async assignHumanTask(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse> {
    const task = this.requireHumanTask(ctx);
    const body = requireBody(ctx);
    ensureHumanTaskOpen(task);
    task.assignee = requireString(body, "assignee");
    task.state = "assigned";
    return { status: 200, body: task };
  }

  async escalateHumanTask(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse> {
    const task = this.requireHumanTask(ctx);
    if (HUMANTASK_TERMINAL.includes(task.state)) throw new ApiResponseException("HUMAN_TASK_EXPIRED");
    if (task.state === "escalated") {
      throw new ApiResponseException("IR_SCHEMA_INVALID", {
        reason: "invalid_state_for_command",
        state: task.state,
      });
    }
    throw new ApiResponseException("CONTROL_PLANE_INTERNAL_ERROR", {
      reason: "human_task_pending_side_effects_unsupported",
      pending: ["reassignAssignee"],
    });
  }

  async listWorkitems(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse> {
    const status = optionalQueryString(ctx, "status");
    const targetId = optionalQueryString(ctx, "target_id");
    const items = [...this.workitems.values()].filter(
      (item) =>
        item.tenant_id === tenant(ctx) &&
        (status === undefined || item.status === status) &&
        (targetId === undefined || item.target_id === targetId),
    );
    return page(items);
  }

  async replayDeadLetter(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse> {
    return {
      status: 202,
      body: {
        dead_letter_id: requireParam(ctx, "dead_letter_id"),
        status: "accepted",
        restored_state: "new",
      },
    };
  }

  async getArtifact(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse> {
    const artifact = this.artifacts.get(key(tenant(ctx), requireParam(ctx, "artifact_id")));
    if (artifact === undefined) throw new ApiResponseException("RESOURCE_NOT_FOUND");

    const subject: ArtifactAccessSubject = {
      artifactId: artifact.artifact_id,
      objectRef: artifact.ref as ArtifactAccessSubject["objectRef"],
      tenantId: ctx.principal.tenantId,
      runId: artifact.run_id as RunId | undefined,
      redactionStatus: artifact.redaction_status,
      deletedAt: artifact.deleted_at as IsoDateTime | undefined,
      quarantine: artifact.quarantine,
    };
    const decision = await this.artifactGate.check(ctx.principal, subject);
    if (decision.kind === "deny") throw new ApiResponseException(decision.code, { stage: decision.stage });

    return {
      status: 200,
      body: {
        artifact_id: artifact.artifact_id,
        ref: decision.objectRef,
        body: artifact.body,
      },
    };
  }

  async listGatewayPolicies(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse> {
    const items = [...this.gatewayPolicies.values()]
      .filter((policy) => policy.tenant_id === tenant(ctx))
      .sort((left, right) => Number(right.is_default === true) - Number(left.is_default === true) || left.model.localeCompare(right.model));
    return page(items);
  }

  async getGatewayPolicy(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse> {
    const model = optionalQueryString(ctx, "model") ?? "default";
    return { status: 200, body: this.gatewayPolicy(ctx.principal.tenantId, model) };
  }

  async createGatewayPolicy(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse> {
    const body = requireBody(ctx);
    const model = requireString(body, "model");
    const mapKey = key(tenant(ctx), model);
    if (this.gatewayPolicies.has(mapKey)) {
      throw new ApiResponseException("IR_SCHEMA_INVALID", { reason: "policy_model_in_use", model });
    }
    const policy: MinimalGatewayPolicy = {
      id: `gateway-policy:${model}`,
      tenant_id: tenant(ctx),
      model,
      version: 1,
      capabilities: requireRecord(body, "capabilities"),
      budget: requireRecord(body, "budget"),
      fallback_config: body.fallback_config ?? body.fallback,
      is_default: body.is_default === true,
    };
    this.gatewayPolicies.set(mapKey, policy);
    return { status: 201, headers: { ETag: "1" }, body: policy };
  }

  async updateGatewayPolicy(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse> {
    const nextVersion = requireIfMatchNextVersion(ctx, "POLICY_VERSION_CONFLICT");
    const body = requireBody(ctx);
    const model = requireString(body, "model");
    const policy: MinimalGatewayPolicy = {
      id: `gateway-policy:${model}`,
      tenant_id: tenant(ctx),
      model,
      version: nextVersion,
      capabilities: requireRecord(body, "capabilities"),
      budget: requireRecord(body, "budget"),
      fallback_config: body.fallback_config ?? body.fallback,
      is_default: body.is_default === true,
    };
    this.gatewayPolicies.set(key(policy.tenant_id, policy.model), policy);
    return { status: 200, headers: { ETag: String(nextVersion) }, body: policy };
  }

  async deleteGatewayPolicy(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse> {
    if (ctx.ifMatch?.kind !== "match") {
      throw new ApiResponseException("POLICY_VERSION_CONFLICT");
    }
    const model = requireQueryString(ctx, "model");
    const mapKey = key(tenant(ctx), model);
    if (!this.gatewayPolicies.delete(mapKey)) {
      throw new ApiResponseException("RESOURCE_NOT_FOUND");
    }
    return { status: 200, body: { model, deleted: true } };
  }

  async listSites(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse> {
    const risk = optionalQueryString(ctx, "risk");
    const items = [...this.sites.values()].filter(
      (site) => site.tenant_id === tenant(ctx) && (risk === undefined || site.risk === risk),
    );
    return page(items);
  }

  async approveSite(ctx: ControlPlaneRequestContext): Promise<ControlPlaneResponse> {
    const siteId = requireParam(ctx, "site_profile_id");
    const mapKey = key(tenant(ctx), siteId);
    const site =
      this.sites.get(mapKey) ??
      ({
        site_profile_id: siteId,
        tenant_id: tenant(ctx),
        risk: "red",
        approved: false,
        circuit_state: "closed",
      } satisfies MinimalSite);
    const body = isRecord(ctx.body) ? ctx.body : {};
    site.approved = true;
    site.approval_reason = optionalString(body, "reason");
    site.approval_expires_at = optionalString(body, "expires_at");
    this.sites.set(mapKey, site);
    return { status: 200, body: site };
  }

  getHumanTaskForAuthorization(tenantId: TenantId, humanTaskId: string): MinimalHumanTask | undefined {
    return this.humanTasks.get(key(tenantId, humanTaskId));
  }

  private requireHumanTask(ctx: ControlPlaneRequestContext): MinimalHumanTask {
    const task = this.humanTasks.get(key(tenant(ctx), requireParam(ctx, "human_task_id")));
    if (task === undefined) throw new ApiResponseException("RESOURCE_NOT_FOUND");
    return task;
  }

  private gatewayPolicy(tenantId: TenantId, model: string): MinimalGatewayPolicy {
    const existing = this.gatewayPolicies.get(key(tenantId, model));
    if (existing !== undefined) return existing;
    return {
      id: `gateway-policy:${model}`,
      tenant_id: tenantId,
      model,
      version: 1,
      capabilities: {},
      budget: {},
    };
  }
}

export function createMinimalControlPlaneHandlers(services: MinimalControlPlaneServices): ControlPlaneHandlerMap {
  const bind = (handler: (ctx: ControlPlaneRequestContext) => Promise<ControlPlaneResponse>): ControlPlaneHandler =>
    handler.bind(services);

  return {
    createRun: bind(services.createRun),
    getRun: bind(services.getRun),
    listRuns: bind(services.listRuns),
    listRunArtifacts: bind(services.listRunArtifacts),
    abortRun: bind(services.abortRun),
    validateScenario: bind(services.validateScenario),
    promoteScenario: bind(services.promoteScenario),
    archiveScenario: bind(services.archiveScenario),
    listScenarioVersions: bind(services.listScenarioVersions),
    getScenarioVersion: bind(services.getScenarioVersion),
    rollbackScenario: bind(services.rollbackScenario),
    listHumanTasks: bind(services.listHumanTasks),
    startHumanTask: bind(services.startHumanTask),
    resolveHumanTask: bind(services.resolveHumanTask),
    assignHumanTask: bind(services.assignHumanTask),
    escalateHumanTask: bind(services.escalateHumanTask),
    listWorkitems: bind(services.listWorkitems),
    replayDeadLetter: bind(services.replayDeadLetter),
    getArtifact: bind(services.getArtifact),
    listGatewayPolicies: bind(services.listGatewayPolicies),
    getGatewayPolicy: bind(services.getGatewayPolicy),
    createGatewayPolicy: bind(services.createGatewayPolicy),
    updateGatewayPolicy: bind(services.updateGatewayPolicy),
    deleteGatewayPolicy: bind(services.deleteGatewayPolicy),
    listSites: bind(services.listSites),
    approveSite: bind(services.approveSite),
  };
}

function key(tenantId: string, id: string): string {
  return `${tenantId}:${id}`;
}

function tenant(ctx: ControlPlaneRequestContext): string {
  return ctx.principal.tenantId;
}

function page(items: readonly unknown[]): ControlPlaneResponse {
  return { status: 200, body: { items, next_cursor: null } };
}

function ensureHumanTaskOpen(task: MinimalHumanTask): void {
  if (HUMANTASK_TERMINAL.includes(task.state)) {
    throw new ApiResponseException("HUMAN_TASK_EXPIRED");
  }
}

function requireParam(ctx: ControlPlaneRequestContext, name: string): string {
  const value = ctx.params[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new ApiResponseException("IR_SCHEMA_INVALID", { reason: "missing_path_param", name });
  }
  return value;
}

function optionalQueryString(ctx: ControlPlaneRequestContext, name: string): string | undefined {
  const value = ctx.query[name];
  if (Array.isArray(value)) return value[0];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function requireQueryString(ctx: ControlPlaneRequestContext, name: string): string {
  const value = optionalQueryString(ctx, name);
  if (value === undefined) {
    throw new ApiResponseException("IR_SCHEMA_INVALID", { reason: "missing_query_param", name });
  }
  return value;
}

function requireBody(ctx: ControlPlaneRequestContext): Record<string, unknown> {
  if (!isRecord(ctx.body)) {
    throw new ApiResponseException("IR_SCHEMA_INVALID", { reason: "expected_object_body" });
  }
  return ctx.body;
}

function requireString(record: Readonly<Record<string, unknown>>, keyName: string): string {
  const value = record[keyName];
  if (typeof value !== "string" || value.length === 0) {
    throw new ApiResponseException("IR_SCHEMA_INVALID", { reason: "missing_required_string", key: keyName });
  }
  return value;
}

function optionalString(record: Readonly<Record<string, unknown>>, keyName: string): string | undefined {
  const value = record[keyName];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function requireRecord(record: Readonly<Record<string, unknown>>, keyName: string): Readonly<Record<string, unknown>> {
  const value = record[keyName];
  if (!isRecord(value)) {
    throw new ApiResponseException("IR_SCHEMA_INVALID", { reason: "missing_required_object", key: keyName });
  }
  return value;
}

function requireIfMatchNextVersion(ctx: ControlPlaneRequestContext, code: ApiErrorResponseCode): number {
  if (ctx.ifMatch?.kind !== "match") {
    throw new ApiResponseException(code);
  }
  return ctx.ifMatch.nextVersion;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
