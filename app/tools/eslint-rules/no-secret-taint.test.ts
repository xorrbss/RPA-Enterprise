/**
 * Unit test (RuleTester) for the no-secret-taint rule. Run via tsx (app test:unit/test:lint).
 * Type-aware: each case declares the brand inline so the rule's type-checker path is exercised.
 */
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { RuleTester } from "@typescript-eslint/rule-tester";
import { noSecretTaintRule } from "./no-secret-taint.mjs";

// Drive RuleTester from a plain tsx script (no vitest/jest): shim the test hooks so
// .run() executes synchronously and throws on assertion failure.
RuleTester.afterAll = () => {};
RuleTester.describe = ((_name: string, fn: () => void) => fn()) as typeof RuleTester.describe;
RuleTester.it = ((_name: string, fn: () => void) => fn()) as typeof RuleTester.it;
RuleTester.itOnly = ((_name: string, fn: () => void) => fn()) as typeof RuleTester.itOnly;

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

const ruleTester = new RuleTester({
  languageOptions: {
    parserOptions: {
      projectService: {
        allowDefaultProject: ["*.ts"],
        defaultProject: "tsconfig.json",
      },
      tsconfigRootDir: fixturesDir,
    },
  },
});

// Brand + boundary preamble shared by cases (typeof keeps it terse).
const SECRET = `type PlainSecret = string & { readonly __brand: "PlainSecret_DoNotLog" };`;
const REF = `type SecretRef = string & { readonly __brand: "SecretRef" };`;
const BOUNDARY = `declare function redactPlainSecret(s: PlainSecret): string; declare function safeSerialize(v: unknown): string;`;
const LOGGER = `declare const logger: { info(...a: unknown[]): void; error(...a: unknown[]): void };`;

ruleTester.run("no-secret-taint", noSecretTaintRule, {
  valid: [
    // plain string to a sink — fine
    { code: `console.log("hello", 42);` },
    // SecretRef (a reference, not plaintext) is allowed in logs
    { code: `${REF}\ndeclare const r: SecretRef;\nconsole.log(r);` },
    // PlainSecret through the approved redaction boundary — allowed
    { code: `${SECRET}\n${BOUNDARY}\ndeclare const p: PlainSecret;\nconsole.log(redactPlainSecret(p));` },
    { code: `${SECRET}\n${BOUNDARY}\ndeclare const p: PlainSecret;\nconsole.error(safeSerialize({ p }));` },
    // PlainSecret passed to a NON-sink (e.g. the real backend call) — allowed
    { code: `${SECRET}\ndeclare function httpAuth(token: PlainSecret): void;\ndeclare const p: PlainSecret;\nhttpAuth(p);` },
    // object literal to a sink with only safe fields
    { code: `${REF}\ndeclare const r: SecretRef;\nconsole.info({ ref: r });` },
  ],
  invalid: [
    // direct PlainSecret to console.log
    {
      code: `${SECRET}\ndeclare const p: PlainSecret;\nconsole.log(p);`,
      errors: [{ messageId: "taintedSink" }],
    },
    // JSON.stringify of a PlainSecret
    {
      code: `${SECRET}\ndeclare const p: PlainSecret;\nJSON.stringify(p);`,
      errors: [{ messageId: "taintedSink" }],
    },
    // logger.error(secret)
    {
      code: `${SECRET}\n${LOGGER}\ndeclare const p: PlainSecret;\nlogger.error("ctx", p);`,
      errors: [{ messageId: "taintedSink" }],
    },
    // PlainSecret as a direct object-literal property to a sink
    {
      code: `${SECRET}\ndeclare const p: PlainSecret;\nconsole.error({ secret: p });`,
      errors: [{ messageId: "taintedSink" }],
    },
  ],
});

console.log("no-secret-taint rule tests: ALL PASS");
