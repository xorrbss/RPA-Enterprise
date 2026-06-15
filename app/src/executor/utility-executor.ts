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
  RunContext,
  StepResult,
  VerifyResult,
} from "../../../ts/core-types";
import type { CdpSessionProvider } from "./cdp-session";
import { pageStateRef } from "./page-state-resolver";
import { setDownloadBehavior } from "./raw-cdp";

/** 본 실행기가 지원하는 결정형 액션(IRActionType 의 utility 부분집합). */
export type UtilityAction =
  | { type: "navigate"; url: string }
  | { type: "download"; trigger: { selector: string }; fileName: string; timeoutMs?: number }
  | { type: "upload"; selector: string; files: string | string[] };

/** 결정형 verify 기준(verify.schema.json 의 비-VLM 부분집합). */
export type DeterministicCriteria =
  | { type: "element_present"; selector: string }
  | { type: "element_visible"; target: { selector: string } }
  | { type: "min_rows"; selector: string; n: number };

/**
 * UtilityExecutor 도메인 에러코드 — error-catalog.ts 의 `ErrorCode` 와 **별개 네임스페이스**다.
 * (PageStateResolverError 와 동일 패턴.) 런타임 예외 분류기가 이 코드를 ExceptionClass 로 매핑하며,
 * `ERROR_CATALOG[code]` 로 직접 인덱싱하지 않는다. 타입을 좁혀 카탈로그 오인덱싱을 컴파일 단계에서 차단한다
 * (bare `string` 이면 `EXECUTOR_CAPABILITY_MISMATCH` 등이 ERROR_CATALOG[undefined] 크래시로 새는 것을 막지 못함).
 */
export type UtilityErrorCode =
  | "IR_SCHEMA_INVALID"
  | "EXECUTOR_CAPABILITY_MISMATCH"
  | "ARTIFACT_RETENTION_FAILED"
  | "RUN_ABORTED";

export class UtilityExecutorError extends Error {
  constructor(
    readonly code: UtilityErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "UtilityExecutorError";
  }
}

const DOM_ACTIONS = new Set(["act", "observe", "extract"]);
const NON_BROWSER_ACTIONS = new Set(["api_call", "file", "shell"]);

const nowIso = () => new Date().toISOString();

export class UtilityExecutor implements ExecutorPlugin {
  constructor(private readonly sessions: CdpSessionProvider) {}

  capabilities(): { dom: boolean; vision: boolean; utility: boolean } {
    return { dom: false, vision: false, utility: true };
  }

