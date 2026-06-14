/**
 * D2 단위 테스트 — IR 흐름 제어 인터프리터(selectOnBranch / evaluateCondition).
 *
 * 외부 의존 없음(순수). 실행: `npm --prefix app run test:unit`.
 * 검증(ir.schema on / ir-expression §5 / "조용한 false 금지"):
 *  - priority 내림차순 첫 true 채택
 *  - 더 높은 priority가 우선
 *  - 무매칭 → NoBranchMatchedError(IR_NO_BRANCH_MATCHED)
 *  - scope missing → IRELRuntimeMissingError(IREL_RUNTIME_MISSING) 전파(조용한 false 아님)
 *  - 동률 priority(런타임 도달 시) → throw(은폐 금지)
 */
import {
  parseIrelExpression,
  IRELRuntimeMissingError,
  type IRELNode,
  type IRELScope,
} from "../../codegen/irel-compile";
import {
  selectOnBranch,
  NoBranchMatchedError,
  evaluateCondition,
  type CompiledOnBranch,
} from "../src/runtime/flow-control";

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  PASS  ${label}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

/** 테스트 보조: 식 문자열 → AST(컴파일 단계 대역). 런타임 경로는 캐시 AST를 받는다. */
function ast(expr: string): IRELNode {
  const parsed = parseIrelExpression(expr);
  if (!parsed.ok) throw new Error(`test setup: failed to parse '${expr}'`);
  return parsed.ast;
}

function branch<T>(expr: string, target: T, priority: number): CompiledOnBranch<T> {
  return { when: ast(expr), target, priority };
}

// observe_reviews 노드를 본뜬 분기: blocked > login_required > reviews_visible.
const branches: CompiledOnBranch<string>[] = [
  branch("flags.blocked", "challenge", 30),
  branch("flags.login_required", "login", 20),
  branch("flags.reviews_visible", "extract_reviews", 10),
];

// 1) 첫 true 채택(낮은 우선순위만 true)
check(
  "reviews_visible → extract_reviews",
  selectOnBranch("observe_reviews", branches, {
    flags: { blocked: false, login_required: false, reviews_visible: true },
  }) === "extract_reviews",
);

// 2) 더 높은 priority 우선(여러 true)
check(
  "blocked beats reviews_visible (priority)",
  selectOnBranch("observe_reviews", branches, {
    flags: { blocked: true, login_required: false, reviews_visible: true },
  }) === "challenge",
);

check(
  "login_required beats reviews_visible",
  selectOnBranch("observe_reviews", branches, {
    flags: { blocked: false, login_required: true, reviews_visible: true },
  }) === "login",
);

// 3) 무매칭 → IR_NO_BRANCH_MATCHED (조용한 false 아님)
try {
  selectOnBranch("observe_reviews", branches, {
    flags: { blocked: false, login_required: false, reviews_visible: false },
  });
  check("no-match throws", false, "expected NoBranchMatchedError");
} catch (err) {
  check(
    "no-match → IR_NO_BRANCH_MATCHED",
    err instanceof NoBranchMatchedError && err.code === "IR_NO_BRANCH_MATCHED",
    String(err),
  );
}

// 4) scope missing(flag 부재) → IREL_RUNTIME_MISSING 전파
try {
  selectOnBranch("observe_reviews", branches, { flags: { blocked: false } });
  check("missing-flag throws", false, "expected IRELRuntimeMissingError");
} catch (err) {
  check(
    "missing flag → IREL_RUNTIME_MISSING",
    err instanceof IRELRuntimeMissingError && err.code === "IREL_RUNTIME_MISSING",
    String(err),
  );
}

// 5) 동률 priority(런타임 도달) → 은폐 금지 throw
try {
  selectOnBranch(
    "dup",
    [branch("flags.blocked", "a", 10), branch("flags.reviews_visible", "b", 10)],
    { flags: { blocked: true, reviews_visible: true } },
  );
  check("duplicate priority throws", false, "expected duplicate-priority error");
} catch (err) {
  check("duplicate priority → throw", err instanceof Error && /duplicate on\[\] priority/.test(err.message), String(err));
}

// 6) evaluateCondition(loop.until 대역)
const scope: IRELScope = { flags: { no_next_page: true } };
check("evaluateCondition true", evaluateCondition(ast("flags.no_next_page"), scope) === true);
check("evaluateCondition false", evaluateCondition(ast("!flags.no_next_page"), scope) === false);

if (failures > 0) {
  console.error(`\nFAIL: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nPASS: D2 flow-control unit green");
