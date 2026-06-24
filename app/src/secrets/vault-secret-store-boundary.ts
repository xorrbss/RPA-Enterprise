/**
 * SecretStoreBoundary 구현 — 최소권한 authorize + secret.resolve 감사 + fail-closed resolve.
 *
 * 계약:
 *  - ts/security-middleware-contract.ts `SecretStoreBoundary`:
 *      authorize(req) → allow{ref} | deny{SECRET_ACCESS_DENIED}
 *      resolveAuthorized(req) → authorize 후 **항상** `secret.resolve` 감사(failClosed) 를 남기고,
 *        allow 면 감사 append 성공 후에만 store.resolve, deny 면 감사 후 throw.
 *  - 최소권한 매트릭스(release-decisions D8-A12 / staging-decision-proposals §3): 런타임 identity 별
 *      허용 purpose 집합. req.purpose 가 identity 허용 집합에 없으면 SECRET_ACCESS_DENIED.
 *      요청 identity 는 principal 에서 주입 가능한 `RuntimeIdentityResolver` 로 도출(roles 와 별개의
 *      서비스-계정 개념 — 기본 resolver 는 `runtime_identity` JWT claim 을 읽는다).
 *
 * 보안: 감사 payload 에는 {ref, purpose, identity} 만 담는다(시크릿 값 절대 미포함). 반환된 PlainSecret 은
 * taint 추적 대상이라 직렬화/로그 sink 로 흐르지 않는다(no-secret-taint + safeSerialize 경계).
 */
import { randomUUID } from "node:crypto";

import type { PlainSecret, SecretStore } from "../../../ts/core-types";
import type { ErrorCode } from "../../../ts/error-catalog";
import {
  SECURITY_AUDIT_PAYLOAD_SCHEMA_REF,
  type AuditOutcome,
  type AuthenticatedPrincipal,
  type CorrelationId,
  type DurableSecurityAuditDecisionWriter,
  type IdempotencyKey,
  type IsoDateTime,
  type SecretAccessDecision,
  type SecretAccessRequest,
  type SecretStoreBoundary,
} from "../../../ts/security-middleware-contract";

/** D8-A12 런타임 identity (RBAC role 과 구분되는 서비스-계정 개념). */
export type RuntimeIdentity =
  | "api"
  | "runtime-worker"
  | "browser-worker"
  | "llm-gateway"
  | "artifact-lifecycle"
  | "connector-runtime";

type ResolvePurpose = SecretAccessRequest["purpose"];

/**
 * 최소권한 resolve 매트릭스 (release-decisions D8-A12, authoritative).
 * `api`→resume_token_hmac(검증)·browser_session(세션 캡처 시 봉투암호화)·connector(public webhook HMAC 검증);
 * signed_command 는 `SecretAccessRequest.purpose`
 * enum 밖이라 여기 미포함(해당 namespace 는 SignedCommandRegistry 경계 책임 — 본 boundary 의 purpose 집합과 분리).
 * browser_session(세션 KEK)은 api(capture/complete 암호화)·runtime-worker/browser-worker(세션 복원 복호화)에 한정 —
 * executor(자격증명 fill)와 분리해 세션키 유출이 라이브 자격증명 트래픽과 격리되게 한다(browser-session-store.ts).
 */
const RESOLVE_MATRIX: Readonly<Record<RuntimeIdentity, readonly ResolvePurpose[]>> = {
  api: ["resume_token_hmac", "browser_session", "connector"],
  "runtime-worker": ["resume_token_hmac", "executor", "browser_session"],
  "browser-worker": ["executor", "browser_session"],
  "llm-gateway": ["gateway_policy"],
  "artifact-lifecycle": ["object_store"],
  "connector-runtime": ["connector"],
};

/** principal → 런타임 identity 도출(주입 가능). */
export interface RuntimeIdentityResolver {
  resolve(principal: AuthenticatedPrincipal): RuntimeIdentity | undefined;
}

/**
 * 기본 resolver — `runtime_identity` JWT claim 에서 도출(서비스-계정 토큰 컨벤션).
 * claim 누락/미지정 값은 fail-closed(undefined → deny). "조용한 false 금지".
 */
