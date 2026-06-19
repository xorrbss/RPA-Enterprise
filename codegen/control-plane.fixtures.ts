import assert from "node:assert/strict";

import { apiErrorResponse, ApiResponseException, exceptionResponse } from "../control-plane/errors";
import {
  createControlPlaneValidatorRegistry,
  createFastifyCompatibleRoutes,
  createRouteBinder,
  CONTROL_PLANE_OPERATION_BINDINGS,
  staticRbacAction,
} from "../control-plane/operation-registry";
import {
  createMinimalControlPlaneHandlers,
  InMemoryControlPlaneServices,
} from "../control-plane/minimal-handlers";
import {
  createFakeControlPlaneScaffold,
  createInMemoryAuthorizationResolver,
  FakeControlPlaneRunner,
} from "../control-plane/fake-request-runner";
import type {
  ControlPlaneRequestContext,
  IfMatchDecision,
  OperationId,
} from "../ts/control-plane-contract";
import type {
  ArtifactAccessGate,
  ArtifactAccessSubject,
  AuthenticatedPrincipal,
  CanonicalRequestHash,
  CorrelationId,
  PrincipalId,
  TenantBindingStatement,
  TenantId,
} from "../ts/security-middleware-contract";
import type { ArtifactRef } from "../ts/core-types";

const tenantId = "11111111-1111-4111-8111-111111111111" as TenantId;
const otherTenantId = "22222222-2222-4222-8222-222222222222" as TenantId;
const principal: AuthenticatedPrincipal = {
  subjectId: "principal-1" as PrincipalId,
  tenantId,
  roles: ["admin"],
  source: "jwt",
  claims: {},
};
const tenantBinding: TenantBindingStatement = {
  sql: "SET LOCAL app.tenant_id = $1",
  values: [tenantId],
};

class FixtureArtifactGate implements ArtifactAccessGate {
  async check(_principal: AuthenticatedPrincipal, artifact: ArtifactAccessSubject) {
    if (artifact.redactionStatus !== "redacted" && artifact.redactionStatus !== "not_required") {
      return {
        kind: "deny" as const,
        stage: "redaction" as const,
        code: "ARTIFACT_NOT_REDACTED" as const,
        reason: "artifact is not redacted",
      };
    }
    if (artifact.quarantine === true) {
      return {
        kind: "deny" as const,
        stage: "redaction" as const,
        code: "ARTIFACT_NOT_REDACTED" as const,
        reason: "artifact is quarantined",
      };
    }
    return { kind: "allow" as const, objectRef: artifact.objectRef };
  }
}

