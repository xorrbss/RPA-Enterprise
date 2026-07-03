/**
 * 결재(approval) 명령 라우트 (하이웍스 결재 인박스 Model A — api-surface 결재 엔드포인트).
 *
 * `POST /v1/approvals/decide` — 인박스의 건별 결재(승인/반려). approver+ 권한(auth-rbac §2, rbacAction=approval.decide;
 * 미보유→AUTHZ_FORBIDDEN). Idempotency-Key 멱등(runIdempotentCommand). 흐름(동일 tx):
 *   1) source_run_id(인박스를 노출한 수집 run) 존재 확인(RLS) — 부재/타테넌트 → RESOURCE_NOT_FOUND.
 *   2) 결정 INSERT(approval_decisions) — UNIQUE(tenant, source_run, doc_ref) 위반(23505) → APPROVAL_ALREADY_DECIDED(이중결재 방지).
 *   3) 내부에서 DECIDE 시나리오(name="하이웍스 결재 처리" 최신 prod)로 createRunInTx → 결재 처리 run 스폰.
 *   4) approval_decisions.spawned_run_id 갱신.
 * 멱등 보장: 동일 키 replay → 최초 응답(같은 spawned_run_id) 재생(재스폰 없음). 다른 키·동일(run,doc) → ALREADY_DECIDED(스폰 전 차단).
 *   ⇒ (run,doc) 당 정확히 1 run 스폰. approval_decisions 행 자체가 불변 결재 이력(audit).
 *
 * 비가역 경계: 실 승인/반려 클릭은 결재 처리 run 이 수행(휴먼게이트 검증 대상). 본 엔드포인트는 결정 기록 + run 스폰까지만.
 * reject 는 사유(reason) 필수 — 엔드포인트가 강제(미입력 반려 = 운영자 미입력 사유 제출 방지, break-it 후속).
 */
import { randomUUID } from "node:crypto";

import type { FastifyInstance, FastifyRequest } from "fastify";
import type { PoolClient } from "pg";

import { originOf } from "../runtime/site-resolution";
import { fanOutCollectionRun } from "./approval-fan-out";
import { isRecord, runIdempotentCommand, type CommandResponse } from "./command";
import { ApiResponseError } from "../runtime/errors";
import { type ApiServerDeps, requirePrincipal } from "./server-shared";
import { createRunInTx } from "./server-create-run";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 결재 처리 시나리오 이름(시드된 명명 시나리오 — seed-hiworks-approval.ts / web approval-inbox COLLECT 와 동형 name 식별).
// 시스템-레벨 워크플로라 클라이언트가 고르지 않고 엔드포인트가 최신 prod 버전을 해소한다(인박스의 수집 발견과 동일 패턴).
const DECIDE_SCENARIO_NAME = "하이웍스 결재 처리";

interface DecideBody {
  readonly sourceRunId: string;
  readonly docRef: string;
  readonly decision: "approve" | "reject";
  readonly reason?: string;
}

