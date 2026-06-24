// Product-open 점검(openGate) — D8-A5 결정: 백엔드 없는 **정적 contract-documentation 뷰**.
// 계약 문서(api-surface.md·auth-rbac.md)의 gate map / RBAC action gate / API client contract를
// 로컬 상수로 노출해 검토 가능하게 한다(control-plane gate/checklist 자원을 발명하지 않음 — YAGNI).
// HTML 목업(rpa_enterprise_console.html openGate)의 3개 contract-table을 React로 이식. fetch 없음.

import { Panel } from "../components/Panel";
import type { Tone } from "../components/badges";

// 목업 status(active/pending/risk/system) → badge tone.
function toneOf(status: "active" | "pending" | "risk" | "system"): Tone {
  if (status === "active") return "green";
  if (status === "pending") return "amber";
  if (status === "risk") return "red";
  return "blue";
}

function statusText(status: "active" | "pending" | "risk" | "system"): string {
  if (status === "active") return "반영됨";
  if (status === "pending") return "검토 중";
  if (status === "risk") return "위험 검토";
  return "시스템 항목";
}

function gateLabel(gate: string): string {
  const labels: Record<string, string> = {
    "API client contract": "화면 요청 조건",
    "RBAC 화면/액션 gate": "권한별 화면 제어",
    "Tenant/RLS/Audit": "테넌트 격리·감사",
    "Idempotency/Artifact privacy": "중복 실행 방지·증빙 보호",
    "Scenario validate/promote": "자동화 검사·운영 반영",
    "Human Task inbox": "사람 확인함",
    "DLQ replay / sink retry": "실패 작업 복구",
    "Gateway policy / site approve": "AI 정책·고위험 사이트 승인",
  };
  return labels[gate] ?? gate;
}

function gateSurfaceLabel(surface: string): string {
  const labels: Record<string, string> = {
    "실행/배포/정책/사람확인 명령에서 endpoint·header 노출": "실행·배포·정책·사람 확인 명령의 요청 조건 확인",
    "현재 역할 기준 허용/거부 badge(미허용 명령 버튼 숨김)": "현재 역할 기준으로 허용 동작만 표시",
    "탑바 인증 컨텍스트, RLS 스코프 조회": "인증 컨텍스트와 테넌트 범위 조회",
    "실행/abort/DLQ/sink/site approve 명령": "실행·취소·복구·전달·사이트 승인 명령",
    "자동화 검사 화면·운영 반영 버튼(admin gate)": "자동화 검사와 운영 반영 버튼",
    "사람 확인함, 처리완료·이관": "사람 확인함의 완료·이관 처리",
    "작업 목록·복구 명령": "실패 작업 목록과 재처리 명령",
    "AI 모델 정책 편집(admin), 고위험 사이트 승인": "AI 모델 정책 편집과 고위험 사이트 승인",
  };
  return labels[surface] ?? surface;
}

function gateReviewLabel(review: string): string {
  const labels: Record<string, string> = {
    "요청 body에 tenant_id를 받지 않음(인증 컨텍스트에서만)": "테넌트는 인증 정보에서만 확정합니다.",
    "admin 전용 scenario promote·gateway edit은 거부 상태": "관리자 전용 운영 반영·정책 편집은 권한이 없으면 차단합니다.",
    "cross-tenant는 RESOURCE_NOT_FOUND/RLS로 존재 비노출": "다른 테넌트 자료는 존재 여부도 노출하지 않습니다.",
    "처리 중·실패·타 테넌트 증빙은 v1에서 RESOURCE_NOT_FOUND(404, 존재 비노출·RLS)": "준비 전이거나 권한 밖인 증빙은 존재 여부를 노출하지 않습니다.",
    "현재 역할에 admin이 없으면 AUTHZ_FORBIDDEN": "관리자 권한이 없으면 운영 반영을 차단합니다.",
    "validation/captcha resolve는 reviewer 또는 assignee gate": "검증·챌린지 처리는 담당 검토자 범위에서만 허용합니다.",
    "operator+ · Idempotency-Key, sink는 별도 idempotency key": "운영자 이상만 재처리할 수 있고 중복 실행을 방지합니다.",
    "POLICY_VERSION_CONFLICT·admin gate·approver gate·SITE_PROFILE_BLOCKED 분리": "정책 충돌, 관리자 권한, 승인자 권한, 사이트 차단 사유를 분리해 안내합니다.",
  };
  return labels[review] ?? review;
}