const services = new InMemoryControlPlaneServices(new FixtureArtifactGate(), {
  runs: [{
    run_id: "run-existing",
    tenant_id: tenantId,
    scenario_version_id: "sv-1",
    status: "running",
    attempts: 0,
    as_of: "2026-06-13T00:00:00Z",
  }, {
    run_id: "run-suspending",
    tenant_id: tenantId,
    scenario_version_id: "sv-1",
    status: "suspending",
    attempts: 0,
    as_of: "2026-06-13T00:00:00Z",
  }, {
    run_id: "run-other-tenant",
    tenant_id: otherTenantId,
    scenario_version_id: "sv-1",
    status: "running",
    attempts: 0,
    as_of: "2026-06-13T00:00:00Z",
  }],
  humanTasks: [{
    human_task_id: "task-open",
    tenant_id: tenantId,
    state: "in_progress",
    kind: "captcha",
    run_id: "run-existing",
  }, {
    human_task_id: "task-assign",
    tenant_id: tenantId,
    state: "open",
    kind: "captcha",
    run_id: "run-existing",
  }, {
    human_task_id: "task-expired",
    tenant_id: tenantId,
    state: "expired",
    kind: "captcha",
    run_id: "run-existing",
  }],
  workitems: [{
    workitem_id: "wi-1",
    tenant_id: tenantId,
    status: "processing",
    attempts: 1,
    target_id: "target-1",
  }],
  artifacts: [{
    artifact_id: "artifact-pending",
    tenant_id: tenantId,
    run_id: "run-existing",
    type: "screenshot",
    media_type: "image/png",
    filename: "pending.png",
    byte_size: 512,
    duration_ms: null,
    redaction_status: "pending",
    retention_until: null,
    legal_hold: false,
    created_at: "2026-06-13T00:00:00.000Z",
    ref: "artifact://pending",
    body: { secret: "[redacted]" },
  }, {
    artifact_id: "artifact-redacted",
    tenant_id: tenantId,
    run_id: "run-existing",
    step_id: "step-1",
    attempt: 1,
    type: "video",
    media_type: "video/webm",
    filename: "run-recording.webm",
    byte_size: 4096,
    duration_ms: 1200,
    redaction_status: "redacted",
    retention_until: null,
    legal_hold: false,
    created_at: "2026-06-13T00:00:01.000Z",
    ref: "artifact://redacted",
    body: { ok: true },
  }, {
    artifact_id: "artifact-quarantined",
    tenant_id: tenantId,
    run_id: "run-existing",
    type: "screenshot",
    media_type: "image/png",
    filename: "quarantined.png",
    byte_size: 2048,
    duration_ms: null,
    redaction_status: "redacted",
    retention_until: null,
    legal_hold: false,
    created_at: "2026-06-13T00:00:02.000Z",
    quarantine: true,
    ref: "artifact://quarantined",
    body: { quarantined: true },
  }],
  runSteps: [{
    step_id: "step-1",
    tenant_id: tenantId,
    run_id: "run-existing",
    node_id: "extract_results",
    action: "extract",
    status: "success",
    attempt: 1,
    cache_mode: "miss",
    started_at: "2026-06-13T00:00:00.000Z",
    ended_at: "2026-06-13T00:00:01.000Z",
    duration_ms: 1000,
    artifact_ids: ["artifact-redacted"],
    stagehand_calls: [{
      model: "gpt-4o-mini",
      transport: "sse",
      stream_status: "done",
      input_tokens: 128,
      output_tokens: 32,
      cost: "0.001",
    }],
    exception: null,
  }],
  gatewayPolicies: [{
    id: "gp-default",
    tenant_id: tenantId,
    model: "default",
    version: 1,
    capabilities: { jsonMode: true },
    budget: { maxCost: 1 },
  }],
  sites: [{
    site_profile_id: "site-red",
    tenant_id: tenantId,
    risk: "red",
    approved: false,
    circuit_state: "closed",
  }],
});

const handlers = createMinimalControlPlaneHandlers(services);
const registry = createControlPlaneValidatorRegistry();
const binder = createRouteBinder(handlers, registry);

const operationIds = CONTROL_PLANE_OPERATION_BINDINGS.map((binding) => binding.operationId);
for (const operationId of [
  "createRun",
  "getRun",
  "listRunSteps",
  "listRunArtifacts",
  "listRuns",
  "abortRun",
  "validateScenario",
  "promoteScenario",
  "archiveScenario",
  "listScenarioVersions",
  "getScenarioVersion",
  "rollbackScenario",
  "listHumanTasks",
  "startHumanTask",
  "resolveHumanTask",
  "assignHumanTask",
  "escalateHumanTask",
  "listWorkitems",
  "replayDeadLetter",
  "getArtifact",
  "listGatewayPolicies",
  "getGatewayPolicy",
  "createGatewayPolicy",
  "updateGatewayPolicy",
  "deleteGatewayPolicy",
  "listSites",
  "approveSite",
] satisfies OperationId[]) {
  assert.ok(operationIds.includes(operationId), `operation binding missing ${operationId}`);
}

