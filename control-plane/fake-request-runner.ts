import { createHash, randomUUID } from "node:crypto";
import { ERROR_CATALOG, type ApiError } from "../ts/error-catalog";
import type {
  BoundaryValidator,
  ControlPlaneBoundaryDependencies,
  ControlPlaneHeaders,
  ControlPlaneRequestContext,
  ControlPlaneResponse,
  FastifyRouteScaffold,
  HttpMethod,
  IdempotencyRecordStatus,
  IdempotencyReservation,
  IdempotencyReservationRequest,
  IfMatchCheck,
  IfMatchDecision,
  OpenApiOperationBinding,
  StoredIdempotentResponse,
} from "../ts/control-plane-contract";
import type {
  ArtifactAccessDecision,
  ArtifactAccessGate,
  ArtifactAccessSubject,
  AuthBoundaryResult,
  AuthenticatedPrincipal,
  AuthenticationBoundary,
  AuthorizationCheck,
  AuthorizationDecision,
  CanonicalRequestHash,
  IdempotencyKey,
  PrincipalId,
  RbacAction,
  RbacMiddleware,
  Role,
  TenantId,
  TenantSessionBinder,
} from "../ts/security-middleware-contract";
import {
  CONTROL_PLANE_OPERATION_BINDINGS,
  createControlPlaneValidatorRegistry,
  createFastifyCompatibleRoutes,
  createRouteBinder,
  staticRbacAction,
} from "./operation-registry";
import type { ControlPlaneHandlerMap, FastifyLikeRouteOptions } from "./operation-registry";
import { apiErrorResponse, ApiResponseException, exceptionResponse, toApiError } from "./errors";
import type { ApiErrorResponseCode } from "./errors";
import {
  createMinimalControlPlaneHandlers,
  InMemoryControlPlaneServices,
  type MinimalControlPlaneSeed,
} from "./minimal-handlers";
import type { HumanTaskKind } from "../ts/state-machine-types";

export interface FakeControlPlaneRequest {
  method: HttpMethod;
  url: string;
  headers?: Readonly<Record<string, string | undefined>>;
  body?: unknown;
}

export interface ControlPlaneAuthorizationResolver {
  resolve(ctx: ControlPlaneRequestContext, operation: OpenApiOperationBinding): Promise<AuthorizationCheck | undefined>;
}

export interface FakeControlPlaneRunnerOptions {
  routes: readonly FastifyRouteScaffold[];
  deps: ControlPlaneBoundaryDependencies;
  authorizationResolver?: ControlPlaneAuthorizationResolver;
  idempotencyTtlMs?: number;
}

interface CompiledRoute {
  route: FastifyRouteScaffold;
  pattern: RegExp;
  paramNames: readonly string[];
}

interface IdempotencyRow {
  recordId: string;
  requestHash: CanonicalRequestHash;
  status: IdempotencyRecordStatus;
  response?: StoredIdempotentResponse;
  error?: ApiError;
}

export class FakeControlPlaneRunner {
  private readonly compiledRoutes: readonly CompiledRoute[];
  private readonly deps: ControlPlaneBoundaryDependencies;
  private readonly authorizationResolver?: ControlPlaneAuthorizationResolver;
  private readonly idempotencyTtlMs: number;

  constructor(options: FakeControlPlaneRunnerOptions) {
    this.compiledRoutes = options.routes.map(compileRoute);
    this.deps = options.deps;
    this.authorizationResolver = options.authorizationResolver;
    this.idempotencyTtlMs = options.idempotencyTtlMs ?? 24 * 60 * 60 * 1000;
  }

