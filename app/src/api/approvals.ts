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

import type { ObjectRef } from "../../../ts/core-types";
import { originOf } from "../runtime/site-resolution";
import { isRecord, runIdempotentCommand, type CommandResponse } from "./command";
import { ApiResponseError } from "./errors";
import { createRunInTx, type ApiServerDeps, requirePrincipal } from "./server";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 결재 처리 시나리오 이름(시드된 명명 시나리오 — seed-hiworks-approval.ts / web approval-inbox COLLECT 와 동형 name 식별).
// 시스템-레벨 워크플로라 클라이언트가 고르지 않고 엔드포인트가 최신 prod 버전을 해소한다(인박스의 수집 발견과 동일 패턴).
const DECIDE_SCENARIO_NAME = "하이웍스 결재 처리";
// 결재 검토·승인 시나리오(@human_task 게이트) — fan-out 이 행별로 스폰하는 검토 run. 각 run 이 suspend 해 범용
// '사람 확인' 인박스에 뜨고, 사람이 승인/반려한 뒤에만 실 커밋한다(자동 승인 아님 — 휴먼 게이트 보존).
const REVIEW_SCENARIO_NAME = "하이웍스 결재 검토·승인";
// 수집 run 이 인박스에 남기는 결재 목록 artifact type(web APPROVAL_ARTIFACT_TYPE 와 동형).
const APPROVAL_ARTIFACT_TYPE = "approval_inbox";

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
    configuredPromptVersions: deps.aiGovernanceConfiguredPromptVersions,
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

// ── fan-out (수집 목록 → 행별 검토 run 자동 생성) ────────────────────────────────────────────
// 수집 run 이 남긴 approval_inbox artifact 의 각 행마다 검토(@human_task) run 을 1건 스폰한다. approval_row_claims
// UNIQUE(tenant, source_run, doc_ref) 로 행별 1스폰 보장(재-fanout/스위퍼 재실행 시 중복 차단). /decide 와 달리
// **결정을 내리지 않는다** — 검토 run 이 인박스에서 사람 판정을 기다린다(자동 승인 금지, 휴먼 게이트 보존).

interface FanOutBody {
  readonly sourceRunId: string;
}

function parseFanOutBody(raw: unknown): FanOutBody {
  if (!isRecord(raw)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "request_body_object_required" });
  }
  for (const key of Object.keys(raw)) {
    if (key !== "source_run_id") {
      throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "unexpected_field", field: key });
    }
  }
  const sourceRunId = raw.source_run_id;
  if (typeof sourceRunId !== "string" || !UUID_RE.test(sourceRunId)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "invalid_source_run_id" });
  }
  return { sourceRunId };
}

// 검토 run 스폰에 필요한 행 파라미터(검토 시나리오 params_schema 정합). doc_ref/approval_id 없는 행은 스폰 불가 → 스킵.
interface FanOutRow {
  readonly docRef: string; // canonical http(s) URL(navigate + claim UNIQUE 동일 문자열)
  readonly params: Record<string, unknown>;
}

/** approval_inbox artifact content(JSON `{rows:[...]}` 또는 배열) → 검토 run 스폰 대상 행. web parseApprovalRows 와 동형
 *  규칙(doc_ref 필수, 미상 필드는 표시용 폴백). doc_ref 가 http(s) URL 이 아니거나 approval_id 부재면 스폰 불가라 스킵 수집. */
function parseFanOutRows(content: string): { rows: FanOutRow[]; skipped: { doc_ref: string; reason: string }[] } {
  const data: unknown = JSON.parse(content); // 잘못된 JSON → throw(조용한 false 금지, 라우트가 500 으로 표면화)
  const raw = Array.isArray(data)
    ? data
    : isRecord(data)
      ? (data as { rows?: unknown }).rows
      : undefined;
  if (!Array.isArray(raw)) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "approval_artifact_not_rows" });
  }
  const rows: FanOutRow[] = [];
  const skipped: { doc_ref: string; reason: string }[] = [];
  const str = (v: unknown, fallback: string): string => (typeof v === "string" && v !== "" ? v : fallback);
  for (const r of raw) {
    if (!isRecord(r)) {
      skipped.push({ doc_ref: "", reason: "row_not_object" });
      continue;
    }
    const docRefRaw = r.doc_ref;
    if (typeof docRefRaw !== "string" || originOf(docRefRaw) === null) {
      skipped.push({ doc_ref: typeof docRefRaw === "string" ? docRefRaw : "", reason: "invalid_doc_ref" });
      continue;
    }
    const approvalId = r.approval_id;
    if (typeof approvalId !== "string" || approvalId === "") {
      skipped.push({ doc_ref: docRefRaw, reason: "missing_approval_id" });
      continue;
    }
    // canonical(host 소문자·default 포트·dot-segment) — claim UNIQUE 가 host-case/포트 변형에 우회되지 않게(/decide 와 동일).
    const docRef = new URL(docRefRaw).href;
    const params: Record<string, unknown> = {
      doc_ref: docRef,
      approval_id: approvalId,
      drafter: str(r.drafter, "(기안자 미상)"),
      doc_type: str(r.doc_type, "(유형 미상)"),
      title: str(r.title, "(제목 없음)"),
    };
    if (typeof r.drafted_at === "string" && r.drafted_at !== "") params.drafted_at = r.drafted_at;
    rows.push({ docRef, params });
  }
  return { rows, skipped };
}