assert.equal(registry.getOperation("createRun").requiresAuth, true);
assert.equal(registry.getOperation("createRun").requiresTenantBinding, true);
assert.equal(registry.getOperation("createRun").requiresIdempotencyKey, true);
assert.equal(registry.getOperation("promoteScenario").ifMatch?.entity, "scenario_version");
assert.equal(registry.getOperation("archiveScenario").ifMatch?.entity, "scenario_version");
assert.equal(registry.getOperation("rollbackScenario").ifMatch?.entity, "scenario_version");
assert.equal(registry.getOperation("archiveScenario").requiresIdempotencyKey, true);
assert.equal(registry.getOperation("rollbackScenario").requiresIdempotencyKey, true);
assert.equal(registry.getOperation("createGatewayPolicy").requiresIdempotencyKey, true);
assert.equal(registry.getOperation("updateGatewayPolicy").ifMatch?.entity, "gateway_policy");
assert.equal(registry.getOperation("deleteGatewayPolicy").ifMatch?.entity, "gateway_policy");
assert.equal(registry.getOperation("deleteGatewayPolicy").requiresIdempotencyKey, true);
assert.equal(staticRbacAction("createRun"), "run.create");
assert.equal(staticRbacAction("abortRun"), "run.abort");
assert.equal(staticRbacAction("listRunSteps"), "run.read");
assert.equal(staticRbacAction("listRunArtifacts"), "artifact.read");
assert.equal(staticRbacAction("validateScenario"), "scenario.read");
assert.equal(staticRbacAction("promoteScenario"), "scenario.promote");
assert.equal(staticRbacAction("archiveScenario"), "scenario.update");
assert.equal(staticRbacAction("listScenarioVersions"), "scenario.read");
assert.equal(staticRbacAction("getScenarioVersion"), "scenario.read");
assert.equal(staticRbacAction("rollbackScenario"), "scenario.update");
assert.equal(staticRbacAction("assignHumanTask"), "human_task.assign");
assert.equal(staticRbacAction("escalateHumanTask"), "human_task.escalate");
assert.equal(staticRbacAction("listGatewayPolicies"), "gateway_policy.read");
assert.equal(staticRbacAction("getGatewayPolicy"), "gateway_policy.read");
assert.equal(staticRbacAction("createGatewayPolicy"), "gateway_policy.edit");
assert.equal(staticRbacAction("updateGatewayPolicy"), "gateway_policy.edit");
assert.equal(staticRbacAction("deleteGatewayPolicy"), "gateway_policy.edit");
assert.throws(() => registry.getOperation("unknownOperation" as OperationId), /No control-plane operation binding/);

assert.equal(registry.getBodyValidator("createRun")?.validate({}).valid, false);
assert.equal(registry.getBodyValidator("createRun")?.validate({ scenario_version_id: "sv-1" }).valid, false);
assert.equal(registry.getBodyValidator("createRun")?.validate({ scenario_version_id: "sv-1", params: {} }).valid, true);
assert.equal(registry.getBodyValidator("createRun")?.validate({ scenario_version_id: "sv-1", params: {}, model: "gpt-4o-mini" }).valid, true);
assert.equal(registry.getBodyValidator("createRun")?.validate({ scenario_version_id: "sv-1", params: {}, tenant_id: "t1" }).valid, false);
assert.equal(registry.getBodyValidator("createRun")?.validate({ scenario_version_id: "sv-1", params: {}, model: "gpt-4o-mini", tenant_id: "t1" }).valid, false);
assert.equal(registry.getBodyValidator("assignHumanTask")?.validate({}).valid, false);
assert.equal(registry.getBodyValidator("assignHumanTask")?.validate({ assignee: "reviewer-1" }).valid, true);
assert.equal(registry.getBodyValidator("createGatewayPolicy")?.validate({ budget: { maxCost: 1 } }).valid, false);
assert.equal(registry.getBodyValidator("createGatewayPolicy")?.validate({ model: "codex", capabilities: {}, budget: {} }).valid, true);
assert.equal(registry.getBodyValidator("updateGatewayPolicy")?.validate({ budget: { maxCost: 1 } }).valid, false);
assert.equal(registry.getParamsValidator("getRun")?.validate({}).valid, false);
assert.equal(registry.getParamsValidator("getRun")?.validate({ run_id: "run-existing" }).valid, true);
assert.equal(registry.getParamsValidator("listRunSteps")?.validate({ run_id: "run-existing" }).valid, true);
assert.equal(registry.getParamsValidator("listRunArtifacts")?.validate({ run_id: "run-existing" }).valid, true);
assert.equal(registry.getParamsValidator("assignHumanTask")?.validate({ human_task_id: "task-open" }).valid, true);
assert.equal(registry.getQueryValidator("listRuns")?.validate(undefined).valid, false);
assert.equal(registry.getQueryValidator("deleteGatewayPolicy")?.validate({}).valid, false);
assert.equal(registry.getQueryValidator("deleteGatewayPolicy")?.validate({ model: "codex" }).valid, true);

