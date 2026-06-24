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
}

export class VaultSecretStoreBoundary implements SecretStoreBoundary {
  readonly store: SecretStore;
  private readonly audit: DurableSecurityAuditDecisionWriter;
  private readonly identityResolver: RuntimeIdentityResolver;
  private readonly clock: () => Date;
  private readonly retentionMs: number;

  constructor(deps: VaultSecretStoreBoundaryDeps) {
    this.store = deps.store;
    this.audit = deps.audit;
    this.identityResolver = deps.identityResolver ?? new ClaimRuntimeIdentityResolver();
    this.clock = deps.clock ?? (() => new Date());
    this.retentionMs = Math.max(1, deps.retentionDays ?? 365) * 24 * 60 * 60 * 1000;
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
