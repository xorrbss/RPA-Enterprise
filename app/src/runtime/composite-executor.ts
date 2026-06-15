/**
 * CompositeExecutor — action.type 으로 dom/utility 실행기를 라우팅하는 ExecutorPlugin (D3 가동 3단계).
 *
 * 인터프리터는 단일 ExecutorPlugin 을 받아 노드의 what 액션마다 execute 를 호출한다(ir-interpreter.ts). dom 프리미티브
 * (act/observe/extract)와 utility 액션(navigate/download/upload)을 한 run 에서 섞으려면, 이 얇은 디스패처가 type 으로
 * 적합한 실행기에 위임한다. 디스패처 자체는 에러 처리/검증을 하지 않는다 — 각 실행기의 타입화된 throw/StepStatus 가
 * 그대로 인터프리터에 전파된다(조용한 흡수/오분류 금지). 알 수 없는 type 은 utility 로 보내 그쪽의 IR_SCHEMA_INVALID/
 * EXECUTOR_CAPABILITY_MISMATCH 로 표면화시킨다(디스패처가 별도 throw 를 두어 드리프트시키지 않음).
 */
import type { ExecutorPlugin, RunContext, StepResult, VerifyResult } from "../../../ts/core-types";

const DOM_ACTIONS = new Set(["act", "observe", "extract"]);

export class CompositeExecutor implements ExecutorPlugin {
  constructor(
    private readonly dom: ExecutorPlugin,
    private readonly utility: ExecutorPlugin,
  ) {}

  capabilities(): { dom: boolean; vision: boolean; utility: boolean } {
    const d = this.dom.capabilities();
    const u = this.utility.capabilities();
    return { dom: d.dom || u.dom, vision: d.vision || u.vision, utility: d.utility || u.utility };
  }

  execute(stepId: string, action: unknown, ctx: RunContext): Promise<StepResult> {
    const type = action !== null && typeof action === "object" ? (action as { type?: unknown }).type : undefined;
    if (typeof type === "string" && DOM_ACTIONS.has(type)) return this.dom.execute(stepId, action, ctx);
    // navigate/download/upload + 미지원/garbage type → utility(그쪽이 타입화된 throw 로 표면화).
    return this.utility.execute(stepId, action, ctx);
  }

  // verify 는 결정형 검증기(utility)에 위임 — VLM verify 는 vision 실행기(후속 증분)이며 1단계 미사용.
  verify(criteria: unknown, ctx: RunContext): Promise<VerifyResult> {
    return this.utility.verify(criteria, ctx);
  }
}