  async inject(request: FakeControlPlaneRequest): Promise<ControlPlaneResponse> {
    const parsedUrl = parseUrl(request.url);
    const headers = normalizeHeaders(request.headers ?? {});
    const correlationId = headers["x-correlation-id"] ?? randomUUID();
    const match = this.matchRoute(request.method, parsedUrl.pathname);
    if (match === undefined) {
      return apiErrorResponse("RESOURCE_NOT_FOUND", correlationId, {
        reason: "unmatched_route",
        method: request.method,
        path: parsedUrl.pathname,
      });
    }

    const authResult = await this.deps.authn.authenticate(headers);
    if (authResult.kind === "denied") {
      return apiErrorResponse(authResult.code, correlationId, { reason: authResult.reason });
    }

    const tenantBinding = this.deps.tenant.bindTenant(authResult.principal);
    const params = validateBoundary(match.route.validators.params, match.params, correlationId) as Readonly<
      Record<string, string>
    >;
    const query = validateBoundary(match.route.validators.query, parseQuery(parsedUrl), correlationId) as Readonly<
      Record<string, string | readonly string[] | undefined>
    >;
    const body = validateBoundary(match.route.validators.body, request.body, correlationId);
    const requestHash = canonicalRequestHash(request.method, parsedUrl.pathname, body);
    const operation = this.deps.validators.getOperation(match.route.operationId);
    const controlHeaders: ControlPlaneHeaders = {
      authorization: headers.authorization,
      "idempotency-key": headers["idempotency-key"] as IdempotencyKey | undefined,
      "if-match": headers["if-match"],
      "x-correlation-id": correlationId,
    };

    let ctx: ControlPlaneRequestContext = {
      method: request.method,
      path: match.route.url,
      operationId: match.route.operationId,
      headers: controlHeaders,
      params,
      query,
      body,
      principal: authResult.principal,
      tenantBinding,
      correlationId,
      requestHash,
    };

    const authorization = await this.authorizeIfNeeded(ctx, operation);
    if (authorization !== undefined) {
      ctx = { ...ctx, authorization };
      if (authorization.kind === "deny") {
        return apiErrorResponse(authorization.code, correlationId);
      }
    }

    let reservation: IdempotencyReservation | undefined;
    try {
      reservation = await this.reserveIdempotencyIfNeeded(operation, ctx, parsedUrl.pathname);
    } catch (error) {
      if (error instanceof ApiResponseException) {
        return exceptionResponse(error, correlationId);
      }
      throw error;
    }
    if (reservation?.kind === "replay") return reservation.response;

    const reservedRecordId = reservation?.kind === "reserved" ? reservation.recordId : undefined;

    const fail = async (code: ApiErrorResponseCode, details?: unknown): Promise<ControlPlaneResponse> => {
      const response = apiErrorResponse(code, correlationId, details);
      if (reservedRecordId !== undefined) {
        await this.deps.idempotency.saveFailure(reservedRecordId, response.body as ApiError);
      }
      return response;
    };

    const ifMatchDecision = await this.checkIfMatchIfNeeded(operation, ctx);
    if (ifMatchDecision !== undefined) {
      ctx = { ...ctx, ifMatch: ifMatchDecision };
      if (ifMatchDecision.kind === "conflict") {
        return fail(ifMatchDecision.code, { currentVersion: ifMatchDecision.currentVersion });
      }
      if (ifMatchDecision.kind === "missing") {
        return fail(ifMatchDecision.code, { reason: "missing_if_match" });
      }
    }

    try {
      const response = await match.route.handler({ ...ctx, idempotency: reservation });
      if (reservedRecordId !== undefined) {
        await this.deps.idempotency.saveResult(reservedRecordId, response);
      }
      return response;
    } catch (error) {
      if (error instanceof ApiResponseException) {
        const response = exceptionResponse(error, correlationId);
        if (reservedRecordId !== undefined) {
          await this.deps.idempotency.saveFailure(reservedRecordId, response.body as ApiError);
        }
        return response;
      }
      throw error;
    }
  }

  private matchRoute(
    method: HttpMethod,
    pathname: string,
  ): { route: FastifyRouteScaffold; params: Record<string, string> } | undefined {
    for (const item of this.compiledRoutes) {
      if (item.route.method !== method) continue;
      const match = item.pattern.exec(pathname);
      if (match === null) continue;

      const params: Record<string, string> = {};
      for (let index = 0; index < item.paramNames.length; index += 1) {
        params[item.paramNames[index]] = decodeURIComponent(match[index + 1] ?? "");
      }
      return { route: item.route, params };
    }

    return undefined;
  }