const runRoute = binder.bind("createRun");
assert.equal(runRoute.method, "POST");
assert.equal(runRoute.url, "/v1/runs");
assert.deepEqual(runRoute.preHandlers, [
  "correlation",
  "authenticate",
  "bindTenant",
  "openApiValidate",
  "rbac",
  "idempotencyReplay",
  "ifMatch",
  "handler",
  "errorMapper",
]);
assert.throws(() => createRouteBinder({}, registry).bind("getRun"), /No control-plane handler/);

const fastifyRoutes = createFastifyCompatibleRoutes([binder.bind("getRun")], {
  async inject() {
    return { status: 200, body: { ok: true } };
  },
});
assert.equal(fastifyRoutes[0]?.url, "/v1/runs/:run_id");

const created = await handlers.createRun!(ctx("createRun", {
  method: "POST",
  path: "/v1/runs",
  body: { scenario_version_id: "sv-2", params: { as_of: "2026-06-13T10:00:00Z" } },
}));
assert.equal(created.status, 201);
assert.equal((created.body as { status: string }).status, "queued");
assert.equal((created.body as { as_of: string }).as_of, "2026-06-13T10:00:00Z");

const listed = await handlers.listRuns!(ctx("listRuns", {
  method: "GET",
  path: "/v1/runs",
  query: { status: "running" },
}));
assert.equal((listed.body as { items: unknown[] }).items.length, 1);

const aborted = await handlers.abortRun!(ctx("abortRun", {
  method: "POST",
  path: "/v1/runs/{run_id}/abort",
  params: { run_id: "run-existing" },
}));
assert.equal(aborted.status, 202);
assert.equal((aborted.body as { status: string }).status, "cancelled");
await assertApiError(
  () => handlers.abortRun!(ctx("abortRun", { method: "POST", path: "/v1/runs/{run_id}/abort", params: { run_id: "run-existing" } })),
  "RUN_ALREADY_TERMINAL",
);
await assertApiError(
  () => handlers.abortRun!(ctx("abortRun", { method: "POST", path: "/v1/runs/{run_id}/abort", params: { run_id: "run-suspending" } })),
  "WORKITEM_CHECKOUT_CONFLICT",
);

const resolved = await handlers.resolveHumanTask!(ctx("resolveHumanTask", {
  method: "POST",
  path: "/v1/human-tasks/{human_task_id}/resolve",
  params: { human_task_id: "task-open" },
  body: { result: "ok" },
}));
assert.equal((resolved.body as { state: string }).state, "resolved");
const assigned = await handlers.assignHumanTask!(ctx("assignHumanTask", {
  method: "POST",
  path: "/v1/human-tasks/{human_task_id}/assign",
  params: { human_task_id: "task-assign" },
  body: { assignee: "reviewer-1" },
}));
assert.equal((assigned.body as { state: string }).state, "assigned");
assert.equal((assigned.body as { assignee: string }).assignee, "reviewer-1");
await assertApiError(
  () => handlers.escalateHumanTask!(ctx("escalateHumanTask", {
    method: "POST",
    path: "/v1/human-tasks/{human_task_id}/escalate",
    params: { human_task_id: "task-assign" },
  })),
  "CONTROL_PLANE_INTERNAL_ERROR",
);
await assertApiError(
  () => handlers.startHumanTask!(ctx("startHumanTask", { method: "POST", path: "/v1/human-tasks/{human_task_id}/start", params: { human_task_id: "task-open" } })),
  "HUMAN_TASK_EXPIRED",
);

await assertApiError(
  () => handlers.getArtifact!(ctx("getArtifact", { method: "GET", path: "/v1/artifacts/{artifact_id}", params: { artifact_id: "artifact-pending" } })),
  "ARTIFACT_NOT_REDACTED",
);
await assertApiError(
  () => handlers.getArtifact!(ctx("getArtifact", { method: "GET", path: "/v1/artifacts/{artifact_id}", params: { artifact_id: "artifact-quarantined" } })),
  "ARTIFACT_NOT_REDACTED",
);
const artifact = await handlers.getArtifact!(ctx("getArtifact", {
  method: "GET",
  path: "/v1/artifacts/{artifact_id}",
  params: { artifact_id: "artifact-redacted" },
}));
assert.equal(artifact.status, 200);
assert.equal((artifact.body as { ref: string }).ref, "artifact://redacted");