function actionLabel(action: string): string {
  const labels: Record<string, string> = {
    "Run abort": "실행 취소",
    "Human validation resolve": "사람 검증 완료",
    "Approval resolve": "승인 업무 완료",
    "DLQ replay": "실패 작업 재처리",
    "Scenario promote": "자동화 운영 반영",
    "Gateway policy edit": "AI 정책 편집",
    "고위험 사이트 승인": "고위험 사이트 승인",
    "증빙 자료 조회": "증빙 자료 조회",
  };
  return labels[action] ?? action;
}

function roleLabel(role: string): string {
  const labels: Record<string, string> = {
    "operator+": "운영자 이상",
    "reviewer + assignee": "담당 검토자",
    "approver + assignee": "담당 승인자",
    admin: "관리자",
    approver: "승인자",
    "viewer + privacy gate": "조회 권한 + 증빙 보호 통과",
  };
  return labels[role] ?? role;
}

function denyLabel(code: string): string {
  if (code.includes("RESOURCE_NOT_FOUND")) return "존재 비노출 또는 조회 준비 전";
  if (code.includes("SECRET_ACCESS_DENIED")) return "증빙 조회 권한 없음";
  if (code.includes("POLICY_VERSION_CONFLICT")) return "정책 버전 충돌 또는 권한 없음";
  if (code.includes("AUTHZ_FORBIDDEN")) return "권한 없음";
  return code;
}

function requestLabel(header: string): string {
  const labels: Record<string, string> = {
    "Idempotency-Key": "중복 실행 방지",
    "dry-run body": "검사 모드 입력",
    "If-Match + Idempotency-Key": "버전 확인 + 중복 실행 방지",
  };
  return labels[header] ?? header;
}

function responseLabel(response: string): string {
  const labels: Record<string, string> = {
    "params.as_of 1회 고정": "실행 입력 기준 시각을 한 번만 고정",
    "이미 종료면 RUN_ABORTED": "이미 종료된 실행은 취소 불가로 안내",
    "ValidationReport V1..V11": "검사 결과 보고서 제공",
    "SCENARIO_VERSION_CONFLICT / AUTHZ_FORBIDDEN": "버전 충돌 또는 권한 없음 안내",
    "H3 + run.resume_requested": "사람 확인 완료 후 실행 재개 요청",
    "W10 abandoned→new": "기존 실패 항목을 새 작업으로 복구",
    "POLICY_VERSION_CONFLICT / LLM_CAPABILITY_MISMATCH": "정책 충돌 또는 모델 조건 불일치 안내",
    "고위험 사이트 실행 차단 해소": "승인 후 사이트 실행 차단 해소",
  };
  return labels[response] ?? response;
}

interface GateRow {
  gate: string;
  basis: string;
  surface: string;
  status: "active" | "pending" | "risk" | "system";
  review: string;
}

// Product-open gate map — 계약 문서와 화면이 만나는 지점(auth-rbac.md·api-surface.md 파생).
const GATE_MAP: readonly GateRow[] = [
  { gate: "API client contract", basis: "api-surface.md: ApiError, If-Match, Idempotency-Key, cursor paging", surface: "실행/배포/정책/사람확인 명령에서 endpoint·header 노출", status: "active", review: "요청 body에 tenant_id를 받지 않음(인증 컨텍스트에서만)" },
  { gate: "RBAC 화면/액션 gate", basis: "auth-rbac.md role registry + 액션 매트릭스", surface: "현재 역할 기준 허용/거부 badge(미허용 명령 버튼 숨김)", status: "active", review: "admin 전용 scenario promote·gateway edit은 거부 상태" },
  { gate: "Tenant/RLS/Audit", basis: "JWT tenant_id, SET LOCAL app.tenant_id, events envelope", surface: "탑바 인증 컨텍스트, RLS 스코프 조회", status: "active", review: "cross-tenant는 RESOURCE_NOT_FOUND/RLS로 존재 비노출" },
  { gate: "Idempotency/Artifact privacy", basis: "control_plane_idempotency_keys, sink_idempotency_key, artifact gate", surface: "실행/abort/DLQ/sink/site approve 명령", status: "active", review: "처리 중·실패·타 테넌트 증빙은 v1에서 RESOURCE_NOT_FOUND(404, 존재 비노출·RLS)" },
  { gate: "Scenario validate/promote", basis: "POST validate dry-run, PUT/POST promote(If-Match + Idempotency-Key)", surface: "자동화 검사 화면·운영 반영 버튼(admin gate)", status: "pending", review: "현재 역할에 admin이 없으면 AUTHZ_FORBIDDEN" },
  { gate: "Human Task inbox", basis: "GET human-tasks, assign/start/resolve/escalate", surface: "사람 확인함, 처리완료·이관", status: "active", review: "validation/captcha resolve는 reviewer 또는 assignee gate" },
  { gate: "DLQ replay / sink retry", basis: "GET /v1/dlq, POST /v1/dlq/{id}/replay", surface: "작업 목록·복구 명령", status: "active", review: "operator+ · Idempotency-Key, sink는 별도 idempotency key" },
  { gate: "Gateway policy / site approve", basis: "PUT /gateway/policy, POST /sites/{id}/approve", surface: "AI 모델 정책 편집(admin), 고위험 사이트 승인", status: "active", review: "POLICY_VERSION_CONFLICT·admin gate·approver gate·SITE_PROFILE_BLOCKED 분리" },
];