  private async reserveIdempotencyIfNeeded(
    operation: OpenApiOperationBinding,
    ctx: ControlPlaneRequestContext,
    pathname: string,
  ): Promise<IdempotencyReservation | undefined> {
    if (!operation.requiresIdempotencyKey) return undefined;

    const key = ctx.headers["idempotency-key"];
    if (key === undefined || key.length === 0) {
      throw new ApiResponseException("IR_SCHEMA_INVALID", {
        reason: "missing_idempotency_key",
        header: "Idempotency-Key",
      });
    }

    const reservation = await this.deps.idempotency.reserve({
      tenantId: ctx.principal.tenantId,
      endpoint: operation.operationId,
      key,
      requestHash: canonicalRequestHash(ctx.method, pathname, ctx.body),
      expiresAt: new Date(Date.now() + this.idempotencyTtlMs).toISOString(),
    });

    if (reservation.kind === "blocked") {
      throw new ApiResponseException("SCENARIO_VERSION_CONFLICT", {
        reason: "idempotency_request_hash_mismatch",
      });
    }

    if (reservation.kind === "in_flight") {
      throw new ApiResponseException("WORKITEM_CHECKOUT_CONFLICT", {
        reason: "idempotency_in_flight",
        retryable: true,
      });
    }

    return reservation;
  }

  private async checkIfMatchIfNeeded(
    operation: OpenApiOperationBinding,
    ctx: ControlPlaneRequestContext,
  ): Promise<IfMatchDecision | undefined> {
    if (operation.ifMatch === undefined) return undefined;

    const header = ctx.headers["if-match"];
    const normalizedHeader = header?.replace(/^W\//, "").replace(/^"|"$/g, "");
    const expectedVersion = normalizedHeader === undefined ? Number.NaN : Number.parseInt(normalizedHeader, 10);
    if (!Number.isInteger(expectedVersion)) {
      return { kind: "missing", code: operation.ifMatch.conflictCode };
    }

    const check: IfMatchCheck = {
      tenantId: ctx.principal.tenantId,
      entity: operation.ifMatch.entity,
      resourceId: ifMatchResourceId(operation, ctx),
      expectedVersion,
      conflictCode: operation.ifMatch.conflictCode,
    };
    return this.deps.ifMatch.check(check);
  }

  private async authorizeIfNeeded(
    ctx: ControlPlaneRequestContext,
    operation: OpenApiOperationBinding,
  ): Promise<AuthorizationDecision | undefined> {
    const check =
      this.authorizationResolver === undefined
        ? defaultAuthorizationCheck(ctx, operation)
        : await this.authorizationResolver.resolve(ctx, operation);
    if (check === undefined) return undefined;
    return this.deps.rbac.authorize(ctx.principal, check);
  }
}

export class InMemoryControlPlaneIdempotencyStore {
  private readonly rows = new Map<string, IdempotencyRow>();
  private sequence = 0;

  async reserve(req: IdempotencyReservationRequest): Promise<IdempotencyReservation> {
    const mapKey = key(req.tenantId, `${req.endpoint}:${req.key}`);
    const existing = this.rows.get(mapKey);
    if (existing === undefined) {
      const row: IdempotencyRow = {
        recordId: `idem-${++this.sequence}`,
        requestHash: req.requestHash,
        status: "processing",
      };
      this.rows.set(mapKey, row);
      return { kind: "reserved", recordId: row.recordId };
    }

    if (existing.requestHash !== req.requestHash) {
      return { kind: "blocked", reason: "request_hash_mismatch" };
    }

    if (existing.status === "processing") {
      return { kind: "in_flight", recordId: existing.recordId, status: "processing" };
    }

    if (existing.response !== undefined) {
      return { kind: "replay", response: existing.response };
    }

    if (existing.error !== undefined) {
      return {
        kind: "replay",
        response: {
          status: 500,
          body: existing.error,
        },
      };
    }

    return { kind: "in_flight", recordId: existing.recordId, status: "processing" };
  }

  async saveResult(recordId: string, response: StoredIdempotentResponse): Promise<void> {
    const row = this.findByRecordId(recordId);
    row.status = "succeeded";
    row.response = response;
  }

  async saveFailure(recordId: string, error: ApiError): Promise<void> {
    const row = this.findByRecordId(recordId);
    row.status = "failed";
    row.error = error;
    row.response = {
      status: statusFromApiError(error),
      body: error,
    };
  }