const stepList = await handlers.listRunSteps!(ctx("listRunSteps", {
  method: "GET",
  path: "/v1/runs/{run_id}/steps",
  params: { run_id: "run-existing" },
}));
assert.equal(stepList.status, 200);
const stepItems = (stepList.body as { items: Array<Record<string, unknown>> }).items;
assert.equal(stepItems.length, 1);
assert.equal(stepItems[0]?.step_id, "step-1");
assert.deepEqual(stepItems[0]?.artifact_ids, ["artifact-redacted"]);
assert.equal(Object.prototype.hasOwnProperty.call(stepItems[0], "output"), false);
assert.equal(Object.prototype.hasOwnProperty.call(stepItems[0], "page_state_before"), false);

const artifactList = await handlers.listRunArtifacts!(ctx("listRunArtifacts", {
  method: "GET",
  path: "/v1/runs/{run_id}/artifacts",
  params: { run_id: "run-existing" },
}));
assert.equal(artifactList.status, 200);
const artifactItems = (artifactList.body as { items: Array<Record<string, unknown>> }).items;
assert.equal(artifactItems.length, 1);
assert.equal(artifactItems[0]?.artifact_id, "artifact-redacted");
assert.equal(artifactItems[0]?.step_id, "step-1");
assert.equal(artifactItems[0]?.attempt, 1);
assert.equal(artifactItems[0]?.media_type, "video/webm");
assert.equal(artifactItems[0]?.duration_ms, 1200);
assert.equal(Object.prototype.hasOwnProperty.call(artifactItems[0], "ref"), false);
assert.equal(Object.prototype.hasOwnProperty.call(artifactItems[0], "body"), false);

const promoted = await handlers.promoteScenario!(ctx("promoteScenario", {
  method: "POST",
  path: "/v1/scenarios/{scenario_id}/promote",
  params: { scenario_id: "scenario-1" },
  body: { target: "prod" },
  ifMatch: { kind: "match", currentVersion: 1, nextVersion: 2 },
}));
assert.equal(promoted.headers?.ETag, "2");

const scenarioVersions = await handlers.listScenarioVersions!(ctx("listScenarioVersions", {
  method: "GET",
  path: "/v1/scenarios/{scenario_id}/versions",
  params: { scenario_id: "scenario-1" },
}));
assert.equal((scenarioVersions.body as { items: unknown[] }).items.length, 1);

const scenarioVersion = await handlers.getScenarioVersion!(ctx("getScenarioVersion", {
  method: "GET",
  path: "/v1/scenarios/{scenario_id}/versions/{version}",
  params: { scenario_id: "scenario-1", version: "1" },
}));
assert.equal(scenarioVersion.headers?.ETag, "1");

const rolledBack = await handlers.rollbackScenario!(ctx("rollbackScenario", {
  method: "POST",
  path: "/v1/scenarios/{scenario_id}/versions/{version}/rollback",
  params: { scenario_id: "scenario-1", version: "1" },
  ifMatch: { kind: "match", currentVersion: 2, nextVersion: 3 },
}));
assert.equal(rolledBack.headers?.ETag, "3");

const archived = await handlers.archiveScenario!(ctx("archiveScenario", {
  method: "POST",
  path: "/v1/scenarios/{scenario_id}/archive",
  params: { scenario_id: "scenario-1" },
  ifMatch: { kind: "match", currentVersion: 3, nextVersion: 4 },
}));
assert.equal(archived.headers?.ETag, "3");

const listedPolicies = await handlers.listGatewayPolicies!(ctx("listGatewayPolicies", {
  method: "GET",
  path: "/v1/gateway/policies",
}));
assert.equal((listedPolicies.body as { items: unknown[] }).items.length, 1);

const createdPolicy = await handlers.createGatewayPolicy!(ctx("createGatewayPolicy", {
  method: "POST",
  path: "/v1/gateway/policy",
  body: { model: "codex-new", capabilities: { jsonMode: true }, budget: { maxCost: 2 }, is_default: true },
}));
assert.equal(createdPolicy.status, 201);
assert.equal(createdPolicy.headers?.ETag, "1");
assert.equal((createdPolicy.body as { is_default: boolean }).is_default, true);
await assertApiError(
  () => handlers.createGatewayPolicy!(ctx("createGatewayPolicy", {
    method: "POST",
    path: "/v1/gateway/policy",
    body: { model: "codex-new", capabilities: {}, budget: {} },
  })),
  "IR_SCHEMA_INVALID",
);

