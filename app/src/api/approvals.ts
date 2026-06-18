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
import { isRecord, runIdempotentCommand, type CommandResponse } from "./command";
import { ApiResponseError } from "./errors";
import { createRunInTx, type ApiServerDeps, requirePrincipal } from "./server";

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

  // 3) 결정 INSERT(불변 이력 + 이중결재 방지). UNIQUE(tenant, source_run, doc_ref) 위반(23505) → APPROVAL_ALREADY_DECIDED.
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
  });

  // 5) spawned_run_id 갱신(결정 ↔ 처리 run 연결, 콘솔 폴링·딥링크용).
  await client.query(
    `UPDATE approval_decisions SET spawned_run_id = $1::uuid WHERE id = $2::uuid AND tenant_id = $3::uuid`,
    [spawnedRunId, decisionId, tenantId],
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
