/**
 * UtilityExecutor — 결정형(비-LLM) 브라우저 실행기 (D3 — core-types.ts ExecutorPlugin / architecture.md §9.1).
 *
 * capability = {dom:false, vision:false, utility:true}. navigate/download/upload(결정형 CDP) 만 실행한다.
 * dom(act/observe/extract = Stagehand LLM)·vision(VLM)·비브라우저(api_call/file/shell) 는 본 실행기 소관이
 * 아니므로 **조용한 no-op 없이** 명시적으로 throw 한다(가정 금지 / "조용한 false 금지").
 *
 * verify 는 결정형 기준(element_present/min_rows)만 처리하고 VLM 의존 기준은 vision 실행기(후행, §9.1)로 위임 throw.
 */
import type {
  ArtifactRef,
  ExecutorPlugin,
  HttpResponseSnapshot,
  PageStateRef,
  RedactedString,
  RunContext,
  SecretRef,
  SideEffectKind,
  StepResult,
  VerifyResult,
} from "../../../ts/core-types";
import type { AuthenticatedPrincipal, RunId, SecretStoreBoundary } from "../../../ts/security-middleware-contract";
import type { CdpSessionProvider } from "./cdp-session";
import { pageStateRef } from "./page-state-resolver";
import { setDownloadBehavior } from "./raw-cdp";
import { UtilityExecutorError } from "./utility-executor-error";
import { assertDeterministicCriteria, assertUtilityAction } from "./utility-executor-assert";

// 도메인 에러는 utility-executor-error.ts(순환 import 회피 leaf) — 재export(기존 import 경로 호환).
export { UtilityExecutorError, type UtilityErrorCode } from "./utility-executor-error";

/** 본 실행기가 지원하는 결정형 액션(IRActionType 의 utility 부분집합). */
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export type HttpAuth =
  | { type: "none" }
  | { type: "secret_ref_bearer"; secretRef: SecretRef; connectorId?: string };
type HttpFetchResponse = {
  readonly status: number;
  readonly ok: boolean;
  readonly url?: string;
  readonly redirected?: boolean;
  readonly headers: { get(name: string): string | null };
  text(): Promise<string>;
};
type HttpFetch = (
  url: string,
  init: { method: HttpMethod; headers: Record<string, string>; body?: string; signal: AbortSignal; redirect: "manual" },
) => Promise<HttpFetchResponse>;

export interface UtilityHttpApiDeps {
  readonly fetch?: HttpFetch;
  readonly secrets?: SecretStoreBoundary;
  readonly principal?: AuthenticatedPrincipal;
  readonly defaultTimeoutMs?: number;
  readonly responseBodyLimitChars?: number;
}

export type UtilityAction =
  | { type: "navigate"; url: string }
  | {
      type: "api_call";
      method: HttpMethod;
      url: string;
      headers: Record<string, string>;
      body?: unknown;
      auth: HttpAuth;
      timeoutMs?: number;
      sideEffectKind?: SideEffectKind;
      idempotencyKey?: string;
    }
  | { type: "download"; trigger: { selector: string }; fileName: string; timeoutMs?: number }
  | { type: "upload"; selector: string; files: string | string[] };

/** 결정형 verify 기준(verify.schema.json 의 비-VLM 부분집합). */
export type DeterministicCriteria =
  | { type: "element_present"; selector: string }
  | { type: "element_visible"; target: { selector: string } }
  | { type: "element_absent"; target: { selector: string } }
  | { type: "text_includes"; texts: readonly string[] }
  | { type: "url_matches"; pattern: string }
  | { type: "min_rows"; selector: string; n: number }
  | { type: "http_status"; codes: readonly number[] };

const DEFAULT_HTTP_TIMEOUT_MS = 15_000;
const DEFAULT_HTTP_RESPONSE_BODY_LIMIT_CHARS = 65_536;

const nowIso = () => new Date().toISOString();

export class UtilityExecutor implements ExecutorPlugin {
  constructor(
    private readonly sessions: CdpSessionProvider,
    private readonly httpApi: UtilityHttpApiDeps = {},
  ) {}

  capabilities(): { dom: boolean; vision: boolean; utility: boolean } {
    return { dom: false, vision: false, utility: true };
  }

