/**
 * Unit coverage for PbD click-only 승격 transform (scenario-promotion.ts, ③ 슬라이스1).
 *
 * 초점: click ActionPlan → act.args.click_selector 베이킹(결정형, LLM 미경유), fill/select 및 비-act 는 skipped 명시,
 * 입력 IR 불변(깊은 복제). 실행: npm --prefix app exec -- tsx app/test/scenario-promotion.unit.ts
 */
import type { ActionPlan } from "../src/executor/action-plan-cache";
import { promoteActsToDeterministic } from "../src/api/scenario-promotion";

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function actNode(instruction: string, extraArgs?: Record<string, unknown>): Record<string, unknown> {
  return {
    what: [{ action: "act", instruction, ...(extraArgs ? { args: extraArgs } : {}) }],
    next: "done",
    side_effect: { kind: "read_only" },
  };
}

function baseIr(nodes: Record<string, unknown>): Record<string, unknown> {
  return { meta: { name: "t", version: 1 }, start: "n1", nodes: { ...nodes, done: { terminal: "success" } } };
}

function argsOf(result: { ir: Record<string, unknown> }, nodeId: string): Record<string, unknown> | undefined {
  const nodes = result.ir.nodes as Record<string, Record<string, unknown>>;
  const what = nodes[nodeId].what as Array<Record<string, unknown>>;
  return what[0].args as Record<string, unknown> | undefined;
}

function clickSelectorOf(result: { ir: Record<string, unknown> }, nodeId: string): unknown {
  return argsOf(result, nodeId)?.click_selector;
}

function fillSelectorOf(result: { ir: Record<string, unknown> }, nodeId: string): unknown {
  return argsOf(result, nodeId)?.fill_selector;
}

