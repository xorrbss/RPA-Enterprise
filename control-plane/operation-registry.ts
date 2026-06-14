import type {
  BoundaryValidationFailure,
  BoundaryValidationResult,
  BoundaryValidator,
  ControlPlaneHandler,
  ControlPlanePath,
  FastifyRouteScaffold,
  HttpMethod,
  IfMatchContract,
  OpenApiOperationBinding,
  OpenApiValidatorRegistry,
  OperationId,
  RouteBinder,
} from "../ts/control-plane-contract";
import type { RbacAction } from "../ts/security-middleware-contract";

export type SupportedControlPlaneOperationId = Extract<
  OperationId,
  | "createRun"
  | "getRun"
  | "listRuns"
  | "abortRun"
  | "validateScenario"
  | "promoteScenario"
  | "listHumanTasks"
  | "startHumanTask"
  | "resolveHumanTask"
  | "assignHumanTask"
  | "escalateHumanTask"
  | "listWorkitems"
  | "replayDeadLetter"
  | "getArtifact"
  | "getGatewayPolicy"
  | "updateGatewayPolicy"
  | "listSites"
  | "approveSite"
>;

export type ControlPlaneHandlerMap = Readonly<Partial<Record<OperationId, ControlPlaneHandler>>>;

type OperationBindingInit = Omit<
  OpenApiOperationBinding,
  "requiresAuth" | "requiresTenantBinding" | "requiresIdempotencyKey"
> & {
  operationId: SupportedControlPlaneOperationId;
  requiresIdempotencyKey?: boolean;
};

const scenarioIfMatch: IfMatchContract = {
  entity: "scenario_version",
  headerRequired: true,
  conflictCode: "SCENARIO_VERSION_CONFLICT",
};

const gatewayPolicyIfMatch: IfMatchContract = {
  entity: "gateway_policy",
  headerRequired: true,
  conflictCode: "POLICY_VERSION_CONFLICT",
};

const operation = (init: OperationBindingInit): OpenApiOperationBinding => ({
  requiresAuth: true,
  requiresTenantBinding: true,
  requiresIdempotencyKey: init.requiresIdempotencyKey ?? false,
  ...init,
});

