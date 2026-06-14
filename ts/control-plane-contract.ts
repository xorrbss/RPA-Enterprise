/**
 * Control Plane Scaffold Contract v1
 *
 * This is a contract-first typed scaffold for a future Fastify control-plane.
 * It does not make this repository runnable.
 *
 * Authoritative contracts:
 * - api-surface.md
 * - auth-rbac.md
 * - security-contracts.md
 * - codegen/openapi.yaml and codegen/validators.ts as generated artifacts
 */

import type { ApiError, ErrorCode } from "./error-catalog";
import type { HumanTaskKind, HumanTaskState, RunState, WorkitemState } from "./state-machine-types";
import type {
  AuthenticatedPrincipal,
  AuthenticationBoundary,
  AuthorizationDecision,
  IdempotencyKey,
  CanonicalRequestHash,
  RbacAction,
  RbacMiddleware,
  TenantBindingStatement,
  TenantId,
  TenantSessionBinder,
} from "./security-middleware-contract";

export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";

export type ControlPlanePath =
  | "/v1/runs"
  | "/v1/runs/{run_id}"
  | "/v1/runs/{run_id}/abort"
  | "/v1/scenarios"
  | "/v1/scenarios/{scenario_id}"
  | "/v1/scenarios/{scenario_id}/validate"
  | "/v1/scenarios/{scenario_id}/promote"
  | "/v1/human-tasks"
  | "/v1/human-tasks/{human_task_id}"
  | "/v1/human-tasks/{human_task_id}/start"
  | "/v1/human-tasks/{human_task_id}/resolve"
  | "/v1/human-tasks/{human_task_id}/assign"
  | "/v1/human-tasks/{human_task_id}/escalate"
  | "/v1/workitems"
  | "/v1/workitems/{workitem_id}"
  | "/v1/dlq"
  | "/v1/dlq/{dead_letter_id}/replay"
  | "/v1/artifacts/{artifact_id}"
  | "/v1/gateway/policy"
  | "/v1/sites"
  | "/v1/sites/{site_profile_id}"
  | "/v1/sites/{site_profile_id}/approve";

export type OperationId =
  | "createRun"
  | "getRun"
  | "listRuns"
  | "abortRun"
  | "createScenario"
  | "getScenario"
  | "listScenarios"
  | "updateScenario"
  | "validateScenario"
  | "promoteScenario"
  | "listHumanTasks"
  | "getHumanTask"
  | "startHumanTask"
  | "resolveHumanTask"
  | "assignHumanTask"
  | "escalateHumanTask"
  | "listWorkitems"
  | "getWorkitem"
  | "listDeadLetters"
  | "replayDeadLetter"
  | "getArtifact"
  | "getGatewayPolicy"
  | "updateGatewayPolicy"
  | "listSites"
  | "getSite"
  | "approveSite";

export interface BoundaryValidationOk<T = unknown> {
  valid: true;
  value: T;
}

export interface BoundaryValidationFailure {
  valid: false;
  code: Extract<ErrorCode, "IR_SCHEMA_INVALID">;
  details: unknown;
}

export type BoundaryValidationResult<T = unknown> = BoundaryValidationOk<T> | BoundaryValidationFailure;

export interface BoundaryValidator<T = unknown> {
  schemaRef: string;
  validate(input: unknown): BoundaryValidationResult<T>;
}

export interface OpenApiOperationBinding {
  operationId: OperationId;
  method: HttpMethod;
  path: ControlPlanePath;
  requestBodySchemaRef?: string;
  requestBodyRequired?: boolean;
  paramsSchemaRef?: string;
  querySchemaRef?: string;
  responseSchemaRef: string;
  rbacAction?: RbacAction;
  requiresAuth: true;
  requiresTenantBinding: true;
  requiresIdempotencyKey: boolean;
  ifMatch?: IfMatchContract;
}

export interface OpenApiValidatorRegistry {
  /**
   * Binds codegen/openapi.yaml operation metadata to generated AJV validators.
   * No route may bypass this registry and cast request bodies directly.
   */
  getOperation(operationId: OperationId): OpenApiOperationBinding;
  getBodyValidator(operationId: OperationId): BoundaryValidator | undefined;
  getParamsValidator(operationId: OperationId): BoundaryValidator | undefined;
  getQueryValidator(operationId: OperationId): BoundaryValidator | undefined;
}

export type ControlPlaneMiddlewareStep =
  | "correlation"
  | "authenticate"
  | "bindTenant"
  | "openApiValidate"
  | "idempotencyReplay"
  | "ifMatch"
  | "rbac"
  | "handler"
  | "errorMapper";

export const CONTROL_PLANE_MIDDLEWARE_ORDER: readonly ControlPlaneMiddlewareStep[] = [
  "correlation",
  "authenticate",
  "bindTenant",
  "openApiValidate",
  "idempotencyReplay",
  "ifMatch",
  "rbac",
  "handler",
  "errorMapper",
];

export interface FastifyRouteScaffold {
  method: HttpMethod;
  url: ControlPlanePath;
  operationId: OperationId;
  validators: {
    body?: BoundaryValidator;
    params?: BoundaryValidator;
    query?: BoundaryValidator;
  };
  preHandlers: readonly ControlPlaneMiddlewareStep[];
  handler: ControlPlaneHandler;
}

