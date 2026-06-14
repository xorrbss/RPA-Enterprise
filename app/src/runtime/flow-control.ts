/**
 * IR 흐름 제어 인터프리터 (D2 — architecture.md §10 Interpreter측).
 *
 * 책임: 컴파일된 `on[]` 분기 AST를 런타임 scope로 평가해 다음 target을 고른다.
 * 의존 방향(§10): Interpreter → codegen evaluator(단방향). 런타임 **파싱 없음** — 본 모듈은
 * 저장/승격 시 컴파일되어 `scenario_versions.compiled_ast`에 캐시된 AST만 평가한다.
 *
 * 계약(ir.schema.json `on`, ir-expression.md §5, error-catalog.ts):
 *  - `on[]`은 priority 내림차순 평가, 첫 true 채택. 동률 priority는 컴파일 거부(V6) — 런타임 유일.
 *  - 무매칭(모든 분기 false)은 **조용한 false가 아니라** IR_NO_BRANCH_MATCHED(System, retryable)로 표면화.
 *  - scope missing은 evaluator가 IRELRuntimeMissingError(IREL_RUNTIME_MISSING, System)로 throw —
 *    여기서 흡수하지 않고 전파한다("조용한 false/unknown 금지").
 */
import {
  evaluateIrelBooleanExpression,
  type IRELNode,
  type IRELScope,
} from "../../../codegen/irel-compile";

/** on[] 모든 분기가 false(무매칭). error-catalog IR_NO_BRANCH_MATCHED(system, retryable). */
export class NoBranchMatchedError extends Error {
  readonly code = "IR_NO_BRANCH_MATCHED";

  constructor(public readonly nodeId: string) {
    super(`IR_NO_BRANCH_MATCHED: node '${nodeId}' had no on[] branch evaluate true`);
    this.name = "NoBranchMatchedError";
  }
}

/** 컴파일된 on[] 분기 — when은 캐시된 AST(문자열 아님). */
export interface CompiledOnBranch<T> {
  readonly when: IRELNode;
  readonly target: T;
  readonly priority: number;
}

/**
 * on[] 분기를 priority 내림차순으로 평가해 첫 true 분기의 target을 반환한다.
 *
 * - 무매칭 → throw NoBranchMatchedError(IR_NO_BRANCH_MATCHED).
 * - scope missing/타입 위반 → evaluator의 IRELRuntimeMissingError 전파(IREL_RUNTIME_MISSING).
 * - 동률 priority는 컴파일 단계(V6)에서 차단되므로 런타임에서 가정한다 — 발견 시 즉시 throw(은폐 금지).
 */
export function selectOnBranch<T>(
  nodeId: string,
  branches: readonly CompiledOnBranch<T>[],
  scope: IRELScope,
): T {
  const ordered = [...branches].sort((a, b) => b.priority - a.priority);
  for (let i = 1; i < ordered.length; i += 1) {
    if (ordered[i].priority === ordered[i - 1].priority) {
      // V6가 막아야 할 동률이 런타임까지 온 경우 — 비결정 선택을 조용히 하지 않는다.
      throw new Error(
        `selectOnBranch: node '${nodeId}' has duplicate on[] priority ${ordered[i].priority} (V6 should reject at compile)`,
      );
    }
  }
  for (const branch of ordered) {
    if (evaluateIrelBooleanExpression(branch.when, scope)) {
      return branch.target;
    }
  }
  throw new NoBranchMatchedError(nodeId);
}

/**
 * loop.until / fallback_chain.advance_when 등 단일 불린 조건 평가(컴파일 AST).
 * scope missing은 IRELRuntimeMissingError로 전파(조용한 false 금지).
 */
export function evaluateCondition(condition: IRELNode, scope: IRELScope): boolean {
  return evaluateIrelBooleanExpression(condition, scope);
}