export const CONTROL_PLANE_OPERATION_BINDINGS: readonly OpenApiOperationBinding[] = [
  operation({
    operationId: "createRun",
    method: "POST",
    path: "/v1/runs",
    requestBodySchemaRef: "#/components/schemas/RunCreateRequest",
    requestBodyRequired: true,
    responseSchemaRef: "#/components/schemas/Run",
    requiresIdempotencyKey: true,
    rbacAction: "run.create",
  }),
  operation({
    operationId: "listRuns",
    method: "GET",
    path: "/v1/runs",
    querySchemaRef: "#/components/schemas/RunListQuery",
    responseSchemaRef: "#/components/schemas/RunPage",
    rbacAction: "run.read",
  }),
  operation({
    operationId: "getRun",
    method: "GET",
    path: "/v1/runs/{run_id}",
    paramsSchemaRef: "#/components/schemas/RunPathParams",
    responseSchemaRef: "#/components/schemas/Run",
    rbacAction: "run.read",
  }),
  operation({
    operationId: "abortRun",
    method: "POST",
    path: "/v1/runs/{run_id}/abort",
    paramsSchemaRef: "#/components/schemas/RunPathParams",
    requestBodySchemaRef: "#/components/schemas/AbortRequest",
    requestBodyRequired: false,
    responseSchemaRef: "#/components/schemas/Run",
    rbacAction: "run.abort",
    requiresIdempotencyKey: true,
  }),
  operation({
    operationId: "validateScenario",
    method: "POST",
    path: "/v1/scenarios/{scenario_id}/validate",
    paramsSchemaRef: "#/components/schemas/ScenarioPathParams",
    requestBodySchemaRef: "#/components/schemas/ValidateRequest",
    requestBodyRequired: true,
    responseSchemaRef: "#/components/schemas/ValidationReport",
  }),
  operation({
    operationId: "promoteScenario",
    method: "POST",
    path: "/v1/scenarios/{scenario_id}/promote",
    paramsSchemaRef: "#/components/schemas/ScenarioPathParams",
    requestBodySchemaRef: "#/components/schemas/PromoteRequest",
    requestBodyRequired: true,
    responseSchemaRef: "#/components/schemas/Scenario",
    rbacAction: "scenario.promote",
    requiresIdempotencyKey: true,
    ifMatch: scenarioIfMatch,
  }),
  operation({
    operationId: "listHumanTasks",
    method: "GET",
    path: "/v1/human-tasks",
    querySchemaRef: "#/components/schemas/HumanTaskListQuery",
    responseSchemaRef: "#/components/schemas/HumanTaskPage",
    rbacAction: "human_task.read",
  }),
  operation({
    operationId: "startHumanTask",
    method: "POST",
    path: "/v1/human-tasks/{human_task_id}/start",
    paramsSchemaRef: "#/components/schemas/HumanTaskPathParams",
    responseSchemaRef: "#/components/schemas/HumanTask",
    rbacAction: "human_task.start",
    requiresIdempotencyKey: true,
  }),
  operation({
    operationId: "resolveHumanTask",
    method: "POST",
    path: "/v1/human-tasks/{human_task_id}/resolve",
    paramsSchemaRef: "#/components/schemas/HumanTaskPathParams",
    requestBodySchemaRef: "#/components/schemas/HumanTaskResolveRequest",
    requestBodyRequired: true,
    responseSchemaRef: "#/components/schemas/HumanTask",
    requiresIdempotencyKey: true,
  }),
  operation({
    operationId: "assignHumanTask",
    method: "POST",
    path: "/v1/human-tasks/{human_task_id}/assign",
    paramsSchemaRef: "#/components/schemas/HumanTaskPathParams",
    requestBodySchemaRef: "#/components/schemas/HumanTaskAssignRequest",
    requestBodyRequired: true,
    responseSchemaRef: "#/components/schemas/HumanTask",
    rbacAction: "human_task.assign",
    requiresIdempotencyKey: true,
  }),
  operation({
    operationId: "escalateHumanTask",
    method: "POST",
    path: "/v1/human-tasks/{human_task_id}/escalate",
    paramsSchemaRef: "#/components/schemas/HumanTaskPathParams",
    requestBodySchemaRef: "#/components/schemas/HumanTaskEscalateRequest",
    requestBodyRequired: false,
    responseSchemaRef: "#/components/schemas/HumanTask",
    rbacAction: "human_task.escalate",
    requiresIdempotencyKey: true,
  }),
  operation({
    operationId: "listWorkitems",
    method: "GET",
    path: "/v1/workitems",
    querySchemaRef: "#/components/schemas/WorkitemListQuery",
    responseSchemaRef: "#/components/schemas/WorkitemPage",
    rbacAction: "workitem.read",
  }),
  operation({
    operationId: "replayDeadLetter",
    method: "POST",
    path: "/v1/dlq/{dead_letter_id}/replay",
    paramsSchemaRef: "#/components/schemas/DeadLetterPathParams",
    responseSchemaRef: "#/components/schemas/ReplayResult",
    rbacAction: "dlq.replay",
    requiresIdempotencyKey: true,
  }),
  operation({
    operationId: "getArtifact",
    method: "GET",
    path: "/v1/artifacts/{artifact_id}",
    paramsSchemaRef: "#/components/schemas/ArtifactPathParams",
    responseSchemaRef: "#/components/schemas/Artifact",
  }),
  operation({
    operationId: "getGatewayPolicy",
    method: "GET",
    path: "/v1/gateway/policy",
    querySchemaRef: "#/components/schemas/GatewayPolicyQuery",
    responseSchemaRef: "#/components/schemas/GatewayPolicy",
  }),
  operation({
    operationId: "updateGatewayPolicy",
    method: "PUT",
    path: "/v1/gateway/policy",
    requestBodySchemaRef: "#/components/schemas/GatewayPolicy",
    requestBodyRequired: true,
    responseSchemaRef: "#/components/schemas/GatewayPolicy",
    rbacAction: "gateway_policy.edit",
    requiresIdempotencyKey: true,
    ifMatch: gatewayPolicyIfMatch,
  }),
  operation({
    operationId: "listSites",
    method: "GET",
    path: "/v1/sites",
    querySchemaRef: "#/components/schemas/SiteListQuery",
    responseSchemaRef: "#/components/schemas/SitePage",
  }),
  operation({
    operationId: "approveSite",
    method: "POST",
    path: "/v1/sites/{site_profile_id}/approve",
    paramsSchemaRef: "#/components/schemas/SitePathParams",
    requestBodySchemaRef: "#/components/schemas/SiteApproveRequest",
    requestBodyRequired: false,
    responseSchemaRef: "#/components/schemas/Site",
    rbacAction: "site.approve",
    requiresIdempotencyKey: true,
  }),
];

