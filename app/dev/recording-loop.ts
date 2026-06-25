/**
 * Dev 브라우저 녹화 폴러 (테스트용, 프로덕션 아님).
 *
 * 프로덕션 설계: '브라우저 녹화로 만들기'의 녹화는 운영자 PC 도우미 CLI(`npm run record:browser`)가
 * 운영자 자신의 Chrome 을 열어 동작을 캡처한다(웹 페이지는 보안상 로컬 Chrome 프로세스를 직접 못 띄움).
 * dev 에서는 세션 등록(capture-loop)과 대칭이 되도록, 콘솔의 '녹화 시작'(browser_recording_sessions
 * status='recording')을 서버가 직접 폴링해 headful Chrome 을 띄우고 DOM 동작을 캡처한다.
 *
 * tick: browser_recording_sessions WHERE status='recording' 중 아직 안 띄운 1건 → headful Chrome(별도)으로
 *   start_url 을 열고, 에이전트 코어(defaultLaunchBrowser/sanitizePageEvent)를 그대로 재사용해 click/input/
 *   select/submit/navigate 를 browser_recording_events 로 적재(seq는 세션별 in-memory 카운터). 운영자가 창을
 *   닫으면 캡처 종료(세션 상태는 'recording' 유지 → 콘솔에서 검토 후 '녹화 완료'로 봇 초안 생성).
 *
 * 보안: 자격증명 입력 등 민감 타깃은 에이전트 코어의 sanitizePageEvent 가 drop(기존 prod 경로와 동일).
 *   tenant/site 는 recording 세션 행(RLS 조회)에서 도출(payload 미신뢰). dev 전용 — 계약/런타임 무변경.
 */
import { randomUUID } from "node:crypto";

import type { Pool } from "pg";

import { withTenantTx } from "../src/db/pool";
import { findChrome } from "../src/executor/login-capture";
import {
  defaultLaunchBrowser,
  sanitizePageEvent,
  type BrowserRecordingLaunchHandle,
  type SanitizedRecordingEvent,
} from "../src/agent/browser-recording-agent";

export interface RecordingLoop {
  stop(): Promise<void>;
}

interface RecordingRow {
  id: string;
  start_url: string;
}

export async function startRecordingLoop(pool: Pool, tenantId: string, intervalMs = 2000): Promise<RecordingLoop | null> {
  const chrome = findChrome();
  if (chrome === null) {
    console.log("recording-loop: Chrome 미발견 → 브라우저 녹화 비활성(CHROME_PATH 설정 시 활성).");
    return null;
  }
  console.log("recording-loop: 활성 — 콘솔 '브라우저 녹화로 만들기'의 녹화 시작(status=recording)을 폴링해 headful Chrome 을 띄운다.");

  let stopped = false;
  let busy = false;
  const handled = new Set<string>();
  const openHandles = new Map<string, BrowserRecordingLaunchHandle>();
  // 세션별 seq 카운터(단일 프로세스 — JS 단일스레드라 ++ 는 원자적, MAX(seq) 경합 회피).
  const seqOf = new Map<string, number>();

  const insertEvent = async (sessionId: string, ev: SanitizedRecordingEvent): Promise<void> => {
    const seq = (seqOf.get(sessionId) ?? 0) + 1;
    seqOf.set(sessionId, seq);
    await withTenantTx(pool, tenantId, async (c) => {
      await c.query(
        `INSERT INTO browser_recording_events
           (id, tenant_id, recording_session_id, seq, recording_event_type, selector, label, url, value_preview)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [randomUUID(), tenantId, sessionId, seq, ev.event_type, ev.selector ?? null, ev.label ?? null, ev.url ?? null, ev.value_preview ?? null],
      );
      // 콘솔이 표시하는 진행 카운트 동기화.
      await c.query(`UPDATE browser_recording_sessions SET event_count = event_count + 1, updated_at = now() WHERE id = $1::uuid AND tenant_id = $2::uuid`, [sessionId, tenantId]);
    });
  };

  const tick = async (): Promise<void> => {
    if (stopped || busy) return;
    busy = true;
    let row: RecordingRow | undefined;
    try {
      row = await withTenantTx(pool, tenantId, async (c) => {
        const r = await c.query<RecordingRow>(
          `SELECT id::text AS id, start_url
             FROM browser_recording_sessions
            WHERE status = 'recording'
            ORDER BY created_at
            LIMIT 5`,
        );
        return r.rows.find((x) => !handled.has(x.id));
      });
      if (row === undefined) return;

      const sessionId = row.id;
      handled.add(sessionId); // 성패 무관 1회만 — 실패 시 재시도 폭주 방지(에러는 로깅).
      seqOf.set(sessionId, 0);
      const handle = await defaultLaunchBrowser({
        startUrl: row.start_url,
        chromePath: chrome,
        receive: async (raw) => {
          const ev = sanitizePageEvent(raw);
          if (ev !== null) await insertEvent(sessionId, ev).catch((e) => console.error(`recording-loop ${sessionId.slice(0, 8)} event insert: ${e instanceof Error ? e.message : String(e)}`));
        },
        onNavigate: async (url) => {
          const ev = sanitizePageEvent({ type: "navigate", url });
          if (ev !== null) await insertEvent(sessionId, ev).catch((e) => console.error(`recording-loop ${sessionId.slice(0, 8)} navigate insert: ${e instanceof Error ? e.message : String(e)}`));
        },
        log: (m) => console.log(`recording-loop ${sessionId.slice(0, 8)}: ${m}`),
      });
      openHandles.set(sessionId, handle);
      console.log(`recording-loop: ${sessionId.slice(0, 8)} headful Chrome 오픈(${row.start_url}) — 화면에서 클릭·입력하면 동작이 콘솔 목록에 쌓입니다. 창을 닫으면 캡처 종료.`);
      void handle.waitUntilClosed().then(() => {
        openHandles.delete(sessionId);
        console.log(`recording-loop: ${sessionId.slice(0, 8)} Chrome 닫힘 — 콘솔에서 동작을 검토하고 '녹화 완료'로 봇 초안을 만드세요.`);
      });
    } catch (e) {
      console.error(`recording-loop tick error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      busy = false;
    }
  };

  const timer = setInterval(() => void tick(), intervalMs);
  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      for (const handle of openHandles.values()) await handle.close().catch(() => undefined);
    },
  };
}