interface RbacRow {
  action: string;
  endpoint: string;
  role: string;
  denyCode: string;
  status: "active" | "pending" | "risk";
}

// RBAC action gate — auth-rbac.md §2 권한 매트릭스 + 자원특정 거부코드(문서용 정적 표).
const RBAC_GATE: readonly RbacRow[] = [
  { action: "Run abort", endpoint: "POST /v1/runs/{id}/abort", role: "operator+", denyCode: "AUTHZ_FORBIDDEN", status: "active" },
  { action: "Human validation resolve", endpoint: "POST /v1/human-tasks/{id}/resolve", role: "reviewer + assignee", denyCode: "AUTHZ_FORBIDDEN", status: "pending" },
  { action: "Approval resolve", endpoint: "POST /v1/human-tasks/{id}/resolve", role: "approver + assignee", denyCode: "AUTHZ_FORBIDDEN", status: "active" },
  { action: "DLQ replay", endpoint: "POST /v1/dlq/{id}/replay", role: "operator+", denyCode: "AUTHZ_FORBIDDEN", status: "active" },
  { action: "Scenario promote", endpoint: "POST /v1/scenarios/{id}/promote", role: "admin", denyCode: "AUTHZ_FORBIDDEN", status: "risk" },
  { action: "Gateway policy edit", endpoint: "PUT /v1/gateway/policy", role: "admin", denyCode: "POLICY_VERSION_CONFLICT / AUTHZ_FORBIDDEN", status: "risk" },
  { action: "고위험 사이트 승인", endpoint: "POST /v1/sites/{id}/approve", role: "approver", denyCode: "AUTHZ_FORBIDDEN", status: "active" },
  { action: "증빙 자료 조회", endpoint: "GET /v1/artifacts/{id}", role: "viewer + privacy gate", denyCode: "RESOURCE_NOT_FOUND(404, v1) / SECRET_ACCESS_DENIED(403)", status: "pending" },
];

interface ApiRow {
  surface: string;
  endpoint: string;
  header: string;
  response: string;
  status: "active" | "pending";
}

// API client contract — 화면 액션이 요구하는 header·동시성 토큰·오류 표면(api-surface.md 파생).
const API_CONTRACT: readonly ApiRow[] = [
  { surface: "새 실행", endpoint: "POST /v1/runs", header: "Idempotency-Key", response: "params.as_of 1회 고정", status: "active" },
  { surface: "실행 취소", endpoint: "POST /v1/runs/{id}/abort", header: "Idempotency-Key", response: "이미 종료면 RUN_ABORTED", status: "active" },
  { surface: "자동화 검사", endpoint: "POST /v1/scenarios/{id}/validate", header: "dry-run body", response: "ValidationReport V1..V11", status: "active" },
  { surface: "자동화 운영 반영", endpoint: "POST /v1/scenarios/{id}/promote", header: "If-Match + Idempotency-Key", response: "SCENARIO_VERSION_CONFLICT / AUTHZ_FORBIDDEN", status: "pending" },
  { surface: "사람확인 처리", endpoint: "POST /v1/human-tasks/{id}/resolve", header: "Idempotency-Key", response: "H3 + run.resume_requested", status: "pending" },
  { surface: "실패 작업 재처리", endpoint: "POST /v1/dlq/{id}/replay", header: "Idempotency-Key", response: "W10 abandoned→new", status: "pending" },
  { surface: "Gateway 정책", endpoint: "PUT /v1/gateway/policy", header: "If-Match + Idempotency-Key", response: "POLICY_VERSION_CONFLICT / LLM_CAPABILITY_MISMATCH", status: "active" },
  { surface: "사이트 승인", endpoint: "POST /v1/sites/{id}/approve", header: "Idempotency-Key", response: "고위험 사이트 실행 차단 해소", status: "pending" },
];

