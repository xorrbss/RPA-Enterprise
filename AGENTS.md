# Repository Guidelines

## Project Structure & Module Organization

This repository is a contract-first source of truth for an enterprise RPA platform, not a runnable application. Root Markdown files define domain contracts: `state-machine.md`, `api-surface.md`, `security-contracts.md`, `auth-rbac.md`, `ops-defaults.md`, and related specs. JSON Schemas live in `schema/`, SQL migrations in `db/`, and shared TypeScript contracts in `ts/`.

`codegen/` contains generated D1 artifacts from those contracts: TypeScript types, AJV validators, transition functions, OpenAPI/AsyncAPI, and fixtures. Treat contract files as authoritative and regenerate/update codegen when contracts change. `rpa_enterprise_console.html` is a standalone vanilla JS UI mockup with hard-coded data.

## Build, Test, and Development Commands

Install codegen dependencies:

```powershell
npm install --prefix codegen
```

Run strict TypeScript checks for generated code and shared TS contracts:

```powershell
npm --prefix codegen run typecheck
```

Run state-machine fixtures:

```powershell
npm --prefix codegen run fixtures
```

Open `rpa_enterprise_console.html` directly in a browser for UI review. There is no root dev server, root package manager, or backend runtime in this repo.

## Coding Style & Naming Conventions

Use UTF-8 and preserve the existing Korean domain terminology. Keep Markdown contracts concise, decision-oriented, and cross-referenced. TypeScript uses strict mode, named exports, discriminated unions, and explicit `unknown` instead of `any`. JSON Schema files use draft 2020-12 and closed shapes where possible (`additionalProperties: false`). SQL targets PostgreSQL 15+ and should preserve tenant boundaries, CAS state updates, and idempotency constraints.

## Testing Guidelines

For contract changes, update or add codegen fixtures that prove the behavior. State transitions should throw `IllegalTransition` for undefined paths; never introduce silent no-ops. For schema changes, verify validators reject invalid edge cases such as missing flow keys or `min_rows: 0`.

## Commit & Pull Request Guidelines

Recent commits use phase-based summaries, for example `Phase 5: HTML 목업 보강 (라우팅·실시간·빈/오류 상태)`. Prefer `Phase N:` or a short scoped prefix, followed by the affected contract or artifact.

PRs should include: changed contract files, generated `codegen/` updates when applicable, command results for `typecheck` and `fixtures`, and screenshots or notes for `rpa_enterprise_console.html` changes.

## Security & Agent-Specific Instructions

Contracts win over external PRDs. Do not guess unresolved behavior; mark it as `TODO: [BLOCKED]` with the missing decision. Preserve the core rule: no silent false/unknown. Secrets must remain behind `SecretRef`/`SecretStore`, and redaction/RBAC gates must not be weakened.