/** body 형상 선검사(키 소모 이전). source_run_id(uuid)·doc_ref(http(s) URL)·decision(approve|reject)·reason(reject 필수). */
function parseDecideBody(raw: unknown): DecideBody {
  if (!isRecord(raw)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "request_body_object_required" });
  }
  for (const key of Object.keys(raw)) {
    if (key !== "source_run_id" && key !== "doc_ref" && key !== "decision" && key !== "reason") {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "unexpected_field", field: key });
    }
  }
  const sourceRunId = raw.source_run_id;
  if (typeof sourceRunId !== "string" || !UUID_RE.test(sourceRunId)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_source_run_id" });
  }
  const docRefRaw = raw.doc_ref;
  if (typeof docRefRaw !== "string" || originOf(docRefRaw) === null) {
    // doc_ref 는 navigate(url_ref) 가 절대 URL 로 해소해야 하므로 http(s) URL 이어야 한다(비-URL은 매칭 불가 → 선차단).
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_doc_ref" });
  }
  // 정규화(host 소문자·default 포트·dot-segment) — UNIQUE(이중결재 방지) 가드가 host-case/포트 변형에 우회되지 않게.
  //   저장·navigate·UNIQUE 비교에 동일 canonical 문자열을 쓴다. (경로 대소문자/trailing-slash 는 origin SSoT 범위 밖.)
  const docRef = new URL(docRefRaw).href;
  const decision = raw.decision;
  if (decision !== "approve" && decision !== "reject") {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_decision" });
  }
  let reason: string | undefined;
  if (raw.reason !== undefined) {
    if (typeof raw.reason !== "string") {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_reason" });
    }
    reason = raw.reason;
  }
  if (decision === "reject" && (reason === undefined || reason.trim().length === 0)) {
    // 반려는 사유 필수(미입력 반려 차단 — 결재 처리 run 이 미입력/환각 사유로 제출하지 않게 엔드포인트가 강제).
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "reason_required_for_reject" });
  }
  if (decision === "approve" && reason !== undefined) {
    // approve 는 사유 없음(닫힌 shape — reject⇒reason 강제와 대칭; migration: approve면 reason NULL 불변식 정합).
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "reason_not_allowed_for_approve" });
  }
  return { sourceRunId, docRef, decision, reason };
}

export function registerApprovalRoutes(app: FastifyInstance, deps: ApiServerDeps): void {
  app.post(
    "/v1/approvals/decide",
    { config: { rbacAction: "approval.decide" } },
    async (request: FastifyRequest, reply) => {
      const principal = requirePrincipal(request);
      const body = parseDecideBody(request.body); // 키 소모 이전 선검사(malformed→422)
      const result = await runIdempotentCommand(
        deps,
        request,
        "decideApproval",
        "/v1/approvals/decide",
        (client, tenantId) => applyDecide(client, tenantId, body, principal.subjectId, request.correlationId, deps),
      );
      reply.code(result.status).send(result.body);
    },
  );

  // POST /v1/approvals/fan-out — 수집 목록의 각 행을 검토 run(@human_task)으로 일괄 스폰(수동/버튼 트리거).
  //   approver+ (approval.decide 로 게이트 — 결재 인박스 관리 능력). Idempotency-Key 멱등 + 행별 claim 으로 이중 스폰 차단.
  app.post(
    "/v1/approvals/fan-out",
    { config: { rbacAction: "approval.decide" } },
    async (request: FastifyRequest, reply) => {
      requirePrincipal(request);
      const body = parseFanOutBody(request.body);
      const result = await runIdempotentCommand(
        deps,
        request,
        "fanOutApprovals",
        "/v1/approvals/fan-out",
        (client, tenantId) => applyFanOut(client, tenantId, body, request.correlationId, deps),
      );
      reply.code(result.status).send(result.body);
    },
  );
}