const policy = await handlers.updateGatewayPolicy!(ctx("updateGatewayPolicy", {
  method: "PUT",
  path: "/v1/gateway/policy",
  body: { model: "default", capabilities: { jsonMode: true }, budget: { maxCost: 1 } },
  ifMatch: { kind: "match", currentVersion: 1, nextVersion: 2 },
}));
assert.equal(policy.headers?.ETag, "2");

const deletedPolicy = await handlers.deleteGatewayPolicy!(ctx("deleteGatewayPolicy", {
  method: "DELETE",
  path: "/v1/gateway/policy",
  query: { model: "codex-new" },
  ifMatch: { kind: "match", currentVersion: 1, nextVersion: 2 },
}));
assert.equal((deletedPolicy.body as { deleted: boolean }).deleted, true);
await assertApiError(
  () => handlers.deleteGatewayPolicy!(ctx("deleteGatewayPolicy", {
    method: "DELETE",
    path: "/v1/gateway/policy",
    query: { model: "missing-policy" },
    ifMatch: { kind: "match", currentVersion: 1, nextVersion: 2 },
  })),
  "RESOURCE_NOT_FOUND",
);

const site = await handlers.approveSite!(ctx("approveSite", {
  method: "POST",
  path: "/v1/sites/{site_profile_id}/approve",
  params: { site_profile_id: "site-red" },
  body: { reason: "approved for smoke" },
}));
assert.equal((site.body as { approved: boolean }).approved, true);

assert.deepEqual(apiErrorResponse("AUTHZ_FORBIDDEN", "corr").status, 403);
assert.equal(exceptionResponse(new ApiResponseException("RUN_NOT_FOUND"), "corr").status, 404);

const scaffold = createFakeControlPlaneScaffold({
  humanTasks: [{
    human_task_id: "task-escalate-rbac",
    tenant_id: tenantId,
    state: "open",
    kind: "captcha",
    run_id: "run-existing",
  }, {
    human_task_id: "task-assignee-scope",
    tenant_id: tenantId,
    state: "in_progress",
    kind: "captcha",
    run_id: "run-existing",
    assignee: "other-principal",
    assignee_role: "reviewer",
  }, {
    human_task_id: "task-assignee-role-scope",
    tenant_id: tenantId,
    state: "in_progress",
    kind: "captcha",
    run_id: "run-existing",
    assignee: "principal-1",
    assignee_role: "approver",
  }, {
    human_task_id: "task-assignee-ok",
    tenant_id: tenantId,
    state: "in_progress",
    kind: "captcha",
    run_id: "run-existing",
    assignee: "principal-1",
    assignee_role: "reviewer",
  }],
});
const baseHeaders = {
  authorization: "Bearer fixture",
  "x-tenant-id": tenantId,
  "x-subject-id": "principal-1",
};
const unmatchedRoute = await scaffold.runner.inject({
  method: "GET",
  url: "/v1/no-such-route",
  headers: { ...baseHeaders, "x-roles": "admin" },
});
assert.equal(unmatchedRoute.status, 404);
assert.equal((unmatchedRoute.body as { code: string }).code, "RESOURCE_NOT_FOUND");