  private findByRecordId(recordId: string): IdempotencyRow {
    for (const row of this.rows.values()) {
      if (row.recordId === recordId) return row;
    }
    throw new Error(`Unknown idempotency record ${recordId}`);
  }
}

export class InMemoryIfMatchCasStore {
  private readonly versions = new Map<string, number>();

  async check(check: IfMatchCheck): Promise<IfMatchDecision> {
    const mapKey = key(check.tenantId, `${check.entity}:${check.resourceId}`);
    const currentVersion = this.versions.get(mapKey) ?? check.expectedVersion;
    if (currentVersion !== check.expectedVersion) {
      return { kind: "conflict", code: check.conflictCode, currentVersion };
    }

    const nextVersion = currentVersion + 1;
    this.versions.set(mapKey, nextVersion);
    return { kind: "match", currentVersion, nextVersion };
  }
}

export class HeaderAuthenticationBoundary implements AuthenticationBoundary {
  async authenticate(headers: Readonly<Record<string, string | undefined>>): Promise<AuthBoundaryResult> {
    const authorization = headers.authorization;
    const tenantId = headers["x-tenant-id"];
    const rolesHeader = headers["x-roles"];
    if (authorization === undefined || !authorization.toLowerCase().startsWith("bearer ")) {
      // 인증 미성립(Bearer 토큰 누락/형식 무효) → 401. 인증 성립 후 클레임 부족은 403(아래)으로 분리.
      return { kind: "denied", code: "UNAUTHENTICATED", reason: "missing_bearer_authorization" };
    }
    if (tenantId === undefined || tenantId.length === 0) {
      return { kind: "denied", code: "AUTHZ_FORBIDDEN", reason: "missing_tenant_claim" };
    }
    if (rolesHeader === undefined || rolesHeader.length === 0) {
      return { kind: "denied", code: "AUTHZ_FORBIDDEN", reason: "missing_roles_claim" };
    }

    const roleClaims = rolesHeader.split(",").map((role) => role.trim());
    if (roleClaims.length === 0 || roleClaims.some((role) => !isRole(role))) {
      return { kind: "denied", code: "AUTHZ_FORBIDDEN", reason: "invalid_roles_claim" };
    }
    const roles = roleClaims as Role[];

    const principal: AuthenticatedPrincipal = {
      subjectId: (headers["x-subject-id"] ?? "fake-subject") as AuthenticatedPrincipal["subjectId"],
      tenantId: tenantId as TenantId,
      roles,
      source: "jwt",
      claims: {
        tenant_id: tenantId,
        roles,
      },
    };
    return { kind: "authenticated", principal };
  }
}

export class DefaultTenantSessionBinder implements TenantSessionBinder {
  bindTenant(principal: AuthenticatedPrincipal) {
    return {
      sql: "SET LOCAL app.tenant_id = $1" as const,
      values: [principal.tenantId] as const,
    };
  }
}

const ROLE_ACTIONS: Readonly<Record<Role, readonly RbacAction[]>> = {
  viewer: ["run.read", "workitem.read", "human_task.read", "artifact.read", "scenario.read"],
  operator: [
    "run.read",
    "run.create",
    "site.create",
    "workitem.read",
    "human_task.read",
    "artifact.read",
    "run.abort",
    "human_task.assign",
    "human_task.start",
    "dlq.replay",
    "sink_dlq.replay",
    "scenario.read",
    "scenario.create",
    "scenario.update",
  ],
  reviewer: [
    "run.read",
    "run.create",
    "site.create",
    "workitem.read",
    "human_task.read",
    "artifact.read",
    "run.abort",
    "human_task.assign",
    "human_task.escalate",
    "human_task.start",
    "dlq.replay",
    "sink_dlq.replay",
    "human_task.resolve.validation",
    "human_task.resolve.exception",
    "human_task.resolve.captcha",
    "human_task.resolve.mfa",
    "scenario.read",
    "scenario.create",
    "scenario.update",
  ],
  approver: [
    "run.read",
    "run.create",
    "site.create",
    "workitem.read",
    "human_task.read",
    "artifact.read",
    "run.abort",
    "human_task.assign",
    "human_task.escalate",
    "human_task.start",
    "dlq.replay",
    "sink_dlq.replay",
    "human_task.resolve.validation",
    "human_task.resolve.exception",
    "human_task.resolve.captcha",
    "human_task.resolve.mfa",
    "human_task.resolve.approval",
    "node_policy.approve",
    "site.approve",
    "scenario.read",
    "scenario.create",
    "scenario.update",
  ],
  admin: [
    "run.read",
    "run.create",
    "site.create",
    "workitem.read",
    "human_task.read",
    "artifact.read",
    "run.abort",
    "human_task.assign",
    "human_task.escalate",
    "human_task.start",
    "dlq.replay",
    "sink_dlq.replay",
    "human_task.resolve.validation",
    "human_task.resolve.exception",
    "human_task.resolve.captcha",
    "human_task.resolve.mfa",
    "human_task.resolve.approval",
    "node_policy.approve",
    "site.approve",
    "secret.resolve",
    "connector.enable",
    "gateway_policy.edit",
    "network_policy.edit",
    "rbac.grant",
    "scenario.read",
    "scenario.create",
    "scenario.update",
    "scenario.promote",
  ],
};

type AuthorizationDenyCode = Extract<AuthorizationDecision, { kind: "deny" }>["code"];

function roleActionDenyCode(action: RbacAction): AuthorizationDenyCode {
  if (action === "connector.enable") return "CONNECTOR_PERMISSION_DENIED";
  if (action === "artifact.read" || action === "secret.resolve") return "SECRET_ACCESS_DENIED";
  return "AUTHZ_FORBIDDEN";
}

export class RoleMatrixRbacMiddleware implements RbacMiddleware {
  async authorize(principal: AuthenticatedPrincipal, check: AuthorizationCheck): Promise<AuthorizationDecision> {
    if (principal.tenantId !== check.tenantId) {
      return { kind: "deny", action: check.action, code: "AUTHZ_FORBIDDEN", reason: "tenant_mismatch" };
    }

    for (const role of principal.roles) {
      if (ROLE_ACTIONS[role].includes(check.action)) {
        const humanTaskScopeDeny = denyForHumanTaskScope(principal, check);
        if (humanTaskScopeDeny !== undefined) return humanTaskScopeDeny;
        return { kind: "allow", principal, action: check.action };
      }
    }

    return { kind: "deny", action: check.action, code: roleActionDenyCode(check.action), reason: "role_action_not_allowed" };
  }
}

function denyForHumanTaskScope(
  principal: AuthenticatedPrincipal,
  check: AuthorizationCheck,
): AuthorizationDecision | undefined {
  if (!check.action.startsWith("human_task.resolve.")) return undefined;
  if (check.humanTask?.assigneeId !== undefined && check.humanTask.assigneeId !== principal.subjectId) {
    return { kind: "deny", action: check.action, code: "AUTHZ_FORBIDDEN", reason: "human_task_assignee_mismatch" };
  }
  if (
    check.humanTask?.assigneeRole !== undefined &&
    !principal.roles.includes(check.humanTask.assigneeRole)
  ) {
    return { kind: "deny", action: check.action, code: "AUTHZ_FORBIDDEN", reason: "human_task_assignee_role_mismatch" };
  }
  return undefined;
}

export class DefaultArtifactAccessGate implements ArtifactAccessGate {
  private readonly rbac: RbacMiddleware;

