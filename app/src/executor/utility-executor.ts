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
  ExecutorPlugin,
  RunContext,
  StepResult,
  VerifyResult,
} from "../../../ts/core-types";
import type { CdpSessionProvider } from "./cdp-session";
import { pageStateRef } from "./page-state-resolver";

/** 본 실행기가 지원하는 결정형 액션(IRActionType 의 utility 부분집합). */
export type UtilityAction =
  | { type: "navigate"; url: string }
  | { type: "download"; trigger: { selector: string }; fileName: string; timeoutMs?: number }
  | { type: "upload"; selector: string; files: string | string[] };

/** 결정형 verify 기준(verify.schema.json 의 비-VLM 부분집합). */
export type DeterministicCriteria =
  | { type: "element_present"; selector: string }
  | { type: "min_rows"; selector: string; min: number };

export class UtilityExecutorError extends Error {
  constructor(
    readonly code: string,
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
        await session.goto(a.url);
        sideEffectKind = { kind: "read_only", committed: true };
        output = { url: session.url() };
        break;
      }
      case "download": {
        await session.sendCDP("Browser.setDownloadBehavior", {
          behavior: "allow",
          downloadPath: session.downloadDir(),
          eventsEnabled: true,
        });
        await session.click(a.trigger.selector);
        const captured = await session.waitForDownload(a.fileName, a.timeoutMs ?? 5000);
        if (!captured) {
          throw new UtilityExecutorError(
            "ARTIFACT_RETENTION_FAILED",
            `download '${a.fileName}' not captured within timeout (dir=${session.downloadDir()})`,
          );
        }
        sideEffectKind = { kind: "read_only", receiptRef: `${session.downloadDir()}/${a.fileName}`, committed: true };
        output = { fileName: a.fileName, dir: session.downloadDir() };
        break;
      }
      case "upload": {
        await session.setInputFiles(a.selector, a.files);
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
    } else {
      const count = await session.evaluate<number>(
        `document.querySelectorAll(${JSON.stringify(c.selector)}).length`,
      );
      pass = count >= c.min;
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
    if (type !== "navigate" && type !== "download" && type !== "upload") {
      throw new UtilityExecutorError("IR_SCHEMA_INVALID", `step '${stepId}' unknown action '${type}'`);
    }
    return action as UtilityAction;
  }

  private assertDeterministicCriteria(criteria: unknown): DeterministicCriteria {
    if (typeof criteria !== "object" || criteria === null || !("type" in criteria)) {
      throw new UtilityExecutorError("IR_SCHEMA_INVALID", "verify criteria missing 'type'");
    }
    const type = (criteria as { type: unknown }).type;
    if (type !== "element_present" && type !== "min_rows") {
      // VLM/스크린샷 기준 등은 vision 실행기 소관(후행, §9.1) — 조용히 통과시키지 않는다.
      throw new UtilityExecutorError(
        "EXECUTOR_CAPABILITY_MISMATCH",
        `verify criteria '${String(type)}' is not deterministic — requires the vision executor`,
      );
    }
    return criteria as DeterministicCriteria;
  }
}
