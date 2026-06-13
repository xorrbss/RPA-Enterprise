# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 이 저장소의 성격 (read this first)

This is **not an application** — it is the **계약(contract) 단일 진실원천(single source of truth)** for an enterprise RPA platform (v1.2), plus a standalone UI mockup. There is **no build system, no package manager, no tests, no git**. Do not look for `package.json`, `npm`, or a dev server — they don't exist.

Two independent artifacts live here:

1. `_analysis_files_v1_2_patched/` — the contract package. Schemas (JSON Schema), TypeScript type/interface declarations, SQL migrations, and `.md` specs that **define** the system to be built. These are consumed downstream ("D1") to codegen validators + TS types; nothing here is executed.
2. `rpa_enterprise_console.html` — a single-file, dependency-free (vanilla JS + lucide-icons CDN) operations-console **mockup**. Open it directly in a browser; no server needed.

`files_v1.2_patched.zip` is a snapshot archive of (1); ignore unless asked.

## 핵심 원칙: contracts가 진실원천이다

`_analysis_files_v1_2_patched/README.md` is the authoritative changelog and design-decision record. When the contract docs disagree with an external PRD, the **contracts win** and the PRD is to be brought into line (see README §"본 패키지에서 내린 설계 결정" and the v1.1/v1.2 patch logs). Before changing any contract, read the README patch log — most edits there fix a *verified internal inconsistency*, and each carries a stated rationale. Preserve that discipline: change the contract only to fix a real internal contradiction, and record why.

A recurring, deliberate design rule across all docs — **"조용한 false/unknown 금지"** (no silent failure): unclassified exceptions are absorbed into `system` (never a typed `unknown`), missing IREL scope is a System exception (not a false), and undefined state transitions `throw IllegalTransition` (never a silent no-op). Honor this when extending anything.

## 계약 파일 지도