  constructor(rbac: RbacMiddleware) {
    this.rbac = rbac;
  }

  async check(principal: AuthenticatedPrincipal, artifact: ArtifactAccessSubject): Promise<ArtifactAccessDecision> {
    if (
      artifact.deletedAt !== undefined ||
      artifact.quarantine === true ||
      (artifact.redactionStatus !== "redacted" && artifact.redactionStatus !== "not_required")
    ) {
      return { kind: "deny", stage: "redaction", code: "ARTIFACT_NOT_REDACTED", reason: "artifact_not_ready" };
    }

    const decision = await this.rbac.authorize(principal, {
      action: "artifact.read",
      tenantId: artifact.tenantId,
      resource: { kind: "artifact", id: artifact.artifactId },
    });
    if (decision.kind === "deny") {
      return { kind: "deny", stage: "rbac", code: "SECRET_ACCESS_DENIED", reason: decision.reason };
    }

    return { kind: "allow", objectRef: artifact.objectRef };
  }
}

export function createInMemoryAuthorizationResolver(
  services: InMemoryControlPlaneServices,
): ControlPlaneAuthorizationResolver {
  return {
    async resolve(ctx: ControlPlaneRequestContext, operation: OpenApiOperationBinding): Promise<AuthorizationCheck | undefined> {
      if (operation.operationId === "resolveHumanTask") {
        const humanTaskId = ctx.params.human_task_id;
        const task = services.getHumanTaskForAuthorization(ctx.principal.tenantId, humanTaskId);
        if (task === undefined) {
          return {
            action: "human_task.read",
            tenantId: ctx.principal.tenantId,
            resource: { kind: "human_task", id: humanTaskId },
          };
        }
        return {
          action: resolveActionForHumanTaskKind(task.kind),
          tenantId: ctx.principal.tenantId,
          resource: { kind: "human_task", id: humanTaskId },
          humanTask: {
            kind: task.kind,
            assigneeId: task.assignee as PrincipalId | undefined,
            assigneeRole: task.assignee_role as Role | undefined,
          },
        };
      }

      if (operation.operationId === "escalateHumanTask") {
        const humanTaskId = ctx.params.human_task_id;
        const task = services.getHumanTaskForAuthorization(ctx.principal.tenantId, humanTaskId);
        return {
          action: "human_task.escalate",
          tenantId: ctx.principal.tenantId,
          resource: { kind: "human_task", id: humanTaskId },
          humanTask: task === undefined ? undefined : { kind: task.kind },
        };
      }

      return defaultAuthorizationCheck(ctx, operation);
    },
  };
}

export interface FakeControlPlaneScaffold {
  routes: readonly FastifyRouteScaffold[];
  fastifyRoutes: readonly FastifyLikeRouteOptions[];
  runner: FakeControlPlaneRunner;
  deps: ControlPlaneBoundaryDependencies;
  services: InMemoryControlPlaneServices;
}

export function createFakeControlPlaneScaffold(seed: MinimalControlPlaneSeed = {}): FakeControlPlaneScaffold {
  const validators = createControlPlaneValidatorRegistry();
  const rbac = new RoleMatrixRbacMiddleware();
  const artifactGate = new DefaultArtifactAccessGate(rbac);
  const services = new InMemoryControlPlaneServices(artifactGate, seed);
  const handlers: ControlPlaneHandlerMap = createMinimalControlPlaneHandlers(services);
  const binder = createRouteBinder(handlers, validators);
  const routes = CONTROL_PLANE_OPERATION_BINDINGS.map((binding) => binder.bind(binding.operationId));
  const deps: ControlPlaneBoundaryDependencies = {
    authn: new HeaderAuthenticationBoundary(),
    tenant: new DefaultTenantSessionBinder(),
    rbac,
    validators,
    idempotency: new InMemoryControlPlaneIdempotencyStore(),
    ifMatch: new InMemoryIfMatchCasStore(),
  };
  const runner = new FakeControlPlaneRunner({
    routes,
    deps,
    authorizationResolver: createInMemoryAuthorizationResolver(services),
  });

  return {
    routes,
    fastifyRoutes: createFastifyCompatibleRoutes(routes, runner),
    runner,
    deps,
    services,
  };
}

function defaultAuthorizationCheck(
  ctx: ControlPlaneRequestContext,
  operation: OpenApiOperationBinding,
): AuthorizationCheck | undefined {
  const action = staticRbacAction(operation.operationId);
  if (action === undefined) return undefined;
  return {
    action,
    tenantId: ctx.principal.tenantId,
    resource: resourceForOperation(operation, ctx),
  };
}

function resourceForOperation(
  operation: OpenApiOperationBinding,
  ctx: ControlPlaneRequestContext,
): AuthorizationCheck["resource"] | undefined {
  switch (operation.operationId) {
    case "getRun":
    case "abortRun":
      return { kind: "run", id: ctx.params.run_id };
    case "startHumanTask":
    case "assignHumanTask":
    case "escalateHumanTask":
      return { kind: "human_task", id: ctx.params.human_task_id };
    case "replayDeadLetter":
      return { kind: "workitem", id: ctx.params.dead_letter_id };
    case "promoteScenario":
      return { kind: "scenario", id: ctx.params.scenario_id };
    case "updateGatewayPolicy":
      return { kind: "gateway_policy", id: modelFromBody(ctx.body) };
    case "approveSite":
      return { kind: "site", id: ctx.params.site_profile_id };
    default:
      return undefined;
  }
}

function resolveActionForHumanTaskKind(kind: HumanTaskKind): RbacAction {
  switch (kind) {
    case "validation":
      return "human_task.resolve.validation";
    case "exception":
      return "human_task.resolve.exception";
    case "captcha":
      return "human_task.resolve.captcha";
    case "mfa":
      return "human_task.resolve.mfa";
    case "approval":
      return "human_task.resolve.approval";
  }
}

function validateBoundary<T>(
  validator: BoundaryValidator<T> | undefined,
  input: unknown,
  correlationId: string,
): T extends unknown ? T : unknown {
  if (validator === undefined) return input as T extends unknown ? T : unknown;

  const result = validator.validate(input);
  if (!result.valid) {
    throw new ApiResponseException(result.code, result.details, toApiError(result.code, correlationId, result.details).message);
  }
  return result.value as T extends unknown ? T : unknown;
}

function ifMatchResourceId(operation: OpenApiOperationBinding, ctx: ControlPlaneRequestContext): string {
  if (operation.ifMatch?.entity === "scenario_version") return ctx.params.scenario_id;
  if (operation.ifMatch?.entity === "gateway_policy") return modelFromBody(ctx.body);
  throw new Error(`Unsupported If-Match entity for ${operation.operationId}`);
}

function modelFromBody(body: unknown): string {
  if (isRecord(body) && typeof body.model === "string" && body.model.length > 0) {
    return body.model;
  }
  throw new ApiResponseException("IR_SCHEMA_INVALID", { reason: "missing_gateway_policy_model" });
}

function compileRoute(route: FastifyRouteScaffold): CompiledRoute {
  const paramNames: string[] = [];
  const source = route.url
    .split("/")
    .map((part) => {
      const match = /^\{([^}]+)\}$/.exec(part);
      if (match !== null) {
        paramNames.push(match[1]);
        return "([^/]+)";
      }
      return escapeRegExp(part);
    })
    .join("/");
  return { route, pattern: new RegExp(`^${source}$`), paramNames };
}