  async execute(stepId: string, action: unknown, ctx: RunContext): Promise<StepResult> {
    if (ctx.abortSignal.aborted) {
      // run abort → 실행 진입 차단(RunContext.abortSignal, CDP_DISCONNECTED 경로 상위 처리).
      throw new UtilityExecutorError("RUN_ABORTED", `step '${stepId}' aborted before execute`);
    }
    const a = assertUtilityAction(stepId, action);
    const policyFailure =
      a.type === "navigate" || a.type === "api_call"
        ? this.navigationPolicyFailure(stepId, a.url, ctx, a.type)
        : undefined;
    if (policyFailure !== undefined) return policyFailure;
    const before = pageStateRef(ctx.pageState);
    const startedAt = nowIso();

    let sideEffectKind: StepResult["sideEffect"];
    let output: unknown;

    switch (a.type) {
      case "navigate": {
        const session = this.sessions.forLease(ctx.leaseId);
        await this.withAbort(ctx, session.goto(a.url));
        // NPA-02: session.goto 는 서버측 30x 리다이렉트를 추종한다. security-contracts §6("allowed_domains 밖 이동 →
        //   차단")는 요청 URL 뿐 아니라 **착지 결과**에도 적용된다 — 착지 URL(session.url())을 정책에 재검증한다.
        //   미재검증 시 allowlist 내 호스트의 redirect 로 정책 밖(메타데이터/사내) 착지 후 후속 extract 가 그 콘텐츠를 유출.
        const landed = session.url();
        const landedFailure = this.navigationPolicyFailure(stepId, landed, ctx);
        if (landedFailure !== undefined) return landedFailure;
        sideEffectKind = { kind: "read_only", committed: true };
        output = { url: landed };
        break;
      }
      case "api_call": {
        const response = await this.executeHttpApiCall(a, ctx);
        const redirectTarget = response.redirectLocation ?? response.finalUrl;
        const responsePolicyFailure = this.navigationPolicyFailure(stepId, redirectTarget, ctx, a.type);
        if (responsePolicyFailure !== undefined) return responsePolicyFailure;
        sideEffectKind = {
          kind: a.sideEffectKind ?? (a.method === "GET" ? "read_only" : "update"),
          ...(a.idempotencyKey !== undefined ? { idempotencyKey: a.idempotencyKey } : {}),
          committed: true,
        };
        output = response;
        break;
      }
      case "download": {
        const session = this.sessions.forLease(ctx.leaseId);
        await this.withAbort(ctx, setDownloadBehavior(session, session.downloadDir())); // raw CDP 보완(§9.2 #5)
        await this.withAbort(ctx, session.click(a.trigger.selector));
        const captured = await this.withAbort(ctx, session.waitForDownload(a.fileName, a.timeoutMs ?? 5000));
        if (!captured) {
          throw new UtilityExecutorError(
            "ARTIFACT_RETENTION_FAILED",
            `download '${a.fileName}' not captured within timeout`,
          );
        }
        const receiptRef = `dryrun://${ctx.tenantId}/${ctx.runId}/${encodeURIComponent(a.fileName)}` as ArtifactRef;
        sideEffectKind = { kind: "read_only", receiptRef, committed: true };
        output = { fileName: a.fileName, receiptRef };
        break;
      }
      case "upload": {
        const session = this.sessions.forLease(ctx.leaseId);
        await this.withAbort(ctx, session.setInputFiles(a.selector, a.files));
        sideEffectKind = { kind: "upload", committed: true };
        output = { files: a.files };
        break;
      }
    }

    const endedAt = nowIso();
    return {
      stepId,
      action: a.type,
      status: "success",
      output,
      pageStateBefore: before,
      // PageState 재산출은 PageStateResolver 소관(관심사 분리). 여기선 동일 ref 유지 — 다음 observe 노드가 갱신.
      pageStateAfter: before,
      artifacts: [],
      cache: { mode: "bypass" }, // 결정형 action 은 ActionPlanCache 미사용(act 재생 전용).
      sideEffect: sideEffectKind,
      timings: { startedAt, endedAt, durationMs: Date.parse(endedAt) - Date.parse(startedAt) },
    };
  }

