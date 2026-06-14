/**
 * 시나리오 컴파일 파이프라인 (D4.4 — architecture §10 / ir-static-validation.md / ir-expression §5).
 *
 * 저장(POST/PUT)·검증(validate)·승격(promote)이 호출한다. 단계(전부 codegen 재사용, 신설 금지):
 *  ① ajv 경계검증 `validateIR`(ir.schema.json + verify + params_schema as JSON Schema).
 *  ②③ `validateScenarioStatic`(IREL parse+typecheck via compileIrelExpression + IR 그래프 V1–V11) → ValidationReport{errors,warnings}.
 *
 * 거부 규약(api-surface §2):
 *  - 어느 단계든 errors → 저장/승격 거부. 코드: IREL 컴파일 오류 포함 시 `IR_EXPRESSION_COMPILE_ERROR`, 그 외 `IR_SCHEMA_INVALID`.
 *  - **prod 승격은 warnings도 차단**(ir-static-validation §3) — promote=true에서 warnings를 차단 집합에 포함.
 * 런타임 파싱 없음: 통과분의 컴파일 마커를 compiled_ast에 캐시한다(전 expression AST 직렬화는 codegen이 AST
 * 추출을 노출하지 않아 후속 작업 — validateScenarioStatic은 내부 컴파일만 수행하고 AST를 반환하지 않는다).
 */
import { validateScenarioStatic } from "../../../codegen/static-validation";
import type { IRScenario, ValidationIssue, ValidationReport } from "../../../codegen/types";
import { validateIR } from "../../../codegen/validators";

export type CompileErrorCode = "IR_SCHEMA_INVALID" | "IR_EXPRESSION_COMPILE_ERROR";

export type CompileOutcome =
  | { readonly ok: true; readonly ir: IRScenario; readonly report: ValidationReport; readonly compiledAst: string }
  | { readonly ok: false; readonly code: CompileErrorCode; readonly report?: ValidationReport; readonly details: unknown };

export interface CompileOptions {
  /** prod 승격 경로: warnings도 차단(ir-static-validation §3). 기본 false(저장은 errors만 차단). */
  readonly promote?: boolean;
  /** shell action cmd_ref 검증용 signed command registry(security-contracts §shell). */
  readonly signedCommandRefs?: readonly string[];
}

export function compileScenario(irDoc: unknown, options: CompileOptions = {}): CompileOutcome {
  // ① ajv 경계검증.
  const schema = validateIR(irDoc);
  if (!schema.valid) {
    return { ok: false, code: "IR_SCHEMA_INVALID", details: { stage: "schema", errors: schema.errors } };
  }
  const ir = irDoc as IRScenario;

  // ②③ IREL 컴파일 + V1–V11 그래프 검증.
  const report = validateScenarioStatic(ir, { signedCommandRefs: options.signedCommandRefs });

  // 차단 집합: 항상 errors. prod 승격이면 warnings도 차단(§3).
  const blocking: ValidationIssue[] = options.promote ? [...report.errors, ...report.warnings] : report.errors;
  if (blocking.length > 0) {
    const code: CompileErrorCode = blocking.some((i) => i.code === "IR_EXPRESSION_COMPILE_ERROR")
      ? "IR_EXPRESSION_COMPILE_ERROR"
      : "IR_SCHEMA_INVALID";
    return { ok: false, code, report, details: { stage: "static", report } };
  }

  // TODO: [BLOCKED]
  //   violated: ir-expression §5 / architecture §10 — compiled_ast는 런타임이 평가할 per-expression AST 캐시여야 한다(런타임 재파싱 금지).
  //   reason: codegen validateScenarioStatic은 내부에서 compileIrelExpression(ast 반환)을 호출하지만 ValidationReport만
  //     반환하고 expression 슬롯→AST 매핑을 노출하지 않아, 저장 경로가 직렬화할 실 AST를 얻을 수 없다.
  //   required_change: codegen이 validateScenarioStatic(또는 형제 export)에서 슬롯별 컴파일 AST를 반환 → 저장 경로가
  //     compiled_ast에 실 AST를 직렬화하고 flow-control.ts(D2 인터프리터)가 로드. 현재는 컴파일 통과 마커만 영속하며,
  //     인터프리터가 아직 compiled_ast를 로드하지 않으므로(미연결) 런타임 위반은 없다.
  const compiledAst = JSON.stringify({ irel_compiled: true, ir_version: ir.meta.version });
  return { ok: true, ir, report, compiledAst };
}