async function applyDecide(
  client: PoolClient,
  tenantId: string,
  body: DecideBody,
  decidedBy: string,
  correlationId: string,
  deps: ApiServerDeps,
): Promise<CommandResponse> {
  // 1) source run 존재 확인(RLS 스코프). 부재/타테넌트 → 404(존재 비노출).
  const src = await client.query(
    `SELECT 1 FROM runs WHERE id = $1::uuid AND tenant_id = $2::uuid`,
    [body.sourceRunId, tenantId],
  );
  if ((src.rowCount ?? 0) === 0) {
    throw new ApiResponseError("RESOURCE_NOT_FOUND");
  }

  // 2) DECIDE 시나리오 버전 해소(name-based, 최신 prod, RLS 스코프). 미시드 → IR_SCHEMA_INVALID(설정 누락).
  const dec = await client.query<{ id: string }>(
    `SELECT sv.id::text AS id
       FROM scenario_versions sv JOIN scenarios s ON s.id = sv.scenario_id
      WHERE s.tenant_id = $1::uuid AND s.name = $2 AND sv.promotion_status = 'prod'
      ORDER BY sv.version DESC LIMIT 1`,
    [tenantId, DECIDE_SCENARIO_NAME],
  );
  if ((dec.rowCount ?? 0) === 0) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "decide_scenario_not_found", name: DECIDE_SCENARIO_NAME });
  }
  const decideScenarioVersionId = dec.rows[0].id;

  // 2.5) 처리모드 상호배제(③): approval_row_claims 에 'decide' 예약. 이미 fan-out 검토('review')나 결재('decide')로 claim 된
  //   행이면 conflict → 한 행은 한 경로로만 처리(이중 승인 방지). 경합-안전(UNIQUE 가 먼저 claim 한 경로를 채택; 스폰 이전 게이트).
  const claimId = randomUUID();
  const claim = await client.query(
    `INSERT INTO approval_row_claims (id, tenant_id, source_run_id, doc_ref, mode, spawned_run_id)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'decide', NULL)
     ON CONFLICT (tenant_id, source_run_id, doc_ref) DO NOTHING`,
    [claimId, tenantId, body.sourceRunId, body.docRef],
  );
  if ((claim.rowCount ?? 0) === 0) {
    const existing = await client.query<{ mode: string }>(
      `SELECT mode FROM approval_row_claims WHERE tenant_id = $1::uuid AND source_run_id = $2::uuid AND doc_ref = $3`,
      [tenantId, body.sourceRunId, body.docRef],
    );
    // 검토 인박스로 이미 보낸('review') 행은 그쪽에서 처리 — 목록 건별 결재 차단(claimed_as 로 구분 표면화).
    throw new ApiResponseError("APPROVAL_ALREADY_DECIDED", { doc_ref: body.docRef, claimed_as: existing.rows[0]?.mode ?? "unknown" });
  }

  // 3) 결정 INSERT(불변 이력 + 이중결재 방지). UNIQUE(tenant, source_run, doc_ref) 위반(23505) → APPROVAL_ALREADY_DECIDED.
  //    (2.5 claim 이 1차 게이트지만, ③ 이전 데이터·경합 잔여를 위해 decisions UNIQUE 도 belt 로 유지.)
  const decisionId = randomUUID();
  try {
    await client.query(
      `INSERT INTO approval_decisions (id, tenant_id, source_run_id, doc_ref, decision, reason, decided_by)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7)`,
      // decided_by 는 text(PrincipalId 자유형 — OIDC sub auth0|… 등 비-UUID 허용). ::uuid 캐스트 금지(22P02→미분류 500 회피).
      [decisionId, tenantId, body.sourceRunId, body.docRef, body.decision, body.reason ?? null, decidedBy],
    );
  } catch (err) {
    if (isRecord(err) && (err as { code?: unknown }).code === "23505") {
      throw new ApiResponseError("APPROVAL_ALREADY_DECIDED", { doc_ref: body.docRef });
    }
    throw err;
  }

  // 4) 내부 결재 처리 run 스폰(동일 tx). params = {doc_ref, decision, reason?}(시나리오 params_schema 정합).
  const params: Record<string, unknown> = { doc_ref: body.docRef, decision: body.decision };
  if (body.reason !== undefined) params.reason = body.reason;
  const spawnedRunId = await createRunInTx(client, deps.enqueuer, {
    tenantId,
    scenarioVersionId: decideScenarioVersionId,
    params,
    asOf: new Date().toISOString(),
    correlationId,
    configuredPromptVersions: deps.aiGovernanceConfiguredPromptVersions,
  });

  // 5) spawned_run_id 갱신(결정 ↔ 처리 run 연결, 콘솔 폴링·딥링크용) + 공유원장 claim 도 스폰 run 연결.
  await client.query(
    `UPDATE approval_decisions SET spawned_run_id = $1::uuid WHERE id = $2::uuid AND tenant_id = $3::uuid`,
    [spawnedRunId, decisionId, tenantId],
  );
  await client.query(
    `UPDATE approval_row_claims SET spawned_run_id = $1::uuid WHERE id = $2::uuid AND tenant_id = $3::uuid`,
    [spawnedRunId, claimId, tenantId],
  );

  return {
    status: 201,
    body: {
      decision_id: decisionId,
      source_run_id: body.sourceRunId,
      doc_ref: body.docRef,
      decision: body.decision,
      spawned_run_id: spawnedRunId,
    },
  };
}