const missingIdempotency = await scaffold.runner.inject({
  method: "POST",
  url: "/v1/runs",
  headers: { ...baseHeaders, "x-roles": "admin" },
  body: { scenario_version_id: "sv-2", params: {} },
});
assert.equal(missingIdempotency.status, 422);
assert.equal((missingIdempotency.body as { code: string }).code, "IR_SCHEMA_INVALID");
const viewerCreate = await scaffold.runner.inject({
  method: "POST",
  url: "/v1/runs",
  headers: { ...baseHeaders, "x-roles": "viewer", "idempotency-key": "run-create-viewer" },
  body: { scenario_version_id: "sv-2", params: {} },
});
assert.equal(viewerCreate.status, 403);
assert.equal((viewerCreate.body as { code: string }).code, "AUTHZ_FORBIDDEN");
assert.equal("reason" in (viewerCreate.body as Record<string, unknown>), false);
assert.equal("action" in (viewerCreate.body as Record<string, unknown>), false);
const viewerValidateScenario = await scaffold.runner.inject({
  method: "POST",
  url: "/v1/scenarios/sv-1/validate",
  headers: { ...baseHeaders, "x-roles": "viewer" },
  body: { dry_run: true },
});
assert.equal(viewerValidateScenario.status, 200);
const viewerPromoteScenario = await scaffold.runner.inject({
  method: "POST",
  url: "/v1/scenarios/sv-1/promote",
  headers: { ...baseHeaders, "x-roles": "viewer", "idempotency-key": "viewer-promote", "if-match": "1" },
  body: { target: "prod" },
});
assert.equal(viewerPromoteScenario.status, 403);
assert.equal((viewerPromoteScenario.body as { code: string }).code, "AUTHZ_FORBIDDEN");
const gatewayPolicyFromRunner = await scaffold.runner.inject({
  method: "POST",
  url: "/v1/gateway/policy",
  headers: { ...baseHeaders, "x-roles": "admin", "idempotency-key": "gateway-create-1" },
  body: { model: "scaffold-gw", capabilities: { jsonMode: true }, budget: { maxCost: 1 } },
});
assert.equal(gatewayPolicyFromRunner.status, 201);
const deletedGatewayPolicyFromRunner = await scaffold.runner.inject({
  method: "DELETE",
  url: "/v1/gateway/policy?model=scaffold-gw",
  headers: { ...baseHeaders, "x-roles": "admin", "idempotency-key": "gateway-delete-1", "if-match": "1" },
});
assert.equal(deletedGatewayPolicyFromRunner.status, 200);
assert.equal((deletedGatewayPolicyFromRunner.body as { deleted: boolean }).deleted, true);
const invalidRoleClaim = await scaffold.runner.inject({
  method: "GET",
  url: "/v1/runs/run-existing",
  headers: { ...baseHeaders, "x-roles": "viewer,bogus" },
});
assert.equal(invalidRoleClaim.status, 403);
assert.equal((invalidRoleClaim.body as { code: string }).code, "AUTHZ_FORBIDDEN");
const adminAfterViewerDeny = await scaffold.runner.inject({
  method: "POST",
  url: "/v1/runs",
  headers: { ...baseHeaders, "x-roles": "admin", "idempotency-key": "run-create-viewer" },
  body: { scenario_version_id: "sv-2", params: {} },
});
assert.equal(adminAfterViewerDeny.status, 201);

const inFlight = await scaffold.runner.inject({
  method: "POST",
  url: "/v1/runs",
  headers: { ...baseHeaders, "x-roles": "admin", "idempotency-key": "run-create-1" },
  body: { scenario_version_id: "sv-2", params: {} },
});
assert.equal(inFlight.status, 201);
const secondCreate = await scaffold.runner.inject({
  method: "POST",
  url: "/v1/runs",
  headers: { ...baseHeaders, "x-roles": "admin", "idempotency-key": "run-create-2" },
  body: { scenario_version_id: "sv-3", params: {} },
});
assert.equal(secondCreate.status, 201);
const mismatch = await scaffold.runner.inject({
  method: "POST",
  url: "/v1/runs",
  headers: { ...baseHeaders, "x-roles": "admin", "idempotency-key": "run-create-2" },
  body: { scenario_version_id: "sv-4", params: {} },
});
assert.equal(mismatch.status, 412);
assert.equal((mismatch.body as { code: string }).code, "SCENARIO_VERSION_CONFLICT");

const inFlightScaffold = createFakeControlPlaneScaffold();
const inFlightDeps: typeof inFlightScaffold.deps = {
  ...inFlightScaffold.deps,
  idempotency: {
    async reserve() {
      return { kind: "in_flight", recordId: "idem-processing", status: "processing" as const };
    },
    async saveResult() {},
    async saveFailure() {},
  },
};
const inFlightRunner = new FakeControlPlaneRunner({
  routes: inFlightScaffold.routes,
  deps: inFlightDeps,
  authorizationResolver: createInMemoryAuthorizationResolver(inFlightScaffold.services),
});
const inFlightResponse = await inFlightRunner.inject({
  method: "POST",
  url: "/v1/runs",
  headers: { ...baseHeaders, "x-roles": "admin", "idempotency-key": "run-create-processing" },
  body: { scenario_version_id: "sv-2", params: {} },
});
assert.equal(inFlightResponse.status, 409);
assert.equal((inFlightResponse.body as { code: string }).code, "WORKITEM_CHECKOUT_CONFLICT");