  async execute(stepId: string, action: unknown, ctx: RunContext): Promise<StepResult> {
    if (ctx.abortSignal.aborted) {
      // run abort → 실행 진입 차단(RunContext.abortSignal, CDP_DISCONNECTED 경로 상위 처리).
      throw new UtilityExecutorError("RUN_ABORTED", `step '${stepId}' aborted before execute`);
    }
    const a = this.assertUtilityAction(stepId, action);
    const session = this.sessions.forLease(ctx.leaseId);
    const before = pageStateRef(ctx.pageState);
    const startedAt = nowIso();

    let sideEffectKind: StepResult["sideEffect"];
    let output: unknown;

    switch (a.type) {
      case "navigate": {
        await this.withAbort(ctx, session.goto(a.url));
        sideEffectKind = { kind: "read_only", committed: true };
        output = { url: session.url() };
        break;
      }
      case "download": {
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
    const c = this.assertDeterministicCriteria(criteria);
    const session = this.sessions.forLease(ctx.leaseId);

    let pass: boolean;
    if (c.type === "element_present") {
      pass = await session.evaluate<boolean>(
        `!!document.querySelector(${JSON.stringify(c.selector)})`,
      );
    } else if (c.type === "element_visible") {
      pass = await session.evaluate<boolean>(
        `!!document.querySelector(${JSON.stringify(c.target.selector)})`,
      );
    } else {
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

  private assertUtilityAction(stepId: string, action: unknown): UtilityAction {
    if (typeof action !== "object" || action === null || !("type" in action)) {
      throw new UtilityExecutorError("IR_SCHEMA_INVALID", `step '${stepId}' action missing 'type'`);
    }
    const type = (action as { type: unknown }).type;
    if (typeof type !== "string") {
      throw new UtilityExecutorError("IR_SCHEMA_INVALID", `step '${stepId}' action.type not a string`);
    }
    if (DOM_ACTIONS.has(type)) {
      throw new UtilityExecutorError(
        "EXECUTOR_CAPABILITY_MISMATCH",
        `step '${stepId}' action '${type}' requires the dom executor (Stagehand act/observe/extract) — not utility`,
      );
    }
    if (NON_BROWSER_ACTIONS.has(type)) {
      throw new UtilityExecutorError(
        "EXECUTOR_CAPABILITY_MISMATCH",
        `step '${stepId}' action '${type}' is non-browser utility — handled by a separate module (architecture §9.1)`,
      );
    }
    if (type === "navigate") {
      const url = nonEmptyString((action as { url?: unknown }).url);
      if (url === undefined) {
        throw new UtilityExecutorError("IR_SCHEMA_INVALID", `step '${stepId}' navigate.url must be a non-empty string`);
      }
      try {
        new URL(url);
      } catch {
        throw new UtilityExecutorError("IR_SCHEMA_INVALID", `step '${stepId}' navigate.url must be an absolute URL`);
      }
      return { type, url };
    }
    if (type === "download") {
      const trigger = (action as { trigger?: unknown }).trigger;
      const selector = typeof trigger === "object" && trigger !== null
        ? nonEmptyString((trigger as { selector?: unknown }).selector)
        : undefined;
      const fileName = nonEmptyString((action as { fileName?: unknown }).fileName);
      const timeoutMs = (action as { timeoutMs?: unknown }).timeoutMs;
      if (selector === undefined) {
        throw new UtilityExecutorError("IR_SCHEMA_INVALID", `step '${stepId}' download.trigger.selector must be a non-empty string`);
      }
      if (fileName === undefined || /[\\/]/.test(fileName)) {
        throw new UtilityExecutorError("IR_SCHEMA_INVALID", `step '${stepId}' download.fileName must be a file name, not a path`);
      }
      if (timeoutMs !== undefined && (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs <= 0)) {
        throw new UtilityExecutorError("IR_SCHEMA_INVALID", `step '${stepId}' download.timeoutMs must be a positive integer`);
      }
      return { type, trigger: { selector }, fileName, timeoutMs };
    }
    if (type === "upload") {
      const selector = nonEmptyString((action as { selector?: unknown }).selector);
      const files = (action as { files?: unknown }).files;
      const validFiles = typeof files === "string"
        ? nonEmptyString(files)
        : Array.isArray(files) && files.length > 0 && files.every((f) => nonEmptyString(f) !== undefined)
          ? files
          : undefined;
      if (selector === undefined) {
        throw new UtilityExecutorError("IR_SCHEMA_INVALID", `step '${stepId}' upload.selector must be a non-empty string`);
      }
      if (validFiles === undefined) {
        throw new UtilityExecutorError("IR_SCHEMA_INVALID", `step '${stepId}' upload.files must be a non-empty string or string array`);
      }
      return { type, selector, files: validFiles };
    }
    throw new UtilityExecutorError("IR_SCHEMA_INVALID", `step '${stepId}' unknown action '${type}'`);
  }

  private assertDeterministicCriteria(criteria: unknown): DeterministicCriteria {
    if (typeof criteria !== "object" || criteria === null || !("type" in criteria)) {
      throw new UtilityExecutorError("IR_SCHEMA_INVALID", "verify criteria missing 'type'");
    }
    const type = (criteria as { type: unknown }).type;
    if (type === "element_present") {
      const selector = nonEmptyString((criteria as { selector?: unknown }).selector);
      if (selector === undefined) {
        throw new UtilityExecutorError("IR_SCHEMA_INVALID", "element_present.selector must be a non-empty string");
      }
      return { type, selector };
    }
    if (type === "element_visible") {
      const target = (criteria as { target?: unknown }).target;
      const selector = typeof target === "object" && target !== null
        ? nonEmptyString((target as { selector?: unknown }).selector)
        : undefined;
      if (selector === undefined) {
        throw new UtilityExecutorError("IR_SCHEMA_INVALID", "element_visible.target.selector must be a non-empty string");
      }
      return { type, target: { selector } };
    }
    if (type === "min_rows") {
      const selector = nonEmptyString((criteria as { selector?: unknown }).selector);
      const n = (criteria as { n?: unknown }).n;
      if (selector === undefined) {
        throw new UtilityExecutorError("IR_SCHEMA_INVALID", "min_rows.selector must be a non-empty string");
      }
      if (!Number.isInteger(n) || (n as number) < 1) {
        throw new UtilityExecutorError("IR_SCHEMA_INVALID", "min_rows.n must be an integer >= 1");
      }
      return { type, selector, n: n as number };
    }
    {
      // VLM/스크린샷 기준 등은 vision 실행기 소관(후행, §9.1) — 조용히 통과시키지 않는다.
      throw new UtilityExecutorError(
        "EXECUTOR_CAPABILITY_MISMATCH",
        `verify criteria '${String(type)}' is not deterministic — requires the vision executor`,
      );
    }
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

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