  async verify(criteria: unknown, ctx: RunContext): Promise<VerifyResult> {
    const c = assertDeterministicCriteria(criteria);
    let pass: boolean;
    if (c.type === "element_present") {
      const session = this.sessions.forLease(ctx.leaseId);
      pass = await session.evaluate<boolean>(
        `!!document.querySelector(${JSON.stringify(c.selector)})`,
      );
    } else if (c.type === "element_visible") {
      const session = this.sessions.forLease(ctx.leaseId);
      pass = await session.evaluate<boolean>(
        `!!document.querySelector(${JSON.stringify(c.target.selector)})`,
      );
    } else if (c.type === "element_absent") {
      // 결정형 부재: 셀렉터 미존재 → pass(비가역 커밋 witness·로딩완료 등). element_present/visible 의 역.
      const session = this.sessions.forLease(ctx.leaseId);
      pass = await session.evaluate<boolean>(
        `!document.querySelector(${JSON.stringify(c.target.selector)})`,
      );
    } else if (c.type === "text_includes") {
      // 결정형 텍스트 포함: 모든 texts 가 body.innerText 에 존재해야 pass(AND). body 부재면 빈 문자열.
      const session = this.sessions.forLease(ctx.leaseId);
      pass = await session.evaluate<boolean>(
        `(() => { const t = document.body ? document.body.innerText : ""; return ${JSON.stringify(c.texts)}.every((s) => t.includes(s)); })()`,
      );
    } else if (c.type === "url_matches") {
      // 결정형 URL 정규식: 현재 URL 이 pattern 에 매칭(Node 측 — session.url()). pattern 유효성은 parse 단계에서 검증.
      const session = this.sessions.forLease(ctx.leaseId);
      pass = new RegExp(c.pattern).test(session.url());
    } else if (c.type === "http_status") {
      if (ctx.lastHttpResponse === undefined) {
        throw new UtilityExecutorError("IR_SCHEMA_INVALID", "http_status verify requires a preceding api_call response");
      }
      pass = c.codes.includes(ctx.lastHttpResponse.status);
    } else {
      const session = this.sessions.forLease(ctx.leaseId);
      const count = await session.evaluate<number>(
        `document.querySelectorAll(${JSON.stringify(c.selector)}).length`,
      );
      pass = count >= c.n;
    }

    return {
      status: pass ? "pass" : "fail_det",
      confidence: 1,
      failedCriteria: pass ? [] : [c.type],
      evidenceRefs: [],
      recommendation: pass ? "continue" : "retry_same",
    };
  }

  // action/verify criteria 검증(assert*)은 utility-executor-assert.ts(의미 단위 분리, CLAUDE.md #7).

  private async executeHttpApiCall(
    action: Extract<UtilityAction, { type: "api_call" }>,
    ctx: RunContext,
  ): Promise<HttpResponseSnapshot> {
    const fetchImpl = this.httpApi.fetch;
    if (fetchImpl === undefined) {
      throw new UtilityExecutorError("EXECUTOR_CAPABILITY_MISMATCH", "api_call HTTP fetch dependency is not configured");
    }
    const headers: Record<string, string> = { ...action.headers };
    const secretsToRedact: string[] = [];
    if (action.auth.type === "secret_ref_bearer") {
      if (this.httpApi.secrets === undefined || this.httpApi.principal === undefined) {
        throw new UtilityExecutorError("EXECUTOR_CAPABILITY_MISMATCH", "api_call SecretRef bearer auth requires SecretStoreBoundary and principal");
      }
      const secret = await this.httpApi.secrets.resolveAuthorized({
        principal: this.httpApi.principal,
        ref: action.auth.secretRef,
        purpose: "connector",
        runId: ctx.runId as RunId,
        ...(action.auth.connectorId !== undefined ? { connectorId: action.auth.connectorId } : {}),
      });
      const plain = secret as string;
      secretsToRedact.push(plain);
      headers.Authorization = `Bearer ${plain}`;
    }

    const body = this.serializeHttpBody(action.body, headers);
    const timeoutMs = action.timeoutMs ?? this.httpApi.defaultTimeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
    const controller = new AbortController();
    const abort = () => controller.abort();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    ctx.abortSignal.addEventListener("abort", abort, { once: true });
    try {
      const response = await fetchImpl(action.url, { method: action.method, headers, ...(body !== undefined ? { body } : {}), signal: controller.signal, redirect: "manual" });
      const contentType = response.headers.get("content-type") ?? "";
      const finalUrl = typeof response.url === "string" && response.url.length > 0 ? response.url : action.url;
      const redirectLocation = redirectTarget(action.url, response.status, response.headers.get("location"));
      const rawText = redactSecrets(await response.text(), secretsToRedact);
      const limit = this.httpApi.responseBodyLimitChars ?? DEFAULT_HTTP_RESPONSE_BODY_LIMIT_CHARS;
      const bodyTruncated = rawText.length > limit;
      const limitedText = bodyTruncated ? rawText.slice(0, limit) : rawText;
      return {
        status: response.status,
        ok: response.ok,
        contentType,
        finalUrl,
        redirected: response.redirected === true || redirectLocation !== undefined || finalUrl !== action.url,
        ...(redirectLocation !== undefined ? { redirectLocation } : {}),
        ...(limitedText.length > 0 ? { body: parseHttpBody(contentType, limitedText) } : {}),
        bodyTruncated,
      };
    } finally {
      clearTimeout(timer);
      ctx.abortSignal.removeEventListener("abort", abort);
    }
  }

