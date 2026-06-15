/**
 * no-secret-taint — build-blocking secret taint ESLint rule.
 *
 * Contract: ts/core-types.ts (brand 타입 + "brand + lint 강제"), security-contracts.md §4,
 * build-prompt.md §4 ("보안: secret taint lint가 빌드 차단"). The brand
 * `PlainSecret = string & { __brand: "PlainSecret_DoNotLog" }` marks resolved plaintext
 * that must never reach a log / serialization sink. This rule statically BLOCKS a
 * PlainSecret-typed value from being passed directly (or as a direct object-literal
 * property) into a denylisted sink, unless it first goes through an approved redaction
 * boundary (redactPlainSecret / safeSerialize — security-middleware-contract.ts).
 *
 * Scope (KISS, decidable via the type-checker): the brand is erased by any string
 * operation (concatenation / template literal widen to plain `string`), so laundering
 * is not statically detectable and is out of scope; the contract requirement is
 * "직접 전달 금지" (no DIRECT passing), which IS decidable from the static type. This
 * catches the primary leak vector (logs/JSON serialization). Event/artifact sinks are
 * additionally guarded at runtime (assertNoPlainSecret / safeSerialize boundary) and
 * can be added here via the `sinks`/`sinkMethods` options.
 */
import { ESLintUtils } from "@typescript-eslint/utils";

const PLAIN_SECRET_BRAND = "PlainSecret_DoNotLog";

// Default denylisted sink methods (member calls: console.*, logger.*, this.log.*, ...).
const DEFAULT_SINK_METHODS = ["log", "info", "warn", "error", "debug", "trace", "dir", "table"];
// Approved redaction boundary — passing a PlainSecret THROUGH these is allowed.
const APPROVED_BOUNDARY = new Set(["redactPlainSecret", "safeSerialize"]);

function getOption(options, key, fallback) {
  const v = options && options[0] ? options[0][key] : undefined;
  return Array.isArray(v) ? v : fallback;
}

/** True if `type` (or any union/intersection constituent) carries the PlainSecret brand. */
function typeHasPlainSecretBrand(checker, type, tsNode) {
  if (!type) return false;
  if (type.isUnion && type.isUnion()) {
    return type.types.some((t) => typeHasPlainSecretBrand(checker, t, tsNode));
  }
  // Intersection: the brand property is visible on the combined type via getProperty,
  // but also recurse into members for robustness.
  const sym = type.getProperty ? type.getProperty("__brand") : undefined;
  if (sym) {
    let brandType;
    try {
      brandType = checker.getTypeOfSymbolAtLocation(sym, tsNode);
    } catch {
      brandType = undefined;
    }
    if (brandType && brandType.isStringLiteral && brandType.isStringLiteral() && brandType.value === PLAIN_SECRET_BRAND) {
      return true;
    }
  }
  if (type.isIntersection && type.isIntersection()) {
    return type.types.some((t) => typeHasPlainSecretBrand(checker, t, tsNode));
  }
  return false;
}

/** Resolve the called sink name for denylist matching. Returns {kind, name} or null. */
function classifyCallee(callee, sinkMethods, sinkFns) {
  if (callee.type === "MemberExpression" && !callee.computed && callee.property.type === "Identifier") {
    const method = callee.property.name;
    // JSON.stringify is a serialization sink.
    if (
      method === "stringify" &&
      callee.object.type === "Identifier" &&
      callee.object.name === "JSON"
    ) {
      return { kind: "method", name: "JSON.stringify" };
    }
    if (sinkMethods.includes(method)) return { kind: "method", name: method };
  }
  if (callee.type === "Identifier" && sinkFns.includes(callee.name)) {
    return { kind: "fn", name: callee.name };
  }
  return null;
}

/** Arguments that are an approved-boundary call are pre-redacted → skip. */
function isApprovedBoundaryCall(arg) {
  if (arg.type !== "CallExpression") return false;
  const c = arg.callee;
  if (c.type === "Identifier") return APPROVED_BOUNDARY.has(c.name);
  if (c.type === "MemberExpression" && !c.computed && c.property.type === "Identifier") {
    return APPROVED_BOUNDARY.has(c.property.name);
  }
  return false;
}

export const noSecretTaintRule = ESLintUtils.RuleCreator.withoutDocs({
  meta: {
    type: "problem",
    docs: {
      description:
        "Block PlainSecret-branded values from reaching log/serialization sinks without going through an approved redaction boundary.",
    },
    schema: [
      {
        type: "object",
        additionalProperties: false,
        properties: {
          sinkMethods: { type: "array", items: { type: "string" } },
          sinks: { type: "array", items: { type: "string" } },
        },
      },
    ],
    messages: {
      taintedSink:
        "PlainSecret(plaintext secret)를 '{{sink}}'에 직접 전달할 수 없습니다. SecretStore.resolve 결과는 taint 추적 대상입니다 — redactPlainSecret/safeSerialize 경계를 거치세요(security-contracts §4, core-types brand).",
    },
  },
  defaultOptions: [{}],
  create(context) {
    const services = ESLintUtils.getParserServices(context);
    const checker = services.program.getTypeChecker();
    const sinkMethods = getOption(context.options, "sinkMethods", DEFAULT_SINK_METHODS);
    const sinkFns = getOption(context.options, "sinks", []);

    function checkExprIsTainted(node) {
      const tsNode = services.esTreeNodeToTSNodeMap.get(node);
      if (!tsNode) return false;
      const type = services.getTypeAtLocation(node);
      return typeHasPlainSecretBrand(checker, type, tsNode);
    }

    function reportIfTainted(node, sinkName) {
      if (isApprovedBoundaryCall(node)) return;
      if (node.type === "ObjectExpression") {
        // direct object-literal property values
        for (const prop of node.properties) {
          if (prop.type === "Property" && !isApprovedBoundaryCall(prop.value) && checkExprIsTainted(prop.value)) {
            context.report({ node: prop.value, messageId: "taintedSink", data: { sink: sinkName } });
          }
        }
        return;
      }
      if (checkExprIsTainted(node)) {
        context.report({ node, messageId: "taintedSink", data: { sink: sinkName } });
      }
    }

    return {
      CallExpression(node) {
        const sink = classifyCallee(node.callee, sinkMethods, sinkFns);
        if (!sink) return;
        for (const arg of node.arguments) {
          if (arg.type === "SpreadElement") {
            reportIfTainted(arg.argument, sink.name);
          } else {
            reportIfTainted(arg, sink.name);
          }
        }
      },
    };
  },
});

export default { rules: { "no-secret-taint": noSecretTaintRule } };
