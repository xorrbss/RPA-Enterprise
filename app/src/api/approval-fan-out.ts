/**
 * 결재 fan-out 코어 — 수집 run 이 남긴 결재 목록(approval_inbox artifact)의 각 행을 검토(@human_task) run 으로 스폰.
 *
 * API 엔드포인트(POST /v1/approvals/fan-out, 수동 버튼)와 워커 sweeper(자동 트리거)가 공유한다. /decide 와 달리
 * **결정을 내리지 않는다** — 검토 run 이 suspend 해 범용 '사람 확인' 인박스에서 사람 판정을 기다린다(자동 승인 금지,
 * 휴먼 게이트 보존). approval_row_claims UNIQUE(tenant, source_run, doc_ref) 로 행별 1스폰 보장(재-fanout·재-sweep 시
 * 중복 차단). 예약(claim)-후-스폰(경합 안전 — UNIQUE 가 최종 dedup).
 */
import { randomUUID } from "node:crypto";

import type { PoolClient } from "pg";

import type { ObjectRef } from "../../../ts/core-types";
import { originOf } from "../runtime/site-resolution";
import { isRecord } from "./command";
import { ApiResponseError } from "../runtime/errors";
import type { RunEnqueuer } from "../runtime/run-queue";
import { createRunInTx } from "./server-create-run";
import type { ArtifactObjectReader } from "./server-shared";

// 결재 검토·승인 시나리오(@human_task 게이트) — fan-out 이 행별로 스폰하는 검토 run. 시드된 명명 시나리오(최신 prod 해소).
export const REVIEW_SCENARIO_NAME = "하이웍스 결재 검토·승인";
// 수집 run 이 인박스에 남기는 결재 목록 artifact type(web APPROVAL_ARTIFACT_TYPE 와 동형).
export const APPROVAL_ARTIFACT_TYPE = "approval_inbox";

/** fan-out 코어가 필요로 하는 좁은 의존(ApiServerDeps 비의존 — 워커 sweeper 도 동일 shape 로 주입). */
export interface FanOutDeps {
  readonly artifactStore: ArtifactObjectReader;
  readonly enqueuer: RunEnqueuer;
  readonly configuredPromptVersions?: readonly string[];
}

export interface FanOutResult {
  readonly source_run_id: string;
  readonly spawned: { doc_ref: string; run_id: string }[];
  readonly spawned_count: number;
  readonly skipped: { doc_ref: string; reason: string }[];
  readonly skipped_count: number;
  readonly total: number;
}

// 검토 run 스폰에 필요한 행 파라미터(검토 시나리오 params_schema 정합). doc_ref/approval_id 없는 행은 스폰 불가 → 스킵.
interface FanOutRow {
  readonly docRef: string; // canonical http(s) URL(navigate + claim UNIQUE 동일 문자열)
  readonly params: Record<string, unknown>;
}

/** approval_inbox artifact content(JSON `{rows:[...]}` 또는 배열) → 검토 run 스폰 대상 행. web parseApprovalRows 와 동형
 *  규칙(doc_ref 필수, 미상 필드는 표시용 폴백). doc_ref 가 http(s) URL 이 아니거나 approval_id 부재면 스폰 불가라 스킵 수집. */
export function parseFanOutRows(content: string): { rows: FanOutRow[]; skipped: { doc_ref: string; reason: string }[] } {
  const data: unknown = JSON.parse(content); // 잘못된 JSON → throw(조용한 false 금지, 호출측이 표면화)
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

/**
 * 수집 run 하나를 fan-out — 결재 목록 artifact 를 읽어 유효 행마다 검토 run 을 예약-후-스폰한다(동일 tx).
 * 오류(source 부재·검토 시나리오 미시드·artifact 부재/object 무결성)는 ApiResponseError throw — API 는 HTTP 로 매핑,
 * 워커 sweeper 는 per-run catch 해 로그+다음 run(조용한 크래시 금지). `asOf` 는 호출측이 1회 고정 주입(Date.now 결정성).
 */
export async function fanOutCollectionRun(
  client: PoolClient,
  tenantId: string,
  sourceRunId: string,
  correlationId: string,
  asOf: string,
  deps: FanOutDeps,
): Promise<FanOutResult> {
  // 1) source run 존재 확인(RLS 스코프). 부재/타테넌트 → 404.
  const src = await client.query(`SELECT 1 FROM runs WHERE id = $1::uuid AND tenant_id = $2::uuid`, [sourceRunId, tenantId]);
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
    [sourceRunId, tenantId, APPROVAL_ARTIFACT_TYPE],
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
  const spawned: { doc_ref: string; run_id: string }[] = [];
  const skipped: { doc_ref: string; reason: string }[] = [...parsed.skipped];
  for (const row of parsed.rows) {
    // 예약(claim) 먼저 INSERT — UNIQUE(tenant, source_run, doc_ref) 로 행 예약. 이미 있으면 DO NOTHING(0행) → 스킵.
    const claimId = randomUUID();
    const claim = await client.query(
      `INSERT INTO approval_row_claims (id, tenant_id, source_run_id, doc_ref, mode, spawned_run_id)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'review', NULL)
       ON CONFLICT (tenant_id, source_run_id, doc_ref) DO NOTHING`,
      [claimId, tenantId, sourceRunId, row.docRef],
    );
    if ((claim.rowCount ?? 0) === 0) {
      // 이미 claim 된 행 — 처리모드로 사유 구분(③): decide=목록 건별 결재로 처리됨(fan-out 제외), review=이미 fan-out 됨(멱등).
      const existing = await client.query<{ mode: string }>(
        `SELECT mode FROM approval_row_claims WHERE tenant_id = $1::uuid AND source_run_id = $2::uuid AND doc_ref = $3`,
        [tenantId, sourceRunId, row.docRef],
      );
      skipped.push({ doc_ref: row.docRef, reason: existing.rows[0]?.mode === "decide" ? "already_decided" : "already_fanned_out" });
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
      ...(deps.configuredPromptVersions !== undefined ? { configuredPromptVersions: deps.configuredPromptVersions } : {}),
    });
    await client.query(
      `UPDATE approval_row_claims SET spawned_run_id = $1::uuid WHERE id = $2::uuid AND tenant_id = $3::uuid`,
      [spawnedRunId, claimId, tenantId],
    );
    spawned.push({ doc_ref: row.docRef, run_id: spawnedRunId });
  }

  return {
    source_run_id: sourceRunId,
    spawned,
    spawned_count: spawned.length,
    skipped,
    skipped_count: skipped.length,
    total: parsed.rows.length + parsed.skipped.length,
  };
}