| File | Defines | Cross-references |
|---|---|---|
| `ir-expression.md` | IREL — the expression language: EBNF grammar, type checker, variable scopes, deterministic evaluator, compile/runtime error codes. **Compile-time validated** (parse + typecheck at scenario save; no runtime parsing). | `ir.schema.json`, `error-catalog.ts` |
| `schema/ir.schema.json` | IR node structure + flow control. `on` branching is a `{when,target,priority}` **array** (key order is non-deterministic and forbidden); exactly one flow key enforced via `oneOf`. | `ir-expression.md` |
| `reserved-handlers.md` | `@challenge` / `@human_task` / `@end_no_data` handler I/O + resume-token (HMAC, `kid` for rotation). | `state-machine.md`, `verify.schema.json` |
| `state-machine.md` | **Complete** transition tables for Run / Workitem / HumanTask. Every transition is a DB conditional `UPDATE ... WHERE status=<cur>` (CAS); races resolved by guard re-read. `transition*()` are codegen targets. | drives `ts/` + test fixtures |
| `llm-gateway-adapter.md` | LLM Gateway backend adapter interface, request schema, standardized SSE events, retry classification, structured-output validation, prompt/image redaction. Codex SSE is the primary adapter. | `error-catalog.ts` |
| `db/migration_concurrency_idempotency.sql` | Concurrency + idempotency tables: `credential_leases`/`credential_concurrency_policies` (slot_no, max_concurrency), `browser_leases`, `raw_items` (UNIQUE NULLS NOT DISTINCT dedup), `sink_deliveries` (external idempotency key), `challenge_resolution_attempts`. | `state-machine.md` |
| `ts/core-types.ts` | Shared executor contract: `PageState`, `StepResult`, `VerifyResult`, `RunContext`, `ExecutorPlugin`/`PageStateResolver`, and **brand types** (`SecretRef`/`PlainSecret`/`RedactedString`) that mark the security boundary. | `impl-contracts-bundle.md` §C |
| `ts/error-catalog.ts` | `ErrorCode` enum + `ERROR_CATALOG` meta (retryable / httpStatus / exceptionClass / userMessage / operatorAction). Single source for API responses, internal exceptions, and operator alerts. | everything |
| `impl-contracts-bundle.md` | Connector hook execution + rollback, artifact lifecycle jobs, runtime redaction boundary, ActionPlanCache classifier, trace-span/metric names (fixed). | core-types, migration SQL |
| `schema/verify.schema.json` | Verify DSL: criteria type registry; `elementTarget` requires `oneOf(selector \| role+name)`; `min_rows:0` forbidden. | `reserved-handlers.md` |
| `schema/event-envelope.schema.json` | Event envelope + `event_type` registry. `correlation_id`/`payload`/`payload_schema_ref` required; `ordering_key` intentionally optional (run-less events). Emits `run.cancelled` (not `run.aborted`). | `error-catalog.ts` |
| `ir-static-validation.md` | IR **graph-level** static validation (V1–V11): target referential integrity, reachability/orphan/terminal, loop-only cycles, on-priority ties, value_match.path grammar, fallback_chain semantics. **flags is a closed registry (§2, authoritative)**. Maps to `IR_SCHEMA_INVALID`/`IR_EXPRESSION_COMPILE_ERROR`. | `ir.schema.json`, `ir-expression.md` |
| `security-contracts.md` | Security boundary SSoT: `SecretStore` usage, shell **signed command registry**, prompt-injection detection, **Gateway redaction algorithm (§4 — resolves the old "§5.1" dangling ref)**, NetworkPolicy/domain allowlist, resume-token `kid` key boundary (KMS, not DB), connector manifest permissions, artifact RBAC gate, `sensitive`/`recording`. | `core-types.ts`, `impl-contracts-bundle.md`, `reserved-handlers.md` |
| `ts/state-machine-types.ts` | Machine-readable transition types (codegen): `RunState`/`WorkitemState`/`HumanTaskState`, `*Event` discriminated unions, `*Guard`, `SideEffectCmd`, `transition*()` signatures, `IllegalTransition`. **Authority for status enums.** | `state-machine.md` |
| `db/migration_core_entities.sql` | Core entity DDL (14 tables): runs/run_steps/workitems/human_tasks/scenarios/scenario_versions/artifacts/events_outbox/dead_letter/stagehand_calls/action_plan_cache/site_profiles/browser_identities/network_policies. Status CHECKs mirror `state-machine-types.ts`. Adds FKs to concurrency-migration tables via ALTER (apply order: concurrency → core). | `state-machine-types.ts`, `core-types.ts`, `event-envelope.schema.json`, `migration_concurrency_idempotency.sql` |
| `auth-rbac.md` | RBAC role registry (viewer/operator/reviewer/approver/admin) + permission matrix, `tenant_id` source (JWT claim), RLS policy (strict `current_setting`, FORCE RLS). `AUTHZ_FORBIDDEN` for general denials. | `error-catalog.ts`, `security-contracts.md`, all DDL |
| `api-surface.md` | Control-plane REST endpoint inventory (D1 OpenAPI input): runs/scenarios/human-tasks/workitems·DLQ/artifacts/gateway/sites. `If-Match`(scenario.version), `Idempotency-Key`, `params.as_of` injection. Vocab `abort→cancelled`. | `error-catalog.ts`, `state-machine.md`, `event-envelope.schema.json` |
| `ops-defaults.md` | Operational default values + sim-clock test fixtures for every threshold: transition limits (init-fail/attempts/abort-timeout/backoff), lease TTL·sweeper cadence, circuit rates/windows, LLM retry/timeout/budget, cache·verify·self-heal caps, artifact retention·redaction-fail, challenge/resume-token TTL. Override layers: system<tenant<site<node. | `state-machine.md`, `llm-gateway-adapter.md`, `impl-contracts-bundle.md` |

### 두 개의 `ExceptionClass` (헷갈리지 말 것)
`core-types.ts` defines `ExceptionClass` with **4 members** (`business`/`system`/`challenge`/`security`) — the runtime exception classification. `error-catalog.ts` defines a similarly-named type that **also includes `none`** — that is error-code metadata for non-exception codes (e.g. `RUN_NOT_FOUND`), a different purpose. Same name, different use; keep them distinct.

### 어휘 정합성 (vocabulary that must stay aligned)
API command `abort` → Run state `cancelled` → event `run.cancelled`. `RUN_ABORTED` means "operation rejected on an already-cancelled run." UI wording is "취소됨". If you touch one, check the chain.

## HTML 콘솔 (`rpa_enterprise_console.html`)

Single-file vanilla-JS prototype. Architecture: a `views` object (~line 1923) maps view keys to functions returning HTML template strings; `viewMeta` (~line 1910) holds the title/subtitle per view; navigation is `data-view-target` buttons swapping `#content`. Helper builders (`metric`, `button`, `panelHeader`, `pipelineNode`, `studioStep`, etc.) compose the markup. All data is hard-coded mock data — there is **no backend, no fetch, no persistence**.

The ten views mirror the contract domains: `scenarioStudio`, `playground`, `dashboard`, `workitems`, `humanTasks`, `runTrace`, `irValidation`, `llmGateway`, `security`, `idempotency`. UI copy is intentionally non-technical Korean (end-operator audience); keep that register when editing labels.

## 미결정 (open questions — do not invent answers)
README flags these as decided-elsewhere: Codex SSE structured-output streaming scope + abort spec, P1 vLLM SSE support, and per-site default credential concurrency. If a task depends on one of these, surface it as a `TODO: [BLOCKED]` rather than guessing.