export class ClaimRuntimeIdentityResolver implements RuntimeIdentityResolver {
  constructor(private readonly claimKey: string = "runtime_identity") {}

  resolve(principal: AuthenticatedPrincipal): RuntimeIdentity | undefined {
    const raw = principal.claims[this.claimKey];
    return isRuntimeIdentity(raw) ? raw : undefined;
  }
}

function isRuntimeIdentity(value: unknown): value is RuntimeIdentity {
  return typeof value === "string" && value in RESOLVE_MATRIX;
}

export class SecretAccessDeniedError extends Error {
  readonly code: Extract<ErrorCode, "SECRET_ACCESS_DENIED"> = "SECRET_ACCESS_DENIED";
  constructor(readonly reason: string) {
    super(`SECRET_ACCESS_DENIED: ${reason}`);
    this.name = "SecretAccessDeniedError";
  }
}

export interface VaultSecretStoreBoundaryDeps {
  store: SecretStore;
  audit: DurableSecurityAuditDecisionWriter;
  identityResolver?: RuntimeIdentityResolver;
  /** 감사 occurredAt/retentionUntil 결정성(테스트). 기본 system clock. */
  clock?: () => Date;
  /**
   * 감사 retention. 기본 365d(staging-decision-proposals §7 audit_log 제안 하한; 컴플라이언스 오너 override).
   * fail-closed 패턴: writer 는 retentionUntil 누락 시 throw 하므로 항상 명시한다.
   */
  retentionDays?: number;
  /**
   * ref↔purpose namespace 결속 강제(SBA-01/ASSET-01, prod). 켜지면 ref 가 `rpa/<env>/<runtime>/<purpose>/<name…>`
   * 규약을 따르고 4번째 세그먼트(purpose)==request.purpose·3번째(runtime)==resolved identity·빈/`.`/`..` 세그먼트
   * 부재여야 한다. (identity,purpose) 매트릭스만으론, executor fill ref 가 운영자-제어 IR(meta.assets)에서 오므로
   * `rpa/<env>/runtime-worker/resume_token_hmac/active` 같은 타-purpose 경로를 executor purpose 로 해소해 세션/
   * resume 서명키를 유출할 수 있다 — 이 결속이 그 격리(매트릭스 주석 §49-50)를 코드로 강제한다. dev(FakeSecretStore
   * 단축키)는 미주입(permissive, 후방호환). 위반은 SECRET_ACCESS_DENIED(fail-closed 감사).
   */
  enforceRefNamespace?: boolean;
}

export class VaultSecretStoreBoundary implements SecretStoreBoundary {
  readonly store: SecretStore;
  private readonly audit: DurableSecurityAuditDecisionWriter;
  private readonly identityResolver: RuntimeIdentityResolver;
  private readonly clock: () => Date;
  private readonly retentionMs: number;
  private readonly enforceRefNamespace: boolean;

  constructor(deps: VaultSecretStoreBoundaryDeps) {
    this.store = deps.store;
    this.audit = deps.audit;
    this.identityResolver = deps.identityResolver ?? new ClaimRuntimeIdentityResolver();
    this.clock = deps.clock ?? (() => new Date());
    this.retentionMs = Math.max(1, deps.retentionDays ?? 365) * 24 * 60 * 60 * 1000;
    this.enforceRefNamespace = deps.enforceRefNamespace ?? false;
  }

  async authorize(request: SecretAccessRequest): Promise<SecretAccessDecision> {
    const identity = this.identityResolver.resolve(request.principal);
    if (identity === undefined) {
      return {
        kind: "deny",
        code: "SECRET_ACCESS_DENIED",
        reason: "principal has no recognized runtime identity",
      };
    }
    const allowed = RESOLVE_MATRIX[identity];
    if (!allowed.includes(request.purpose)) {
      return {
        kind: "deny",
        code: "SECRET_ACCESS_DENIED",
        reason: `runtime identity '${identity}' may not resolve purpose '${request.purpose}'`,
      };
    }
    if (this.enforceRefNamespace) {
      const denial = refNamespaceDenial(String(request.ref), identity, request.purpose);
      if (denial !== null) {
        return { kind: "deny", code: "SECRET_ACCESS_DENIED", reason: denial };
      }
    }
    return { kind: "allow", ref: request.ref };
  }

