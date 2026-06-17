/**
 * Dev redaction 승격 루프 (테스트용 — 프로덕션 RuntimeWorker artifact_redaction 잡의 dev 최소 대역).
 *
 * 실 sink(PgGatewayArtifactSink)가 만든 redaction_status='pending' 아티팩트는 RLS(artifacts_visible_isolation)가
 * 은닉해 결재 인박스가 읽지 못한다. 본 루프는 **전용 BYPASSRLS 역할**(serve 가 프로비저닝 — 프로덕션과 동일한
 * 보안 경계, superuser 아님)로 pending 을 폴링해 실 ContentRedactionTransform(§4 앵커, 마스킹 발명 아님)으로
 * 마스킹한 뒤 새 object 로 다시 쓰고 redaction_status='redacted' 로 승격한다 → RLS 가 노출 → 인박스가 읽는다.
 *
 * 정직성: 마스킹은 실 §4 변환을 거친다(stub/passthrough 아님). 한국어 이름 등 §4 범위 밖 값은 그대로 남지만
 * status='redacted'(="§4 redaction 수행됨, 열람 안전")는 정직하다 — not_required("증명적 깨끗")로 위장하지 않는다.
 * dev 단일 루프라 production 의 lifecycle claim/CAS 동시성 머신은 불필요(KISS); 변환 실패는 'failed' 로 loud 표면화.
 */
import { createHash } from "node:crypto";

import type { Pool } from "pg";

import type { ObjectRef } from "../../ts/core-types";
import { ContentRedactionTransform, UnredactableContentError } from "../src/artifacts/content-redaction-transform";
import type { ObjectStore } from "../src/gateway/pg-gateway-artifact-sink";

export interface RedactionLoop {
  stop(): Promise<void>;
}

interface PendingArtifact {
  id: string;
  type: string;
  sha256: string | null;
  object_ref: string;
}

/**
 * pending 아티팩트 승격 루프 시작. bypassPool 은 전용 BYPASSRLS 역할 연결(pending 가시). tenant 스코프(dev 단일 테넌트).
 * 동시 워커가 없으므로 lifecycle claim 없이 `WHERE redaction_status='pending'` 조건부 UPDATE 로 멱등 진행한다.
 */
export function startRedactionLoop(
  bypassPool: Pool,
  objectStore: ObjectStore,
  tenantId: string,
  intervalMs = 1500,
): RedactionLoop {
  const transform = new ContentRedactionTransform();
  let stopped = false;
  let busy = false;

  const markFailed = async (id: string, reason: string): Promise<void> => {
    // 미마스킹/무결성 이슈를 redacted 로 위장하지 않는다(fail-closed). pending 그대로 두는 무음도 금지 → failed loud.
    await bypassPool.query(
      `UPDATE artifacts SET redaction_status='failed', redaction_attempts=redaction_attempts+1
        WHERE id=$1::uuid AND redaction_status='pending'`,
      [id],
    );
    console.error(`redaction-loop: ${id.slice(0, 8)} → failed — ${reason}`);
  };

  const promoteOne = async (): Promise<void> => {
    const next = await bypassPool.query<PendingArtifact>(
      `SELECT id::text AS id, type, sha256, object_ref
         FROM artifacts
        WHERE tenant_id=$1::uuid AND redaction_status='pending' AND deleted_at IS NULL
        ORDER BY created_at LIMIT 1`,
      [tenantId],
    );
    const art = next.rows[0];
    if (art === undefined) return;

    const bytes = await objectStore.getBytes(art.object_ref as ObjectRef);
    if (bytes === null) {
      await markFailed(art.id, "object bytes 부재(무결성)");
      return;
    }

    let redactedBytes: Uint8Array;
    try {
      const result = await transform.transform(bytes, { type: art.type, sha256: art.sha256 ?? undefined });
      redactedBytes = result.bytes; // ContentRedactionTransform 은 유효 텍스트에 항상 redacted 반환(not_required 미반환).
    } catch (e) {
      await markFailed(art.id, e instanceof UnredactableContentError ? e.message : String(e));
      return;
    }

    const newRef = await objectStore.put(new TextDecoder().decode(redactedBytes));
    const sha = createHash("sha256").update(redactedBytes).digest("hex");
    const upd = await bypassPool.query(
      `UPDATE artifacts SET redaction_status='redacted', object_ref=$2, sha256=$3
        WHERE id=$1::uuid AND redaction_status='pending'`,
      [art.id, newRef, sha],
    );
    if (upd.rowCount === 1) console.log(`redaction-loop: ${art.id.slice(0, 8)} → redacted (§4 transform)`);
  };

  const tick = async (): Promise<void> => {
    if (stopped || busy) return;
    busy = true;
    try {
      await promoteOne();
    } catch (e) {
      console.error("redaction-loop tick error:", e instanceof Error ? e.message : String(e));
    } finally {
      busy = false;
    }
  };

  const timer = setInterval(() => void tick(), intervalMs);
  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