export function OpenGateView(): JSX.Element {
  return (
    <div>
      <Panel title="제품 오픈 점검" subtitle="출시 전 권한·감사·요청 조건 검토">
        <p style={{ padding: "0 16px", color: "var(--muted)", fontSize: 13, margin: "8px 0" }}>
          이 화면은 출시 전 확인해야 하는 요청 조건, 오류 안내, 권한 확인, 감사 근거를
          콘솔에서 검토할 수 있도록 정리합니다. 근거가 부족한 항목은 임의로 통과시키지 않고 보류로 둡니다.
        </p>
      </Panel>

      <Panel title="출시 점검 항목" subtitle="화면 동선별 출시 준비 상태">
        <table>
          <thead>
            <tr><th>점검 항목</th><th>화면 동선</th><th>상태</th><th>검토 포인트</th><th>근거</th></tr>
          </thead>
          <tbody>
            {GATE_MAP.map((r) => (
              <tr key={r.gate}>
                <td>{gateLabel(r.gate)}</td>
                <td>{gateSurfaceLabel(r.surface)}</td>
                <td><span className={`badge ${toneOf(r.status)}`}>{statusText(r.status)}</span></td>
                <td style={{ color: "var(--muted)" }}>{gateReviewLabel(r.review)}</td>
                <td>
                  <details className="developer-details">
                    <summary>검증 근거 보기</summary>
                    <dl>
                      <dt>원문 점검 항목</dt>
                      <dd><code>{r.gate}</code></dd>
                      <dt>기준 문서</dt>
                      <dd><code>{r.basis}</code></dd>
                      <dt>원문 검토 조건</dt>
                      <dd><code>{r.review}</code></dd>
                    </dl>
                  </details>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>

      <Panel title="권한 확인" subtitle="역할별 허용 동작과 거부 안내">
        <table>
          <thead>
            <tr><th>업무 동작</th><th>필요 역할</th><th>거부 안내</th><th>상태</th><th>근거</th></tr>
          </thead>
          <tbody>
            {RBAC_GATE.map((r) => (
              <tr key={r.action}>
                <td>{actionLabel(r.action)}</td>
                <td>{roleLabel(r.role)}</td>
                <td style={{ color: "var(--muted)" }}>{denyLabel(r.denyCode)}</td>
                <td><span className={`badge ${toneOf(r.status)}`}>{statusText(r.status)}</span></td>
                <td>
                  <details className="developer-details">
                    <summary>검증 근거 보기</summary>
                    <dl>
                      <dt>연동 경로</dt>
                      <dd><code>{r.endpoint}</code></dd>
                      <dt>원문 권한 기준</dt>
                      <dd><code>{r.role}</code></dd>
                      <dt>원문 거부 조건</dt>
                      <dd><code>{r.denyCode}</code></dd>
                    </dl>
                  </details>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>

      <Panel title="화면 요청 조건" subtitle="중복 방지와 오류 안내">
        <table>
          <thead>
            <tr><th>화면 동작</th><th>요청 조건</th><th>응답 안내</th><th>상태</th><th>근거</th></tr>
          </thead>
          <tbody>
            {API_CONTRACT.map((r) => (
              <tr key={r.surface}>
                <td>{r.surface}</td>
                <td>{requestLabel(r.header)}</td>
                <td style={{ color: "var(--muted)" }}>{responseLabel(r.response)}</td>
                <td><span className={`badge ${toneOf(r.status)}`}>{statusText(r.status)}</span></td>
                <td>
                  <details className="developer-details">
                    <summary>검증 근거 보기</summary>
                    <dl>
                      <dt>연동 경로</dt>
                      <dd><code>{r.endpoint}</code></dd>
                      <dt>요청 보호값</dt>
                      <dd><code>{r.header}</code></dd>
                      <dt>원문 응답 조건</dt>
                      <dd><code>{r.response}</code></dd>
                    </dl>
                  </details>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </div>
  );
}