  async resolveAuthorized(request: SecretAccessRequest): Promise<PlainSecret> {
    const identity = this.identityResolver.resolve(request.principal);
    const decision = await this.authorize(request);

    // 감사는 allow/deny 무관하게 항상 먼저 기록(failClosed). payload 는 {ref, purpose, identity} 만.
    const outcome: AuditOutcome = decision.kind === "allow" ? "allow" : "deny";
    await this.recordResolveAudit(request, identity, outcome, decisionReason(decision));

    if (decision.kind === "deny") {
      throw new SecretAccessDeniedError(decision.reason);
    }
    // 감사 append 성공 후에만 실제 resolve(append 실패는 위에서 throw → resolve 미도달, fail-closed).
    return this.store.resolve(request.ref);
  }

  private async recordResolveAudit(
    request: SecretAccessRequest,
    identity: RuntimeIdentity | undefined,
    outcome: AuditOutcome,
    reason: string,
  ): Promise<void> {
    const now = this.clock();
    const occurredAt = now.toISOString() as IsoDateTime;
    const retentionUntil = new Date(now.getTime() + this.retentionMs).toISOString() as IsoDateTime;
    await this.audit.recordDecision(
      {
        failClosed: true,
        tenantId: request.principal.tenantId,
        actor: { subjectId: request.principal.subjectId, roles: request.principal.roles },
        action: "secret.resolve",
        outcome,
        resource: { kind: "secret", id: String(request.ref) },
        reason,
        correlationId: randomUUID() as CorrelationId,
        idempotencyKey: randomUUID() as IdempotencyKey,
        occurredAt,
        retentionUntil,
        payloadSchemaRef: SECURITY_AUDIT_PAYLOAD_SCHEMA_REF,
        // 시크릿 값은 절대 미포함 — 메타데이터만.
        payload: { ref: String(request.ref), purpose: request.purpose, identity: identity ?? null },
      },
      outcome,
    );
  }
}

function decisionReason(decision: SecretAccessDecision): string {
  return decision.kind === "allow" ? "least-privilege resolve allowed" : decision.reason;
}

/**
 * ref↔purpose namespace 결속 검증(SBA-01/ASSET-01). ref 는 `rpa/<env>/<runtime>/<purpose>/<name…>` 규약을 따라야 하며
 * runtime(seg[2])==resolved identity·purpose(seg[3])==request.purpose 여야 한다. 빈/`.`/`..` 세그먼트는 경로조작이므로 거부.
 * 위반 사유 문자열(deny) 또는 null(통과). 시크릿 값/경로 전체는 사유에 담지 않는다(세그먼트 메타만).
 */
function refNamespaceDenial(ref: string, identity: RuntimeIdentity, purpose: ResolvePurpose): string | null {
  // percent-encoding 거부(break-it SBA-01-BYPASS-PCTENC): 이 검증기는 디코드를 안 하므로 `..%2f` 같은 인코딩
  //   traversal 이 split('/') 에서 단일 불투명 세그먼트로 보여 통과하나, VaultSecretStore.resolve 는 percent 를 보존해
  //   Vault 서버가 디코드+collapse 하면 cross-purpose 경로(resume_token_hmac/browser_session)로 도달한다(검증↔GET
  //   문자열 불일치). 정당한 executor 비밀 경로는 percent 가 없으므로 ref 에 '%' 가 있으면 즉시 거부(검증/전송 단일 정규형).
  if (ref.includes("%")) {
    return "ref contains percent-encoding (validator/resolve path mismatch — traversal risk)";
  }
  const segs = ref.split("/");
  if (segs.some((s) => s === "" || s === "." || s === "..")) {
    return "ref has empty or path-traversal segment";
  }
  if (segs.length < 5 || segs[0] !== "rpa") {
    return "ref does not follow rpa/<env>/<runtime>/<purpose>/<name> convention";
  }
  if (segs[2] !== identity) {
    return `ref runtime segment '${segs[2]}' does not match identity '${identity}'`;
  }
  if (segs[3] !== purpose) {
    return `ref purpose segment '${segs[3]}' does not match requested purpose '${purpose}'`;
  }
  return null;
}