async function applyFanOut(
  client: PoolClient,
  tenantId: string,
  body: FanOutBody,
  correlationId: string,
  deps: ApiServerDeps,
): Promise<CommandResponse> {
  // 0) artifact reader 부재(미구성)면 fan-out 불가 — fail-closed(조용한 빈 결과 금지).
  if (deps.artifactStore === undefined) {
    throw new ApiResponseError("CONTROL_PLANE_INTERNAL_ERROR", { reason: "artifact_reader_not_configured" });
  }

  // 1) source run 존재 확인(RLS 스코프). 부재/타테넌트 → 404.
  const src = await client.query(
    `SELECT 1 FROM runs WHERE id = $1::uuid AND tenant_id = $2::uuid`,
    [body.sourceRunId, tenantId],
  );
  if ((src.rowCount ?? 0) === 0) {
    throw new ApiResponseError("RESOURCE_NOT_FOUND");
  }

  // 2) REVIEW 시나리오 버전 해소(name-based, 최신 prod, RLS). 미시드 → IR_SCHEMA_INVALID.
  const rev = await client.query<{ id: string }>(
    `SELECT sv.id::text AS id
       FROM scenario_versions sv JOIN scenarios s ON s.id = sv.scenario_id
      WHERE s.tenant_id = $1::uuid AND s.name = $2 AND sv.promotion_status = 'prod'
      ORDER BY sv.version DESC LIMIT 1`,
    [tenantId, REVIEW_SCENARIO_NAME],
  );
  if ((rev.rowCount ?? 0) === 0) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "review_scenario_not_found", name: REVIEW_SCENARIO_NAME });
  }
  const reviewScenarioVersionId = rev.rows[0].id;

  // 3) 수집 run 의 결재 목록 artifact 조회(최신). 부재 → IR_SCHEMA_INVALID(수집 미완/데이터 없음).
  const art = await client.query<{ object_ref: string }>(
    `SELECT object_ref FROM artifacts
      WHERE run_id = $1::uuid AND tenant_id = $2::uuid AND type = $3
      ORDER BY created_at DESC LIMIT 1`,
    [body.sourceRunId, tenantId, APPROVAL_ARTIFACT_TYPE],
  );
  if ((art.rowCount ?? 0) === 0) {
    throw new ApiResponseError("IR_SCHEMA_INVALID", { reason: "approval_artifact_not_found" });
  }
  const content = await deps.artifactStore.get(art.rows[0].object_ref as ObjectRef);
  if (content === null) {
    // 가시 metadata 인데 object 부재 = 무결성 이슈(조용한 빈 fan-out 금지).
    throw new ApiResponseError("CONTROL_PLANE_INTERNAL_ERROR", { reason: "approval_artifact_object_missing" });
  }

  // 4) 행 파싱 → 행별 예약-후-스폰(경합-안전). 이미 claim 된 행은 스킵(멱등).
  const parsed = parseFanOutRows(content);
  const asOf = new Date().toISOString();
  const spawned: { doc_ref: string; run_id: string }[] = [];
  const skipped: { doc_ref: string; reason: string }[] = [...parsed.skipped];
  for (const row of parsed.rows) {
    // 예약(claim) 먼저 INSERT — UNIQUE(tenant, source_run, doc_ref) 로 행 예약. 이미 있으면 DO NOTHING(0행) → 스킵.
    const claimId = randomUUID();
    const claim = await client.query(
      `INSERT INTO approval_row_claims (id, tenant_id, source_run_id, doc_ref, mode, spawned_run_id)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'review', NULL)
       ON CONFLICT (tenant_id, source_run_id, doc_ref) DO NOTHING`,
      [claimId, tenantId, body.sourceRunId, row.docRef],
    );
    if ((claim.rowCount ?? 0) === 0) {
      skipped.push({ doc_ref: row.docRef, reason: "already_fanned_out" });
      continue;
    }
    // 예약 성공 → 검토 run 스폰 후 spawned_run_id 채움(수집 run 의 correlationId 재사용 — 트레이스 연결).
    const spawnedRunId = await createRunInTx(client, deps.enqueuer, {
      tenantId,
      scenarioVersionId: reviewScenarioVersionId,
      params: row.params,
      asOf,
      correlationId,
      priority: "high", // 결재는 사람 대기 → 우선 처리.
      configuredPromptVersions: deps.aiGovernanceConfiguredPromptVersions,
    });
    await client.query(
      `UPDATE approval_row_claims SET spawned_run_id = $1::uuid WHERE id = $2::uuid AND tenant_id = $3::uuid`,
      [spawnedRunId, claimId, tenantId],
    );
    spawned.push({ doc_ref: row.docRef, run_id: spawnedRunId });
  }

  return {
    status: 201,
    body: {
      source_run_id: body.sourceRunId,
      spawned,
      spawned_count: spawned.length,
      skipped,
      skipped_count: skipped.length,
      total: parsed.rows.length + parsed.skipped.length,
    },
  };
}