export interface RouteBinder {
  bind(operationId: OperationId): FastifyRouteScaffold;
}

export interface ControlPlaneHeaders {
  authorization?: string;
  "idempotency-key"?: IdempotencyKey;
  "if-match"?: string;
  "x-correlation-id"?: string;
}

export interface ControlPlaneRequestContext {
  method: HttpMethod;
  path: ControlPlanePath;
  operationId: OperationId;
  headers: ControlPlaneHeaders;
  params: Readonly<Record<string, string>>;
  query: Readonly<Record<string, string | readonly string[] | undefined>>;
  body: unknown;
  principal: AuthenticatedPrincipal;
  tenantBinding: TenantBindingStatement;
  authorization?: AuthorizationDecision;
  idempotency?: IdempotencyReservation;
  ifMatch?: IfMatchDecision;
  correlationId: string;
  requestHash: CanonicalRequestHash;
}

export interface ControlPlaneResponse {
  status: number;
  headers?: Readonly<Record<string, string>>;
  body: unknown;
}

export type ControlPlaneHandler = (ctx: ControlPlaneRequestContext) => Promise<ControlPlaneResponse>;

export interface ControlPlaneBoundaryDependencies {
  authn: AuthenticationBoundary;
  tenant: TenantSessionBinder;
  rbac: RbacMiddleware;
  validators: OpenApiValidatorRegistry;
  idempotency: ControlPlaneIdempotencyStore;
  ifMatch: IfMatchCasStore;
}

export type CommandEndpoint =
  | Extract<
      OperationId,
      | "createRun"
      | "abortRun"
      | "promoteScenario"
      | "startHumanTask"
      | "resolveHumanTask"
      | "assignHumanTask"
      | "escalateHumanTask"
      | "replayDeadLetter"
      | "updateGatewayPolicy"
      | "approveSite"
    >;

export interface IdempotencyReservationRequest {
  tenantId: TenantId;
  endpoint: OperationId;
  key: IdempotencyKey;
  requestHash: CanonicalRequestHash;
  expiresAt: string;
}

export type IdempotencyRecordStatus = "processing" | "succeeded" | "failed";

export interface StoredIdempotentResponse {
  status: number;
  body: unknown;
  headers?: Readonly<Record<string, string>>;
}

export type IdempotencyReservation =
  | { kind: "reserved"; recordId: string }
  | { kind: "replay"; response: StoredIdempotentResponse }
  | { kind: "in_flight"; recordId: string; status: Extract<IdempotencyRecordStatus, "processing"> }
  | {
      kind: "blocked";
      reason: "request_hash_mismatch";
      // Product Open v1 maps same Idempotency-Key with different
      // method/path/body hash to SCENARIO_VERSION_CONFLICT.
    };

export interface ControlPlaneIdempotencyStore {
  /**
   * Backed by control_plane_idempotency_keys UNIQUE(tenant_id, endpoint,
   * idempotency_key). replay must never re-run command side effects.
   */
  reserve(req: IdempotencyReservationRequest): Promise<IdempotencyReservation>;
  saveResult(recordId: string, response: StoredIdempotentResponse): Promise<void>;
  saveFailure(recordId: string, error: ApiError): Promise<void>;
}

export type IfMatchEntity = "scenario_version" | "gateway_policy";

export interface IfMatchContract {
  entity: IfMatchEntity;
  headerRequired: true;
  conflictCode: Extract<ErrorCode, "SCENARIO_VERSION_CONFLICT" | "POLICY_VERSION_CONFLICT">;
}

export interface IfMatchCheck {
  tenantId: TenantId;
  entity: IfMatchEntity;
  resourceId: string;
  expectedVersion: number;
  conflictCode: IfMatchContract["conflictCode"];
}

export type IfMatchDecision =
  | { kind: "match"; currentVersion: number; nextVersion: number }
  | { kind: "conflict"; code: IfMatchContract["conflictCode"]; currentVersion: number }
  | { kind: "missing"; code: IfMatchContract["conflictCode"] };

export interface IfMatchCasStore {
  /**
   * The eventual SQL must include tenant_id and version in the WHERE clause,
   * e.g. UPDATE ... WHERE tenant_id=$tenant AND id=$id AND version=$ifMatch.
   */
  check(check: IfMatchCheck): Promise<IfMatchDecision>;
}

export type ControlPlaneEntitySummary =
  | { kind: "run"; id: string; status: RunState }
  | { kind: "workitem"; id: string; status: WorkitemState }
  | { kind: "human_task"; id: string; status: HumanTaskState; taskKind: HumanTaskKind }
  | { kind: "scenario"; id: string; version: number }
  | { kind: "artifact"; id: string }
  | { kind: "site"; id: string; risk: "red" | "amber" | "green" }
  | { kind: "gateway_policy"; id: string; model: string; version: number };

export interface ControlPlaneBoundaryResult {
  operation: OpenApiOperationBinding;
  principal: AuthenticatedPrincipal;
  tenantBinding: TenantBindingStatement;
  authorization?: AuthorizationDecision;
  idempotency?: IdempotencyReservation;
  ifMatch?: IfMatchDecision;
}
