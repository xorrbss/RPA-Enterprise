# Repository Guidelines

## Project Structure & Module Organization

This repository is a contract-first source of truth for an enterprise RPA platform, with runnable package surfaces layered on top. Root Markdown files define domain contracts: `state-machine.md`, `api-surface.md`, `security-contracts.md`, `auth-rbac.md`, `ops-defaults.md`, and related specs. JSON Schemas live in `schema/`, SQL migrations in `db/`, and shared TypeScript contracts in `ts/`.

`codegen/` contains generated D1 artifacts from those contracts: TypeScript types, AJV validators, transition functions, OpenAPI/AsyncAPI, and fixtures. Treat contract files as authoritative and regenerate/update codegen when contracts change.

`app/` is the Fastify/PostgreSQL/Graphile Worker runtime and control-plane API. `web/` is the Vite/React enterprise console. `rpa_enterprise_console.html` remains a standalone vanilla JS review mockup and should not be treated as the production console implementation.

## Build, Test, and Development Commands

There is no root package manager. Install and run each package from its own prefix.

Contract/codegen checks:

```powershell
npm install --prefix codegen
npm --prefix codegen run typecheck
npm --prefix codegen run fixtures
```

Runtime/API checks:

```powershell
npm install --prefix app
npm --prefix app run typecheck
npm --prefix app run test:unit
```

Frontend console checks:

```powershell
npm install --prefix web
npm --prefix web run typecheck
npm --prefix web test
npm --prefix web run build
npm --prefix web run dev
```

Local gate helper:

```powershell
node scripts/run-local-gates.mjs --skip-db
```

Integration tests under `app/test/*.int.ts` require PostgreSQL and the relevant environment variables. Open `rpa_enterprise_console.html` directly in a browser only when reviewing the legacy standalone mockup.

## Coding Style & Naming Conventions

Use UTF-8 and preserve the existing Korean domain terminology. Keep Markdown contracts concise, decision-oriented, and cross-referenced. TypeScript uses strict mode, named exports, discriminated unions, and explicit `unknown` instead of `any`. JSON Schema files use draft 2020-12 and closed shapes where possible (`additionalProperties: false`). SQL targets PostgreSQL 15+ and should preserve tenant boundaries, CAS state updates, and idempotency constraints.

## Testing Guidelines

For contract changes, update or add codegen fixtures that prove the behavior. State transitions should throw `IllegalTransition` for undefined paths; never introduce silent no-ops. For schema changes, verify validators reject invalid edge cases such as missing flow keys or `min_rows: 0`.

For `app/`, run `typecheck` plus focused unit or integration tests that cover the touched boundary. For `web/`, run `typecheck`, Vitest, and a build check when UI structure or bundle-facing imports change.

## Commit & Pull Request Guidelines

Recent commits use phase-based summaries, for example `Phase 5: HTML 목업 보강 (라우팅·실시간·빈/오류 상태)`. Prefer `Phase N:` or a short scoped prefix, followed by the affected contract or artifact.

PRs should include: changed contract files, generated `codegen/` updates when applicable, command results for package checks, and screenshots or notes for UI changes.

## Security & Agent-Specific Instructions

Contracts win over external PRDs. Do not guess unresolved behavior; mark it as `TODO: [BLOCKED]` with the missing decision. Preserve the core rule: no silent false/unknown. Secrets must remain behind `SecretRef`/`SecretStore`, and redaction/RBAC gates must not be weakened.
