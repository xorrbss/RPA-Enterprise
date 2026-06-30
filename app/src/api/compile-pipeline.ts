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
import type { IRScenario, StudioValidationStage, ValidationIssue, ValidationReport } from "../../../codegen/types";
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

export function studioValidationStagesFromCompile(outcome: CompileOutcome): readonly StudioValidationStage[] {
  const wellFormedPassed = outcome.ok || (outcome.report !== undefined && outcome.report.errors.length === 0);
  const wellFormed: StudioValidationStage = wellFormedPassed
    ? {
        stage: "well_formed",
        status: "pass",
        reason_code: "canonical_ir_compile_passed",
        detail: "Canonical IR schema and static compile gates passed.",
      }
    : {
        stage: "well_formed",
        status: "failed",
        reason_code: outcome.report === undefined ? "ir_schema_invalid" : "ir_static_validation_failed",
        detail: "Canonical IR schema or static compile gates failed.",
      };

  const runnable: StudioValidationStage = wellFormedPassed
    ? {
        stage: "runnable",
        status: "not_run",
        reason_code: "runtime_readiness_not_run",
        detail: "Target, identity, parameter, selector, and site readiness probes have not run.",
      }
    : {
        stage: "runnable",
        status: "blocked",
        reason_code: "canonical_ir_not_well_formed",
        detail: "Runtime readiness is blocked until canonical IR compile issues are fixed.",
      };

  const operable: StudioValidationStage = wellFormedPassed
    ? {
        stage: "operable",
        status: "not_run",
        reason_code: "ops_readiness_not_run",
        detail: "Worker, browser pool, credential, audit, and redaction readiness have not run.",
      }
    : {
        stage: "operable",
        status: "blocked",
        reason_code: "canonical_ir_not_well_formed",
        detail: "Operational readiness is blocked until canonical IR compile issues are fixed.",
      };

  const prodReady: StudioValidationStage = {
    stage: "prod_ready",
    status: wellFormedPassed ? "not_run" : "blocked",
    reason_code: wellFormedPassed ? "release_gate_not_run" : "canonical_ir_not_well_formed",
    detail: wellFormedPassed
      ? "Certification, maker-checker, alerting, backup, and controlled-production evidence have not run."
      : "Production readiness is blocked until canonical IR compile issues are fixed.",
  };

  return [wellFormed, runnable, operable, prodReady];
}