// ── fan-out (수집 목록 → 행별 검토 run 자동 생성) ────────────────────────────────────────────
// 수집 run 이 남긴 approval_inbox artifact 의 각 행마다 검토(@human_task) run 을 1건 스폰한다. approval_row_claims
// UNIQUE(tenant, source_run, doc_ref) 로 행별 1스폰 보장(재-fanout/스위퍼 재실행 시 중복 차단). /decide 와 달리
// **결정을 내리지 않는다** — 검토 run 이 인박스에서 사람 판정을 기다린다(자동 승인 금지, 휴먼 게이트 보존).

interface FanOutBody {
  readonly sourceRunId: string;
  readonly enableAuto: boolean; // true → 이 수집 시나리오를 auto_fan_out 켜서 이후 완료 run 은 sweeper 가 자동 fan-out(②).
}

function parseFanOutBody(raw: unknown): FanOutBody {
  if (!isRecord(raw)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "request_body_object_required" });
  }
  for (const key of Object.keys(raw)) {
    if (key !== "source_run_id" && key !== "enable_auto") {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "unexpected_field", field: key });
    }
  }
  const sourceRunId = raw.source_run_id;
  if (typeof sourceRunId !== "string" || !UUID_RE.test(sourceRunId)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_source_run_id" });
  }
  if (raw.enable_auto !== undefined && typeof raw.enable_auto !== "boolean") {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_enable_auto" });
  }
  return { sourceRunId, enableAuto: raw.enable_auto === true };
}

async function applyFanOut(
  client: PoolClient,
  tenantId: string,
  body: FanOutBody,
  correlationId: string,
  deps: ApiServerDeps,
): Promise<CommandResponse> {
  // artifact reader 부재(미구성)면 fan-out 불가 — fail-closed(조용한 빈 결과 금지).
  if (deps.artifactStore === undefined) {
    throw new ApiResponseError("CONTROL_PLANE_INTERNAL_ERROR", { reason: "artifact_reader_not_configured" });
  }
  // enable_auto → 이 수집 run 의 시나리오를 auto_fan_out 켜기(②: 이후 완료 run 은 sweeper 가 자동 fan-out). 동일 tx.
  //   source run 미존재/타테넌트면 UPDATE 0행 — 이어지는 fanOutCollectionRun 이 RESOURCE_NOT_FOUND 로 loud(비노출 유지).
  if (body.enableAuto) {
    await client.query(
      `UPDATE scenarios SET auto_fan_out = true
        WHERE tenant_id = $1::uuid
          AND id = (SELECT sv.scenario_id FROM runs r JOIN scenario_versions sv ON sv.id = r.scenario_version_id
                     WHERE r.id = $2::uuid AND r.tenant_id = $1::uuid)`,
      [tenantId, body.sourceRunId],
    );
  }
  // 공유 코어(수동 버튼·자동 sweeper 공용) 위임. asOf 1회 고정(결정성).
  const result = await fanOutCollectionRun(client, tenantId, body.sourceRunId, correlationId, new Date().toISOString(), {
    artifactStore: deps.artifactStore,
    enqueuer: deps.enqueuer,
    ...(deps.aiGovernanceConfiguredPromptVersions !== undefined ? { configuredPromptVersions: deps.aiGovernanceConfiguredPromptVersions } : {}),
  });
  return { status: 201, body: { ...result, auto_enabled: body.enableAuto } };
}
