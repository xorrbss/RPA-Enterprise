/**
 * Core Runtime Types v1
 * Executor 구현체(Stagehand / Vision / Utility(CDP)) 공유 계약.
 * 결과 포맷 통일 → 런타임 안정성. brand 타입은 보안 경계(impl-contracts-bundle.md C 참조).
 */

// ===== Brand types (보안) =====
export type SecretRef = string & { readonly __brand: "SecretRef" };
export type PlainSecret = string & { readonly __brand: "PlainSecret_DoNotLog" };
export type RedactedString = string & { readonly __brand: "Redacted" };

export type ArtifactRef = string & { readonly __brand: "ArtifactRef" }; // artifacts.id
export type ArtifactId = ArtifactRef;
export type ObjectRef = string & { readonly __brand: "ObjectRef" }; // artifacts.object_ref
export type PageStateRef = string;

// ===== SecretStore (시크릿 경계 진입점) =====
// [FIX] impl-contracts-bundle.md §C / RunContext.assetRefs가 참조하던 SecretStore 시그니처 고정.
//   resolve()만 PlainSecret을 반환하며 그 결과는 taint 추적 대상(safeSerialize 경계). Executor는
//   SecretRef만 보유하고 결과를 직접 LLM/로그/이벤트/artifact에 전달 금지(brand + lint 강제).
//   키 자료(HMAC kid 등)의 회전/식별은 SecretStore/KMS 내부 책임 — DB 테이블 아님.
export interface SecretStore {
  resolve(ref: SecretRef): Promise<PlainSecret>;
}

// ===== PageState =====
export type DomLandmark = { role: string; name: string; pathHash: string };
export type FrameSummary = { kind: "iframe" | "shadow"; urlPattern?: string; landmarkCount: number };
export type Viewport = { width: number; height: number; dpr: number };

export type ChallengeSummary = {
  type: "captcha" | "mfa" | "block_page" | "rate_limit" | "login_loop" | "access_denied" | "session_expired" | "unknown";
  detectedBy: "dom" | "network" | "screenshot" | "vlm";
  confidence: number;
};

export type PageState = {
  url: { raw: string; canonical: string; pattern: string };
  dom: {
    structuralHash: string;
    visibleTextHash: string;
    landmarks: DomLandmark[];
    frames: FrameSummary[];
  };
  visual?: { screenshotRef: ArtifactRef; viewport: Viewport; modalDetected: boolean; loadingDetected: boolean };
  auth: "unknown" | "anonymous" | "authenticated" | "expired";
  challenge?: ChallengeSummary;
  // runtime flags — IREL flags.* 의 원천
  flags: Record<string, boolean>;
  matchedWhere: Array<{ stepId: string; confidence: number; reason: string }>;
};

// ===== Exception =====
// [정책] 분류 결과는 4개로 고정. 미분류(unknown)는 타입에 두지 않고 분류 시점에 system으로 흡수
//   ("조용한 unknown" 전파 금지 — IREL/impl-bundle 원칙과 일관). 따라서 ClassifiedException.class는
//   항상 4개 중 하나다. error-catalog.ts의 ExceptionClass는 "none"을 포함하지만 그것은 "예외가 아닌
//   에러코드"(예: RUN_NOT_FOUND)의 메타 분류용으로 본 타입과 의미가 다르다(동일 이름, 다른 용도).
export type ExceptionClass = "business" | "system" | "challenge" | "security";
export type ClassifiedException = {
  class: ExceptionClass;
  code: string;            // error-catalog ErrorCode
  message: RedactedString;
  evidenceRefs?: ArtifactRef[];
};

// ===== Side effect =====
export type SideEffectKind = "read_only" | "login" | "submit" | "create" | "update" | "delete" | "upload";

// ===== StepResult =====
export type IRActionType = "act" | "observe" | "extract" | "navigate" | "download" | "upload" | "api_call" | "file" | "human_task" | "shell";

export type StepStatus =
  | "success" | "failed_business" | "failed_system" | "failed_challenge"
  | "failed_security" | "uncertain" | "skipped" | "suspended";

export type StepResult = {
  stepId: string;
  action: IRActionType;
  status: StepStatus;
  output?: unknown;
  extracted?: unknown;
  pageStateBefore: PageStateRef;
  pageStateAfter: PageStateRef;
  artifacts: ArtifactRef[];
  stagehandCallIds?: string[];
  cache: {
    mode: "hit" | "miss" | "bypass" | "suspect" | "stale" | "quarantined";
    actionPlanCacheId?: string;
  };
  sideEffect?: {
    kind: SideEffectKind;
    idempotencyKey?: string;
    receiptRef?: ArtifactRef;
    committed: boolean;
  };
  exception?: ClassifiedException;
  // [FIX] status='suspended'(human-assist 중단)인 step 의 challenge 종류 운반자. 인터프리터는 pageStateAfter(ref)만
  //   쥐고 있어 PageState.challenge 를 못 읽으므로, 감지한 executor 가 ChallengeSummary 를 step 출력에 echo 한다.
  //   이것이 challengeKind(captcha|mfa) → human_task kind → resolve.<kind> RBAC 의 유일한 상류 신호다(SuspendContext.challengeKind).
  challenge?: ChallengeSummary;
  timings: { startedAt: string; endedAt: string; durationMs: number };
};

// ===== VerifyResult =====
export type VerifyResult = {
  // status는 step.verify.failed 이벤트 payload와 verify.run span attr(status)에 그대로 실려
  // fail_det(결정형 검증 실패)와 fail_vlm(VLM 검증 실패)를 소비자/운영 UI가 구분한다.
  status: "pass" | "fail_det" | "fail_vlm" | "uncertain";
  confidence: number;
  failedCriteria: string[];
  evidenceRefs: ArtifactRef[];
  recommendation:
    | "continue" | "retry_same" | "self_heal"
    | "human_task" | "challenge_resolution" | "abort_security";
};

// ===== RunContext (Executor 입력) =====
export type RunContext = {
  runId: string;
  workitemId?: string;
  /** trace↔event↔log 상관키(§E correlation_id). driver 가 run.correlation_id 로 주입; 미주입 시 span 은 run_id 로 폴백. */
  correlationId?: string;
  tenantId: string;
  nodeId: string;
  attempt: number;
  pageState: PageState;
  siteProfileId: string;
  browserIdentityId: string;
  networkPolicyId: string;
  networkAllowedDomains?: readonly string[];
  leaseId: string;             // BrowserLease
  // 자격증명은 ref만. resolve는 SecretStore 경유(Executor가 직접 LLM에 전달 금지).
  assetRefs: Record<string, SecretRef | string>;
  abortSignal: AbortSignal;    // run abort → SSE close 전파
};

// ===== PageState 생산자 계약 =====
// [FIX] PageState는 page_state.resolve span·IREL flags.* 의 원천인데 생산자 계약이 없었다.
// Stagehand(act/observe/extract) 없이도 D3 골격에서 동작 가능(결정형 CDP 유틸리티 기반 resolver — Stagehand v3 CDP-native, Playwright 비의존).
export interface PageStateResolver {
  resolvePageState(ctx: RunContext): Promise<PageState>;
}

// ===== Executor 인터페이스 =====
export interface ExecutorPlugin {
  // [FIX] utility 추가: navigate/download/file/shell/api_call 등 결정형(비-LLM) 실행기 표현
  capabilities(): { dom: boolean; vision: boolean; utility: boolean };
  execute(stepId: string, action: unknown, ctx: RunContext): Promise<StepResult>;
  verify(criteria: unknown, ctx: RunContext): Promise<VerifyResult>;
}