const operationById = new Map(CONTROL_PLANE_OPERATION_BINDINGS.map((item) => [item.operationId, item]));

const validationFailure = (details: unknown): BoundaryValidationFailure => ({
  valid: false,
  code: "IR_SCHEMA_INVALID",
  details,
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const requireObject =
  (schemaRef: string, requiredStringProps: readonly string[] = [], allowUndefined = false): BoundaryValidator =>
  ({
    schemaRef,
    validate(input: unknown): BoundaryValidationResult {
      if (input === undefined && allowUndefined) {
        return { valid: true, value: undefined };
      }

      if (!isRecord(input)) {
        return validationFailure({ schemaRef, reason: "expected_object" });
      }

      for (const prop of requiredStringProps) {
        if (typeof input[prop] !== "string" || input[prop].length === 0) {
          return validationFailure({ schemaRef, reason: "missing_required_string", prop });
        }
      }

      return { valid: true, value: input };
    },
  });

const requireParams = (schemaRef: string, keys: readonly string[]): BoundaryValidator =>
  ({
    schemaRef,
    validate(input: unknown): BoundaryValidationResult {
      if (!isRecord(input)) {
        return validationFailure({ schemaRef, reason: "expected_params_object" });
      }

      for (const key of keys) {
        if (typeof input[key] !== "string" || input[key].length === 0) {
          return validationFailure({ schemaRef, reason: "missing_path_param", key });
        }
      }

      return { valid: true, value: input };
    },
  });

const passQuery = (schemaRef: string): BoundaryValidator => ({
  schemaRef,
  validate(input: unknown): BoundaryValidationResult {
    if (!isRecord(input)) {
      return validationFailure({ schemaRef, reason: "expected_query_object" });
    }

    return { valid: true, value: input };
  },
});

const bodyValidators: ReadonlyMap<OperationId, BoundaryValidator> = new Map<OperationId, BoundaryValidator>([
  ["createRun", requireObject("#/components/schemas/RunCreateRequest", ["scenario_version_id"])],
  ["abortRun", requireObject("#/components/schemas/AbortRequest", [], true)],
  ["validateScenario", requireObject("#/components/schemas/ValidateRequest")],
  ["promoteScenario", requireObject("#/components/schemas/PromoteRequest", ["target"])],
  ["resolveHumanTask", requireObject("#/components/schemas/HumanTaskResolveRequest")],
  ["assignHumanTask", requireObject("#/components/schemas/HumanTaskAssignRequest", ["assignee"])],
  ["escalateHumanTask", requireObject("#/components/schemas/HumanTaskEscalateRequest", [], true)],
  ["updateGatewayPolicy", requireObject("#/components/schemas/GatewayPolicy", ["model"])],
  ["approveSite", requireObject("#/components/schemas/SiteApproveRequest", [], true)],
]);

const paramsValidators: ReadonlyMap<OperationId, BoundaryValidator> = new Map<OperationId, BoundaryValidator>([
  ["getRun", requireParams("#/components/schemas/RunPathParams", ["run_id"])],
  ["abortRun", requireParams("#/components/schemas/RunPathParams", ["run_id"])],
  ["validateScenario", requireParams("#/components/schemas/ScenarioPathParams", ["scenario_id"])],
  ["promoteScenario", requireParams("#/components/schemas/ScenarioPathParams", ["scenario_id"])],
  ["startHumanTask", requireParams("#/components/schemas/HumanTaskPathParams", ["human_task_id"])],
  ["resolveHumanTask", requireParams("#/components/schemas/HumanTaskPathParams", ["human_task_id"])],
  ["assignHumanTask", requireParams("#/components/schemas/HumanTaskPathParams", ["human_task_id"])],
  ["escalateHumanTask", requireParams("#/components/schemas/HumanTaskPathParams", ["human_task_id"])],
  ["replayDeadLetter", requireParams("#/components/schemas/DeadLetterPathParams", ["dead_letter_id"])],
  ["getArtifact", requireParams("#/components/schemas/ArtifactPathParams", ["artifact_id"])],
  ["approveSite", requireParams("#/components/schemas/SitePathParams", ["site_profile_id"])],
]);

const queryValidators: ReadonlyMap<OperationId, BoundaryValidator> = new Map<OperationId, BoundaryValidator>([
  ["listRuns", passQuery("#/components/schemas/RunListQuery")],
  ["listHumanTasks", passQuery("#/components/schemas/HumanTaskListQuery")],
  ["listWorkitems", passQuery("#/components/schemas/WorkitemListQuery")],
  ["getGatewayPolicy", passQuery("#/components/schemas/GatewayPolicyQuery")],
  ["listSites", passQuery("#/components/schemas/SiteListQuery")],
]);

export function createControlPlaneValidatorRegistry(): OpenApiValidatorRegistry {
  return {
    getOperation(operationId: OperationId): OpenApiOperationBinding {
      const binding = operationById.get(operationId);
      if (binding === undefined) {
        throw new Error(`No control-plane operation binding for ${operationId}`);
      }
      return binding;
    },
    getBodyValidator(operationId: OperationId): BoundaryValidator | undefined {
      return bodyValidators.get(operationId);
    },
    getParamsValidator(operationId: OperationId): BoundaryValidator | undefined {
      return paramsValidators.get(operationId);
    },
    getQueryValidator(operationId: OperationId): BoundaryValidator | undefined {
      return queryValidators.get(operationId);
    },
  };
}

export function createRouteBinder(
  handlers: ControlPlaneHandlerMap,
  validators: OpenApiValidatorRegistry = createControlPlaneValidatorRegistry(),
): RouteBinder {
  return {
    bind(operationId: OperationId): FastifyRouteScaffold {
      const operationBinding = validators.getOperation(operationId);
      const handler = handlers[operationId];
      if (handler === undefined) {
        throw new Error(`No control-plane handler for ${operationId}`);
      }

      return {
        method: operationBinding.method,
        url: operationBinding.path,
        operationId,
        validators: {
          body: validators.getBodyValidator(operationId),
          params: validators.getParamsValidator(operationId),
          query: validators.getQueryValidator(operationId),
        },
        preHandlers: [
          "correlation",
          "authenticate",
          "bindTenant",
          "openApiValidate",
          "idempotencyReplay",
          "ifMatch",
          "rbac",
          "handler",
          "errorMapper",
        ],
        handler,
      };
    },
  };
}

export interface FastifyLikeRequest {
  method?: string;
  url?: string;
  headers: Readonly<Record<string, string | string[] | undefined>>;
  params?: unknown;
  query?: unknown;
  body?: unknown;
}

export interface FastifyLikeReply {
  code(status: number): FastifyLikeReply;
  headers(values: Readonly<Record<string, string>>): FastifyLikeReply;
  send(body: unknown): unknown;
}

export interface FastifyLikeRouteOptions {
  method: HttpMethod;
  url: string;
  handler(request: FastifyLikeRequest, reply: FastifyLikeReply): Promise<unknown>;
}

export interface ControlPlaneInjectRunner {
  inject(request: {
    method: HttpMethod;
    url: string;
    headers?: Readonly<Record<string, string | undefined>>;
    body?: unknown;
  }): Promise<{ status: number; headers?: Readonly<Record<string, string>>; body: unknown }>;
}

export function toFastifyUrl(path: ControlPlanePath): string {
  return path.replace(/\{([^}]+)\}/g, ":$1");
}

export function createFastifyCompatibleRoutes(
  routes: readonly FastifyRouteScaffold[],
  runner: ControlPlaneInjectRunner,
): readonly FastifyLikeRouteOptions[] {
  return routes.map((route) => ({
    method: route.method,
    url: toFastifyUrl(route.url),
    async handler(request: FastifyLikeRequest, reply: FastifyLikeReply): Promise<unknown> {
      const response = await runner.inject({
        method: route.method,
        url: request.url ?? route.url,
        headers: normalizeFastifyHeaders(request.headers),
        body: request.body,
      });
      if (response.headers !== undefined) {
        reply.headers(response.headers);
      }
      return reply.code(response.status).send(response.body);
    },
  }));
}

export function staticRbacAction(operationId: OperationId): RbacAction | undefined {
  return operationById.get(operationId)?.rbacAction;
}

function normalizeFastifyHeaders(
  headers: Readonly<Record<string, string | string[] | undefined>>,
): Readonly<Record<string, string | undefined>> {
  const normalized: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(headers)) {
    normalized[key.toLowerCase()] = Array.isArray(value) ? value[0] : value;
  }
  return normalized;
}
