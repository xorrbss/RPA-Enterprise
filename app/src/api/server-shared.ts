/**
 * 제어평면 API 공유 경계 — ApiServerDeps/ArtifactObjectReader 의존성 표면, 공유 상수(UUID/멱등 TTL),
 * 요청 principal 가드, 멱등 응답·에러 본문 헬퍼. server.ts(buildServer)·server-create-run·server-abort-run 공유.
 * value-cycle 회피: 형제 모듈(server-create-run/server-abort-run)을 import 하지 않는 단방향 leaf.
 */
import type { FastifyRequest, FastifyServerOptions } from "fastify";
import type { Pool } from "pg";

import { isApiErrorResponse, toApiError } from "../../../codegen/error-middleware";
import type { ObjectRef } from "../../../ts/core-types";
import type { ControlPlaneIdempotencyStore } from "../../../ts/control-plane-contract";
import { ERROR_CATALOG, type ApiError } from "../../../ts/error-catalog";
import type {
  AuthenticatedPrincipal,
  AuthenticationBoundary,
  DurableSecurityAuditDecisionWriter,
  RbacAction,
  RbacMiddleware,
  Role,
  SecretStoreBoundary,
  SignedCommandRegistry,
} from "../../../ts/security-middleware-contract";
import type { BrowserSessionStore } from "../runtime/browser-session-store";
import type { JwtClaimMapping, JwtRoleMap } from "./auth";
import { ApiResponseError } from "./errors";
import type { RunEnqueuer } from "./run-queue";
import type { PrincipalDirectoryWriter } from "./principal-directory";
import type { ScenarioPlanner } from "./scenario-generation-types";
import type { ScenarioGenerationArtifactBuffer } from "./scenario-generation-artifacts";
import type { ScenarioGenerationLlmCallCleanup } from "./scenario-generation-llm-call-idempotency-store";
import type { SecurityConfig } from "./security";