function main(): void {
  // 1. click plan → click_selector 베이킹 + promotedNodeIds.
  {
    const ir = baseIr({ n1: actNode("click submit") });
    const plans: Record<string, ActionPlan> = { n1: { operation: "click", selector: "#submit" } };
    const r = promoteActsToDeterministic(ir, plans);
    check("click plan bakes act.args.click_selector", clickSelectorOf(r, "n1") === "#submit", JSON.stringify(r.ir));
    check("click plan records promotedNodeIds", r.promotedNodeIds.length === 1 && r.promotedNodeIds[0] === "n1");
    check("click plan no skips", r.skipped.length === 0, JSON.stringify(r.skipped));
    check("click plan preserves instruction", ((r.ir.nodes as Record<string, Record<string, unknown>>).n1.what as Array<Record<string, unknown>>)[0].instruction === "click submit");
  }

  // 2. input IR not mutated (deep clone).
  {
    const ir = baseIr({ n1: actNode("click submit") });
    promoteActsToDeterministic(ir, { n1: { operation: "click", selector: "#submit" } });
    const origArgs = ((ir.nodes as Record<string, Record<string, unknown>>).n1.what as Array<Record<string, unknown>>)[0].args;
    check("input IR not mutated", origArgs === undefined, JSON.stringify(ir));
  }

  // 3. fill plan + 값 출처(args.value_ref) → fill_selector 베이킹 + promoted(slice 2b). 값 출처 보존.
  {
    const ir = baseIr({ n1: actNode("사유 입력", { value_ref: "reason" }) });
    const r = promoteActsToDeterministic(ir, { n1: { operation: "fill", selector: "textarea#reason", valueRef: "reason" } });
    check("fill plan(value_ref) bakes act.args.fill_selector", fillSelectorOf(r, "n1") === "textarea#reason" && r.promotedNodeIds[0] === "n1");
    check("fill plan(value_ref) preserves value_ref(값 출처)", argsOf(r, "n1")?.value_ref === "reason");
    check("fill plan(value_ref) no skips", r.skipped.length === 0, JSON.stringify(r.skipped));
  }

  // 3b. fill plan + 값 출처(vars[secret]) → fill_selector 베이킹.
  {
    const node = { what: [{ action: "act", instruction: "비밀번호 입력", vars: ["login.password"] }], next: "done", side_effect: { kind: "read_only" } };
    const r = promoteActsToDeterministic(baseIr({ n1: node }), { n1: { operation: "fill", selector: "input#pw", valueRef: "login.password" } });
    check("fill plan(secret vars) bakes act.args.fill_selector", fillSelectorOf(r, "n1") === "input#pw" && r.promotedNodeIds[0] === "n1", JSON.stringify(r));
  }

  // 3c. fill plan 인데 값 출처 없음(LLM 리터럴 value) → skipped(fill_selector 는 값 출처 필수).
  {
    const ir = baseIr({ n1: actNode("fill name") });
    const r = promoteActsToDeterministic(ir, { n1: { operation: "fill", selector: "#name", value: "Alice" } });
    check("fill plan(값 출처 없음) not promoted", r.promotedNodeIds.length === 0 && fillSelectorOf(r, "n1") === undefined);
    check("fill plan(값 출처 없음) skipped fill_no_value_source", r.skipped.length === 1 && r.skipped[0].reason === "fill_no_value_source", JSON.stringify(r.skipped));
  }

  // 4. select plan → skipped(결정형 셀렉터 arg 부재).
  {
    const ir = baseIr({ n1: actNode("select option") });
    const r = promoteActsToDeterministic(ir, { n1: { operation: "select", selector: "#sel", value: "v" } });
    check("select plan skipped", r.promotedNodeIds.length === 0 && r.skipped[0]?.reason === "select_not_deterministic", JSON.stringify(r.skipped));
  }

  // 5. captured plan for unknown node → node_not_found.
  {
    const ir = baseIr({ n1: actNode("click x") });
    const r = promoteActsToDeterministic(ir, { ghost: { operation: "click", selector: "#x" } });
    check("unknown node → node_not_found", r.skipped.length === 1 && r.skipped[0].reason === "node_not_found");
  }

  // 6. act already deterministic(click_selector) → no_promotable_act.
  {
    const ir = baseIr({ n1: actNode("click x", { click_selector: "#existing" }) });
    const r = promoteActsToDeterministic(ir, { n1: { operation: "click", selector: "#new" } });
    check("already-deterministic act not re-promoted", r.promotedNodeIds.length === 0 && r.skipped[0]?.reason === "no_promotable_act");
    check("already-deterministic act keeps original selector", clickSelectorOf(r, "n1") === "#existing");
  }

  // 7. non-act node(observe) with plan → no_promotable_act.
  {
    const ir = baseIr({ n1: { what: [{ action: "observe", instruction: "look" }], next: "done", side_effect: { kind: "read_only" } } });
    const r = promoteActsToDeterministic(ir, { n1: { operation: "click", selector: "#x" } });
    check("observe node → no_promotable_act", r.promotedNodeIds.length === 0 && r.skipped[0]?.reason === "no_promotable_act");
  }

  // 8. multiple act nodes → each promoted independently.
  {
    const ir = baseIr({ n1: actNode("click a"), n2: actNode("click b") });
    const r = promoteActsToDeterministic(ir, {
      n1: { operation: "click", selector: "#a" },
      n2: { operation: "click", selector: "#b" },
    });
    check("multiple act nodes each promoted", r.promotedNodeIds.length === 2 && clickSelectorOf(r, "n1") === "#a" && clickSelectorOf(r, "n2") === "#b");
  }

  // 9. node without what → node_what_missing.
  {
    const ir = baseIr({ n1: { next: "done", side_effect: { kind: "read_only" } } });
    const r = promoteActsToDeterministic(ir, { n1: { operation: "click", selector: "#x" } });
    check("node without what → node_what_missing", r.skipped[0]?.reason === "node_what_missing");
  }

  if (failures > 0) {
    console.error(`\nFAIL: scenario-promotion.unit (${failures})`);
    process.exit(1);
  }
  console.log("\nPASS: scenario-promotion.unit");
}

main();
