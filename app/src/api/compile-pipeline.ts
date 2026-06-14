/**
 * Scenario compile pipeline (D4.4 / architecture section 10).
 *
 * Save, validate, and promote paths reuse codegen only:
 * 1. AJV boundary validation with validateIR.
 * 2. IREL parse/typecheck plus IR static validation V1-V11.
 * 3. Per-expression compiled AST export for scenario_versions.compiled_ast.
 *
 * No runtime parsing is introduced here. Any schema/static error rejects save
 * or promote; promote also blocks warnings per ir-static-validation section 3.
 */
import { compileScenarioStatic } from "../../../codegen/static-validation";
import type { IRScenario, ValidationIssue, ValidationReport } from "../../../codegen/types";
import { validateIR } from "../../../codegen/validators";

export type CompileErrorCode = "IR_SCHEMA_INVALID" | "IR_EXPRESSION_COMPILE_ERROR";

export type CompileOutcome =
  | { readonly ok: true; readonly ir: IRScenario; readonly report: ValidationReport; readonly compiledAst: string }
  | { readonly ok: false; readonly code: CompileErrorCode; readonly report?: ValidationReport; readonly details: unknown };

export interface CompileOptions {
  /** Promote path: warnings block prod promotion. Draft save blocks errors only. */
  readonly promote?: boolean;
  /** Signed command registry keys for shell action cmd_ref validation. */
  readonly signedCommandRefs?: readonly string[];
}

export function compileScenario(irDoc: unknown, options: CompileOptions = {}): CompileOutcome {
  const schema = validateIR(irDoc);
  if (!schema.valid) {
    return { ok: false, code: "IR_SCHEMA_INVALID", details: { stage: "schema", errors: schema.errors } };
  }
  const ir = irDoc as IRScenario;

  const staticResult = compileScenarioStatic(ir, { signedCommandRefs: options.signedCommandRefs });
  const report = staticResult.report;

  const blocking: ValidationIssue[] = options.promote ? [...report.errors, ...report.warnings] : report.errors;
  if (blocking.length > 0) {
    const code: CompileErrorCode = blocking.some((issue) => issue.code === "IR_EXPRESSION_COMPILE_ERROR")
      ? "IR_EXPRESSION_COMPILE_ERROR"
      : "IR_SCHEMA_INVALID";
    return { ok: false, code, report, details: { stage: "static", report } };
  }

  if (staticResult.compiledAst === undefined) {
    return { ok: false, code: "IR_SCHEMA_INVALID", report, details: { stage: "static", reason: "compiled_ast_missing" } };
  }

  return { ok: true, ir, report, compiledAst: JSON.stringify(staticResult.compiledAst) };
}