  private serializeHttpBody(body: unknown, headers: Record<string, string>): string | undefined {
    if (body === undefined) return undefined;
    if (typeof body === "string") return body;
    if (!hasHeader(headers, "content-type")) headers["Content-Type"] = "application/json";
    return JSON.stringify(body);
  }

  private navigationPolicyFailure(
    stepId: string,
    url: string,
    ctx: RunContext,
    action: "navigate" | "api_call" = "navigate",
  ): StepResult | undefined {
    const allowedDomains = ctx.networkAllowedDomains;
    if (allowedDomains === undefined) return undefined;
    const host = hostOf(url);
    if (host !== null && isHostAllowed(host, allowedDomains)) return undefined;

    const now = nowIso();
    const pageRef = pageStateRef(ctx.pageState) as PageStateRef;
    const message = `${action} host '${host ?? "invalid"}' is outside network policy '${ctx.networkPolicyId}'` as RedactedString;
    return {
      stepId,
      action,
      status: "failed_security",
      output: { url, allowed: false },
      pageStateBefore: pageRef,
      pageStateAfter: pageRef,
      artifacts: [],
      cache: { mode: "bypass" },
      sideEffect: { kind: "read_only", committed: false },
      exception: { class: "security", code: "DOMAIN_POLICY_VIOLATION", message },
      timings: { startedAt: now, endedAt: now, durationMs: 0 },
    };
  }

  private withAbort<T>(ctx: RunContext, work: Promise<T>): Promise<T> {
    if (ctx.abortSignal.aborted) {
      throw new UtilityExecutorError("RUN_ABORTED", `run '${ctx.runId}' aborted`);
    }
    return new Promise<T>((resolve, reject) => {
      const abort = () => reject(new UtilityExecutorError("RUN_ABORTED", `run '${ctx.runId}' aborted`));
      ctx.abortSignal.addEventListener("abort", abort, { once: true });
      work.then(resolve, reject).finally(() => ctx.abortSignal.removeEventListener("abort", abort));
    });
  }
}

function hasHeader(headers: Record<string, string>, wanted: string): boolean {
  const normalized = wanted.toLowerCase();
  return Object.keys(headers).some((name) => name.toLowerCase() === normalized);
}

function parseHttpBody(contentType: string, text: string): unknown {
  if (/\bjson\b/i.test(contentType)) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}

function redirectTarget(baseUrl: string, status: number, location: string | null): string | undefined {
  if (status < 300 || status > 399 || location === null || location.trim().length === 0) return undefined;
  try {
    return new URL(location, baseUrl).toString();
  } catch {
    return location;
  }
}

function redactSecrets(value: string, secrets: readonly string[]): string {
  return secrets.reduce((current, secret) => {
    if (secret.length === 0) return current;
    return current.split(secret).join("[REDACTED]");
  }, value);
}

function hostOf(value: string): string | null {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.hostname.toLowerCase();
  } catch {
    return null;
  }
}

function isHostAllowed(host: string, allowedDomains: readonly string[]): boolean {
  const normalizedHost = host.toLowerCase();
  return allowedDomains.some((raw) => {
    const domain = raw.trim().toLowerCase();
    if (domain.length === 0) return false;
    if (domain.startsWith("*.")) {
      const suffix = domain.slice(2);
      return normalizedHost.length > suffix.length && normalizedHost.endsWith(`.${suffix}`);
    }
    return normalizedHost === domain;
  });
}
