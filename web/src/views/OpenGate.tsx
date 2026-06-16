// Product-open 점검(openGate) — D8-A5 결정: 백엔드 없는 **정적 contract-documentation 뷰**.
// 계약 문서(api-surface.md·auth-rbac.md)의 gate map / RBAC action gate / API client contract를
// 로컬 상수로 노출해 검토 가능하게 한다(control-plane gate/checklist 자원을 발명하지 않음 — YAGNI).
// HTML 목업(rpa_enterprise_console.html openGate)의 3개 contract-table을 React로 이식. fetch 없음.

type Tone = "green" | "amber" | "red" | "blue";

// 목업 status(active/pending/risk/system) → badge tone.
function toneOf(status: "active" | "pending" | "risk" | "system"): Tone {
  if (status === "active") return "green";
  if (status === "pending") return "amber";
  if (status === "risk") return "red";
  return "blue";
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
  { gate: "Idempotency/Redaction", basis: "control_plane_idempotency_keys, sink_idempotency_key, artifact gate", surface: "실행/abort/DLQ/sink/site approve 명령", status: "active", review: "pending/failed artifact는 ARTIFACT_NOT_REDACTED" },
  { gate: "Scenario validate/promote", basis: "POST validate dry-run, PUT/POST promote(If-Match + Idempotency-Key)", surface: "시나리오 검사 화면·승격 버튼(admin gate)", status: "pending", review: "현재 역할에 admin이 없으면 AUTHZ_FORBIDDEN" },
  { gate: "Human Task inbox", basis: "GET human-tasks, assign/start/resolve/escalate", surface: "사람 확인함, 처리완료·이관", status: "active", review: "validation/captcha resolve는 reviewer 또는 assignee gate" },
  { gate: "DLQ replay / sink retry", basis: "GET /v1/dlq, POST /v1/dlq/{id}/replay", surface: "작업 목록·복구 명령", status: "active", review: "operator+ · Idempotency-Key, sink는 별도 idempotency key" },
  { gate: "Gateway policy / site approve", basis: "PUT /gateway/policy, POST /sites/{id}/approve", surface: "AI 모델 정책 편집(admin), red site 승인", status: "active", review: "POLICY_VERSION_CONFLICT·admin gate·approver gate·SITE_PROFILE_BLOCKED 분리" },
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
  { action: "Red site approve", endpoint: "POST /v1/sites/{id}/approve", role: "approver", denyCode: "AUTHZ_FORBIDDEN", status: "active" },
  { action: "Artifact view", endpoint: "GET /v1/artifacts/{id}", role: "viewer + redaction", denyCode: "ARTIFACT_NOT_REDACTED / SECRET_ACCESS_DENIED", status: "pending" },
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
  { surface: "시나리오 검사", endpoint: "POST /v1/scenarios/{id}/validate", header: "dry-run body", response: "ValidationReport V1..V11", status: "active" },
  { surface: "시나리오 승격", endpoint: "POST /v1/scenarios/{id}/promote", header: "If-Match + Idempotency-Key", response: "SCENARIO_VERSION_CONFLICT / AUTHZ_FORBIDDEN", status: "pending" },
  { surface: "사람확인 처리", endpoint: "POST /v1/human-tasks/{id}/resolve", header: "Idempotency-Key", response: "H3 + run.resume_requested", status: "pending" },
  { surface: "DLQ 재처리", endpoint: "POST /v1/dlq/{id}/replay", header: "Idempotency-Key", response: "W10 abandoned→new", status: "pending" },
  { surface: "Gateway 정책", endpoint: "PUT /v1/gateway/policy", header: "If-Match + Idempotency-Key", response: "POLICY_VERSION_CONFLICT / LLM_CAPABILITY_MISMATCH", status: "active" },
  { surface: "사이트 승인", endpoint: "POST /v1/sites/{id}/approve", header: "Idempotency-Key", response: "risk=red 실행 차단 해소", status: "pending" },
];

function Panel({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }): JSX.Element {
  return (
    <section className="panel" style={{ marginBottom: 16 }}>
      <div className="panel-head">
        <h2>{title}</h2>
        {subtitle !== undefined && <span style={{ color: "var(--muted)", fontSize: 12 }}>{subtitle}</span>}
      </div>
      <div className="panel-body">{children}</div>
    </section>
  );
}

export function OpenGateView(): JSX.Element {
  return (
    <div>
      <Panel title="Product-open 점검" subtitle="정적 contract-documentation 뷰 (D8-A5 · 백엔드 없음)">
        <p style={{ padding: "0 16px", color: "var(--muted)", fontSize: 13, margin: "8px 0" }}>
          이 화면은 계약 문서(api-surface · auth-rbac)의 endpoint · header · error code · 권한 gate를
          콘솔에서 검토할 수 있도록 노출합니다. 계약이 부족한 항목은 추정하지 않고 BLOCKED로 둡니다(조용한 가정 금지).
        </p>
      </Panel>

      <Panel title="Product-open gate map" subtitle="계약 문서와 화면이 만나는 지점">
        <table>
          <thead>
            <tr><th>Gate</th><th>계약 기준</th><th>화면 surface</th><th>상태</th><th>검토 포인트</th></tr>
          </thead>
          <tbody>
            {GATE_MAP.map((r) => (
              <tr key={r.gate}>
                <td>{r.gate}</td>
                <td style={{ color: "var(--muted)" }}>{r.basis}</td>
                <td>{r.surface}</td>
                <td><span className={`badge ${toneOf(r.status)}`}>{r.status}</span></td>
                <td style={{ color: "var(--muted)" }}>{r.review}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>

      <Panel title="RBAC action gate" subtitle="auth-rbac.md §2 권한 매트릭스 · 자원특정 거부코드">
        <table>
          <thead>
            <tr><th>Action</th><th>Endpoint</th><th>필요 역할</th><th>거부 코드</th><th>상태</th></tr>
          </thead>
          <tbody>
            {RBAC_GATE.map((r) => (
              <tr key={r.action}>
                <td>{r.action}</td>
                <td><code>{r.endpoint}</code></td>
                <td>{r.role}</td>
                <td style={{ color: "var(--muted)" }}>{r.denyCode}</td>
                <td><span className={`badge ${toneOf(r.status)}`}>{r.status}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>

      <Panel title="API client contract" subtitle="화면 액션이 요구하는 header · 동시성 토큰 · 오류 표면">
        <table>
          <thead>
            <tr><th>Surface</th><th>Endpoint</th><th>필수 header/key</th><th>동시성/응답</th><th>상태</th></tr>
          </thead>
          <tbody>
            {API_CONTRACT.map((r) => (
              <tr key={r.surface}>
                <td>{r.surface}</td>
                <td><code>{r.endpoint}</code></td>
                <td>{r.header}</td>
                <td style={{ color: "var(--muted)" }}>{r.response}</td>
                <td><span className={`badge ${toneOf(r.status)}`}>{r.status}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </div>
  );
}