declare module "fastify" {
  interface FastifyRequest {
    correlationId: string;
    principal: AuthenticatedPrincipal | null;
  }
  // 라우트별 RBAC 액션 선언(auth-rbac §2). RBAC preHandler가 이 값으로 authorize를 호출한다.
  interface FastifyContextConfig {
    rbacAction?: RbacAction;
    skipJwtAuth?: boolean;
  }
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * artifact 본문 read 경계(narrow — api는 byte-store 구현에 의존하지 않는다, 단방향 의존).
 * `FsObjectStore`(로컬/CI)와 SecretRef-backed S3 reader 등 ObjectStore 구현이 구조적으로 충족.
 * composition root는 `file://`/configured `s3://bucket/` scheme router를 주입한다. 미지정 시
 * GET /v1/artifacts 라우트는 미등록(조회 capability 미노출).
 */
export interface ArtifactObjectReader {
  /** object bytes 반환. **부재 시 null**(라우트가 fail-closed 404 처리 — 가시 metadata인데 object 부재=무결성 이슈). */
  get(objectRef: ObjectRef): Promise<string | null>;
  /** object raw bytes. Binary artifact routes use this path to avoid lossy UTF-8 decoding. */
  getBytes(objectRef: ObjectRef): Promise<Uint8Array | null>;
}

export type SelectorProbeStatus = "matched" | "not_found" | "invalid_selector" | "failed";

export interface SelectorProbeInput {
  readonly tenantId: string;
  readonly siteProfileId: string;
  readonly elementId: string;
  readonly selector: string;
  readonly sampleUrl: string | null;
  readonly correlationId: string;
}

export interface SelectorProbeResult {
  readonly status: SelectorProbeStatus;
  readonly matchCount: number | null;
  readonly reasonCode?: string | null;
}

export interface SelectorProbeProvider {
  probe(input: SelectorProbeInput): Promise<SelectorProbeResult>;
}

export interface AuthReadinessConfig {
  readonly mode: "hs256" | "jwks";
  readonly configurationSource: "deployment_config" | "test_default";
  readonly jwksUrl?: string;
  readonly issuer?: string;
  readonly audience?: string;
  readonly claimMapping?: JwtClaimMapping;
  readonly roleMap?: JwtRoleMap;
}

export interface ApiServerDeps {
  pool: Pool;
  auth: AuthenticationBoundary;
  rbac: RbacMiddleware;
  idempotency: ControlPlaneIdempotencyStore;
  enqueuer: RunEnqueuer;
  signedCommandRegistry: SignedCommandRegistry;
  /** B2/B3 보안 인프라(선택). 미지정 시 베이스라인 헤더만 적용하고 CORS는 비활성(same-origin). */
  security?: SecurityConfig;
  /** artifact 본문 read 경계(선택). 미지정 시 GET /v1/artifacts/{id} 미등록(D8-A1 fail-closed). */
  artifactStore?: ArtifactObjectReader;
  scenarioGenerationCapabilities?: {
    readonly videoRecording: boolean;
  };
  /** Optional non-default natural-language planner implementation. deterministic_mvp remains the fail-closed default. */
  scenarioGenerationPlanner?: ScenarioPlanner;
  /** Optional buffer for generation-scoped planner artifacts. Flushes only after the generation ledger row exists. */
  scenarioGenerationArtifacts?: ScenarioGenerationArtifactBuffer;
  /** Optional generation-scoped LLM call ledger cleanup for failed planning/save attempts. */
  scenarioGenerationLlmCalls?: ScenarioGenerationLlmCallCleanup;
  /**
   * security-contracts §10 audit boundary writer. `artifact.read`(artifact 본문 disclosure)는 본문 반환 전
   * 이 boundary에 fail-closed append해야 한다(§10:147-148). artifactStore가 주입되면 필수 —
   * 미주입 시 artifact read capability는 audit 없이 노출될 수 없다(fail-closed, registerReadRoutes에서 강제).
   */
  securityAudit?: DurableSecurityAuditDecisionWriter;
  /**
   * 운영자-보조 캡처 완료 세션 스토어(선택). 미지정 시 POST /v1/sites/{id}/session/capture/complete 미등록 —
   * 캡처된 쿠키를 받아 봉투암호화(주입된 encryptor)·browser_sessions 저장하는 prod 캡처 경로(P3, dev=DevPlaintext·prod=AesGcm).
   */
  sessionStore?: BrowserSessionStore;
  /**
   * Principal 디렉터리 쓰기(선택, name-picker). 주입 시 인증 성공마다 JWT `name` 클레임을 best-effort upsert해
   * 담당자 디렉터리를 동기화한다. 미주입 시 JWT 자동 동기화는 비활성(GET /v1/principals는 그대로 동작).
   */
  principalDirectory?: PrincipalDirectoryWriter;
  /** Optional tenant-scoped manual RBAC assignment resolver. When injected, roles are token roles ∪ active manual assignments. */
  roleAssignments?: {
    resolveActiveRoles(tenantId: string, principalSub: string): Promise<readonly Role[]>;
  };
  /** Enterprise hardening: if true, missing roleAssignments resolver is fail-closed after authentication. */
  roleAssignmentsRequired?: boolean;
  /** Enterprise ALM hardening: if true, legacy /promote cannot bypass release maker-checker. */
  enforceAlmMakerChecker?: boolean;
  /** Webhook trigger HMAC verification key boundary. Values are resolved only while verifying a signed webhook and always through secret.resolve audit. */
  webhookSecretBoundary?: SecretStoreBoundary;
  /** SCIM inbound HMAC verification key boundary. Provider rows store only SecretRef metadata; key material stays behind SecretStore. */
  scimSignatureSecretBoundary?: SecretStoreBoundary;
  /** Optional live DOM selector probe boundary. Missing provider is surfaced as not_run, never inferred success. */
  selectorProbe?: SelectorProbeProvider;
  /** Public auth readiness metadata for security review surfaces. Secrets are never exposed. */
  authReadiness?: AuthReadinessConfig;
  /**
   * Fastify 구조화 로거 설정(선택). 미지정 시 `false`(무음) — 테스트/내장 경계는 조용히 유지된다. 프로덕션(main.ts)은
   * pino 설정을 주입해 authz 거부·미분류 에러 경로의 request.log.warn/error(correlation_id·code 포함)를 실제로 방출한다.
   * Authorization/Cookie 헤더는 호출측 redact 로 마스킹한다(security 경계).
   */
  logger?: FastifyServerOptions["logger"];
}

export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

export interface CommandResponse {
  status: number;
  body: unknown;
}

export function requirePrincipal(request: FastifyRequest): AuthenticatedPrincipal {
  if (request.principal === null) {
    // preHandler 인증이 선행 보장. 방어적(가정 금지) — 도달 시 인증 경계 결함. 사유는 응답에 노출하지 않는다.
    request.log.error({ correlation_id: request.correlationId }, "principal missing after auth preHandler");
    throw new ApiResponseError("UNAUTHENTICATED");
  }
  return request.principal;
}

/** 분류된 실패(ApiResponseError)를 멱등 레코드에 저장할 ApiError 본문으로 변환. */
export function apiErrorBody(err: ApiResponseError, correlationId: string): ApiError {
  const mapped = toApiError(err.code, correlationId, err.details);
  if (isApiErrorResponse(mapped)) {
    return mapped.body;
  }
  // 도달 불가: err.code는 DEAD_LETTER(상태통지)를 타입에서 배제.
  return { code: err.code, message: ERROR_CATALOG[err.code].userMessage, correlation_id: correlationId };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeFailureReason(value: unknown): { code: string; message: string } | null {
  if (!isRecord(value)) return null;
  const code = typeof value.code === "string" && value.code.length > 0 ? value.code : "RUN_FAILED";
  const message = typeof value.message === "string" && value.message.length > 0 ? value.message : code;
  return { code, message };
}
