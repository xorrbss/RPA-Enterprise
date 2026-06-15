// Flat ESLint config for the runtime (app/). Its single job is the build-blocking
// secret-taint gate (build-prompt.md §4 "secret taint lint가 빌드 차단"); general style
// rules are intentionally NOT enabled here (KISS/YAGNI — tsc --strict already covers
// type hygiene). Type information is required because the rule inspects the PlainSecret
// brand via the type-checker.
import tseslint from "typescript-eslint";
import secretTaint from "./tools/eslint-rules/no-secret-taint.mjs";

export default tseslint.config(
  {
    ignores: ["node_modules/**", "dist/**", "tools/eslint-rules/fixtures/**"],
  },
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { "rpa-security": secretTaint },
    rules: {
      "rpa-security/no-secret-taint": "error",
    },
  },
);