const operatorEscalate = await scaffold.runner.inject({
  method: "POST",
  url: "/v1/human-tasks/task-escalate-rbac/escalate",
  headers: { ...baseHeaders, "x-roles": "operator", "idempotency-key": "escalate-operator" },
  body: {},
});
assert.equal(operatorEscalate.status, 403);
assert.equal((operatorEscalate.body as { code: string }).code, "AUTHZ_FORBIDDEN");
const reviewerEscalate = await scaffold.runner.inject({
  method: "POST",
  url: "/v1/human-tasks/task-escalate-rbac/escalate",
  headers: { ...baseHeaders, "x-roles": "reviewer", "idempotency-key": "escalate-reviewer" },
  body: {},
});
assert.equal(reviewerEscalate.status, 500);
assert.equal((reviewerEscalate.body as { code: string }).code, "CONTROL_PLANE_INTERNAL_ERROR");
const wrongAssigneeResolve = await scaffold.runner.inject({
  method: "POST",
  url: "/v1/human-tasks/task-assignee-scope/resolve",
  headers: { ...baseHeaders, "x-roles": "reviewer", "idempotency-key": "resolve-wrong-assignee" },
  body: { result: "ok" },
});
assert.equal(wrongAssigneeResolve.status, 403);
assert.equal((wrongAssigneeResolve.body as { code: string }).code, "AUTHZ_FORBIDDEN");
const wrongAssigneeRoleResolve = await scaffold.runner.inject({
  method: "POST",
  url: "/v1/human-tasks/task-assignee-role-scope/resolve",
  headers: { ...baseHeaders, "x-roles": "reviewer", "idempotency-key": "resolve-wrong-assignee-role" },
  body: { result: "ok" },
});
assert.equal(wrongAssigneeRoleResolve.status, 403);
assert.equal((wrongAssigneeRoleResolve.body as { code: string }).code, "AUTHZ_FORBIDDEN");
const matchingAssigneeResolve = await scaffold.runner.inject({
  method: "POST",
  url: "/v1/human-tasks/task-assignee-ok/resolve",
  headers: { ...baseHeaders, "x-roles": "reviewer", "idempotency-key": "resolve-matching-assignee" },
  body: { result: "ok" },
});
assert.equal(matchingAssigneeResolve.status, 200);
assert.equal((matchingAssigneeResolve.body as { state: string }).state, "resolved");

console.log("api smoke: control-plane route registry, validators, auth/tenant/RBAC, idempotency replay/mismatch/in-flight, If-Match, gateway policy CRUD, unmatched route, and redaction-gated artifact access covered");
console.log("control-plane fixtures: ALL PASS");

function ctx(operationId: OperationId, overrides: {
  method: ControlPlaneRequestContext["method"];
  path: ControlPlaneRequestContext["path"];
  params?: Record<string, string>;
  query?: Record<string, string>;
  body?: unknown;
  ifMatch?: IfMatchDecision;
}): ControlPlaneRequestContext {
  return {
    method: overrides.method,
    path: overrides.path,
    operationId,
    headers: {},
    params: overrides.params ?? {},
    query: overrides.query ?? {},
    body: overrides.body,
    principal,
    tenantBinding,
    authorization: undefined,
    idempotency: undefined,
    ifMatch: overrides.ifMatch,
    correlationId: "corr" as CorrelationId,
    requestHash: "sha256:fixture" as CanonicalRequestHash,
  };
}

async function assertApiError(
  fn: () => Promise<unknown>,
  code: ApiResponseException["code"],
): Promise<void> {
  try {
    await fn();
  } catch (error: unknown) {
    if (isApiResponseExceptionLike(error)) {
      assert.equal(error.code, code);
      return;
    }
    throw error;
  }
  throw new Error(`expected ${code}`);
}

function isApiResponseExceptionLike(error: unknown): error is { code: ApiResponseException["code"] } {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string"
  );
}