function normalizeHeaders(headers: Readonly<Record<string, string | undefined>>): Readonly<Record<string, string | undefined>> {
  const normalized: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(headers)) {
    normalized[name.toLowerCase()] = value;
  }
  return normalized;
}

function parseUrl(rawUrl: string): URL {
  return new URL(rawUrl, "http://control-plane.local");
}

function parseQuery(url: URL): Record<string, string | readonly string[] | undefined> {
  const query: Record<string, string | string[] | undefined> = {};
  for (const [name, value] of url.searchParams.entries()) {
    const existing = query[name];
    if (existing === undefined) {
      query[name] = value;
    } else if (Array.isArray(existing)) {
      existing.push(value);
    } else {
      query[name] = [existing, value];
    }
  }
  return query;
}

function canonicalRequestHash(method: HttpMethod, pathname: string, body: unknown): CanonicalRequestHash {
  const canonical = stableStringify({
    method,
    path: pathname,
    body: body ?? null,
  });
  return createHash("sha256").update(canonical).digest("hex") as CanonicalRequestHash;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((item) => `${JSON.stringify(item)}:${stableStringify(record[item])}`).join(",")}}`;
}

function key(tenantId: string, id: string): string {
  return `${tenantId}:${id}`;
}

function statusFromApiError(error: ApiError): number {
  return ERROR_CATALOG[error.code].httpStatus;
}

function isRole(value: string): value is Role {
  return value === "viewer" || value === "operator" || value === "reviewer" || value === "approver" || value === "admin";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
