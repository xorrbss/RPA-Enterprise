// 중복 방지(idempotency) — 정적 contract-documentation 뷰 (openGate 와 동형, 백엔드 없음).
// 오너 결정: control_plane_idempotency_keys 의 라이브 read 표면은 net-new 계약(엔드포인트+RBAC 액션)을
// 발명해야 하고 운영 가치가 낮아 짓지 않는다(YAGNI). 대신 HTML 목업(rpa_enterprise_console.html idempotency)
// 의 "중복 방지" 설명 화면을 계약 문서에서 파생한 로컬 상수로 이식한다. 목업의 mock 수치(99.1% 등)는
// 근거 없는 가정이라 제외하고, 각 행을 실제 계약 아티팩트에 매핑한다(가정 금지). fetch 없음.

import { Panel } from "../components/Panel";
import type { Tone } from "../components/badges";

interface MechanismRow {
  layer: string;
  layerTone: Tone;
  target: string;
  key: string;
  basis: string;
}

// 멱등(중복 방지) 메커니즘 — 계층별. 키 규약·근거는 api-surface §0.4 / migration SQL / impl-contracts-bundle 파생.
const MECHANISMS: readonly MechanismRow[] = [
  {
    layer: "제어평면",
    layerTone: "blue",
    target: "명령형 POST (run create/abort · promote · human-task · DLQ replay · site approve · gateway)",
    key: "tenant_id + endpoint + Idempotency-Key (request_hash 로 본문 변조 탐지)",
    basis: "api-surface §0.4 · control_plane_idempotency_keys",
  },
  {
    layer: "데이터 수집",
    layerTone: "green",
    target: "원본 항목 (raw_items)",
    key: "natural key (UNIQUE NULLS NOT DISTINCT)",
    basis: "migration_concurrency_idempotency · raw_items",
  },
  {
    layer: "데이터 전달",
    layerTone: "green",
    target: "외부 sink 전송 (sink_deliveries)",
    key: "tenant_id : sink_config_id : schema_ref : natural_key",
    basis: "api-surface §0.4 · sink_deliveries.sink_idempotency_key",
  },
  {
    layer: "인증",
    layerTone: "amber",
    target: "챌린지 해결 시도 (challenge_resolution_attempts)",
    key: "시도 단위 기록 — 동일 인증 재실행 방지",
    basis: "migration_concurrency_idempotency · challenge_resolution_attempts",
  },
  {
    layer: "실행기",
    layerTone: "muted",
    target: "액션 계획 캐시 (action_plan_cache)",
    key: "scenario + step + page-state 특징 + model",
    basis: "impl-contracts-bundle ActionPlanCache · action_plan_cache",
  },
];

interface FlowRow {
  situation: string;
  handling: string;
  result: string;
  resultTone: Tone;
}

// 제어평면 멱등 키 처리 흐름 — reserve/replay 분기. api-surface §0.4 · release-decisions #7 · app/src/api/idempotency.ts.
const CONTROL_PLANE_FLOW: readonly FlowRow[] = [
  {
    situation: "최초 제출",
    handling: "(tenant_id, endpoint, Idempotency-Key) 예약 → status=processing",
    result: "명령 실행 후 succeeded/failed + 응답 기록",
    resultTone: "green",
  },
  {
    situation: "동일 키 재제출 (완료된 명령)",
    handling: "부작용 재실행 없이 최초 응답 재생 (replay)",
    result: "저장된 response_status / response_body 반환",
    resultTone: "green",
  },
  {
    situation: "처리 중 재제출 (in-flight)",
    handling: "예약이 processing 상태로 가시 → 충돌",
    result: "WORKITEM_CHECKOUT_CONFLICT (409, 재시도 가능)",
    resultTone: "amber",
  },
  {
    situation: "본문 변조 (request_hash 불일치)",
    handling: "동일 키이나 canonical request_hash 가 다름",
    result: "SCENARIO_VERSION_CONFLICT (412) 거부",
    resultTone: "red",
  },
];

interface LeaseRow {
  target: string;
  unit: string;
  basis: string;
}

// 동시성 점유(lease) — 같은 계정/브라우저 동시 점유 차단. migration_concurrency_idempotency.sql · ops-defaults.
const LEASES: readonly LeaseRow[] = [
  {
    target: "자격증명 슬롯",
    unit: "credential_leases (slot_no · max_concurrency, §19 기본 1)",
    basis: "credential_concurrency_policies",
  },
  {
    target: "브라우저",
    unit: "browser_leases (실행 단위 · TTL 만료 sweeper 회수)",
    basis: "migration_concurrency_idempotency · ops-defaults §lease",
  },
];

export function IdempotencyView(): JSX.Element {
  return (
    <div>
      <Panel title="중복 방지 (idempotency)" subtitle="정적 contract-documentation 뷰 · 백엔드 없음">
        <p style={{ padding: "0 16px", color: "var(--muted)", fontSize: 13, margin: "8px 0" }}>
          이 화면은 시스템 계층별 중복 방지(멱등) 메커니즘과 키 규약을 계약 문서(api-surface §0.4 ·
          migration SQL · impl-contracts-bundle)에서 파생해 검토할 수 있게 노출합니다. control_plane_idempotency_keys
          의 라이브 키 목록은 별도 read 표면을 발명하지 않았습니다(내부 재시도-보호 메커니즘 · YAGNI).
        </p>
      </Panel>

      <Panel title="중복 방지 메커니즘" subtitle="계층별 멱등 키 규약 · 계약 근거">
        <table>
          <thead>
            <tr>
              <th>계층</th>
              <th>대상</th>
              <th>중복 판단 키</th>
              <th>계약 근거</th>
            </tr>
          </thead>
          <tbody>
            {MECHANISMS.map((r) => (
              <tr key={r.target}>
                <td>
                  <span className={`badge ${r.layerTone}`}>{r.layer}</span>
                </td>
                <td>{r.target}</td>
                <td style={{ color: "var(--muted)" }}>{r.key}</td>
                <td style={{ color: "var(--muted)" }}>
                  <code>{r.basis}</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>

      <Panel title="제어평면 멱등 키 처리 흐름" subtitle="control_plane_idempotency_keys · api-surface §0.4 · release-decisions #7">
        <table>
          <thead>
            <tr>
              <th>상황</th>
              <th>처리</th>
              <th>결과</th>
            </tr>
          </thead>
          <tbody>
            {CONTROL_PLANE_FLOW.map((r) => (
              <tr key={r.situation}>
                <td>{r.situation}</td>
                <td style={{ color: "var(--muted)" }}>{r.handling}</td>
                <td>
                  <span className={`badge ${r.resultTone}`}>{r.result}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>

      <Panel title="동시성 점유 (lease)" subtitle="같은 계정·브라우저 동시 점유 차단 · migration_concurrency_idempotency.sql">
        <table>
          <thead>
            <tr>
              <th>대상</th>
              <th>점유 단위</th>
              <th>정책 근거</th>
            </tr>
          </thead>
          <tbody>
            {LEASES.map((r) => (
              <tr key={r.target}>
                <td>{r.target}</td>
                <td style={{ color: "var(--muted)" }}>{r.unit}</td>
                <td style={{ color: "var(--muted)" }}>
                  <code>{r.basis}</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </div>
  );
}
