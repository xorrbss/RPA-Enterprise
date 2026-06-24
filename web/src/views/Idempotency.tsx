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
    layer: "운영 명령",
    layerTone: "blue",
    target:
      "실행 시작/취소 · 운영 반영 · 사람 확인 · 재처리 · 사이트 승인 · AI 정책 변경",
    key: "접속 테넌트 + 업무 동작 + 요청 고유값",
    basis: "운영 명령 중복 방지 저장소",
  },
  {
    layer: "데이터 수집",
    layerTone: "green",
    target: "수집 원본 항목",
    key: "업무 고유값",
    basis: "수집 원본 중복 제한",
  },
  {
    layer: "데이터 전달",
    layerTone: "green",
    target: "외부 시스템 전달",
    key: "접속 테넌트 + 전달 설정 + 데이터 종류 + 업무 고유값",
    basis: "전달 이력 중복 키",
  },
  {
    layer: "추가 인증",
    layerTone: "amber",
    target: "추가 인증·챌린지 해결 시도",
    key: "시도 단위 기록 — 동일 인증 재실행 방지",
    basis: "인증 시도 이력",
  },
  {
    layer: "실행기",
    layerTone: "muted",
    target: "화면 액션 계획 캐시",
    key: "자동화 + 단계 + 화면 상태 + AI 모델",
    basis: "계획 캐시",
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
    handling: "요청 고유값을 예약하고 처리 중 상태로 표시",
    result: "명령 실행 후 성공/실패와 응답 기록",
    resultTone: "green",
  },
  {
    situation: "동일 요청 재제출 (완료된 명령)",
    handling: "부작용 재실행 없이 최초 응답 반환",
    result: "최초 처리 결과 재사용",
    resultTone: "green",
  },
  {
    situation: "처리 중 재제출 (in-flight)",
    handling: "이미 처리 중인 요청으로 감지",
    result: "잠시 후 다시 시도 안내",
    resultTone: "amber",
  },
  {
    situation: "요청 내용 변경",
    handling: "같은 요청 고유값으로 다른 내용을 보내면 거부",
    result: "변경된 요청으로 보아 차단",
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
    unit: "로그인 계정별 동시 실행 수 제한",
    basis: "자격증명 동시성 정책",
  },
  {
    target: "브라우저",
    unit: "실행 단위 브라우저 점유와 만료 후 회수",
    basis: "브라우저 점유 정책",
  },
];

export function IdempotencyView(): JSX.Element {
  return (
    <div>
      <Panel
        title="중복 방지"
        subtitle="운영 명령과 데이터 처리의 재실행 보호"
      >
        <p
          style={{
            padding: "0 16px",
            color: "var(--muted)",
            fontSize: 13,
            margin: "8px 0",
          }}
        >
          이 화면은 같은 요청이 반복되거나 사용자가 다시 클릭해도 실행, 전달,
          검토 업무가 중복 처리되지 않는지 확인하는 운영 점검 화면입니다. 내부 키
          목록을 직접 노출하지 않고, 계층별 판단 기준과 처리 결과만 보여줍니다.
        </p>
      </Panel>

      <Panel
        title="중복 방지 메커니즘"
        subtitle="계층별 중복 판단 기준"
      >
        <table>
          <thead>
            <tr>
              <th>계층</th>
              <th>대상</th>
              <th>중복 판단 기준</th>
              <th>운영 근거</th>
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
                <td style={{ color: "var(--muted)" }}>{r.basis}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>

      <Panel
        title="운영 명령 중복 처리 흐름"
        subtitle="재클릭·재시도·변경된 요청 처리 기준"
      >
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

      <Panel
        title="동시 실행 점유"
        subtitle="같은 계정·브라우저 동시 점유 차단"
      >
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
                <td style={{ color: "var(--muted)" }}>{r.basis}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </div>
  );
}
