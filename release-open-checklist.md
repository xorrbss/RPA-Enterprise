# Release Open Checklist

이 저장소는 contract-first SSoT이므로 release-open 판단은 루트 계약과 `codegen/` 산출물이 함께 통과해야 한다. 실제 secret 주입이나 외부 배포는 이 체크리스트 범위에 포함하지 않는다.

## Required Automated Gates

- [x] Root contract lint: `npm --prefix codegen run contract:lint` 또는 `node scripts/contract-lint.mjs`. Authoritative Markdown/Schema/SQL/TS 계약 파일 존재, UTF-8, merge conflict marker 없음, `TODO:`는 `TODO: [BLOCKED]` 형식.
- [x] Codegen install: `npm ci --prefix codegen`.
- [x] TypeScript strict: `npm --prefix codegen run typecheck`.
- [x] Fixtures: `npm --prefix codegen run fixtures`. Targeted evidence aliases are also rerunnable: `npm --prefix codegen run api:smoke`, `npm --prefix codegen run redaction:audit-smoke`, and `npm --prefix codegen run runtime:recovery-smoke`.
- [x] Schema negative fixtures: `npm --prefix codegen run validators`.
- [x] Contract consistency: `npm --prefix codegen run consistency`.
- [x] Full codegen gate: `npm --prefix codegen test`.
- [x] Local app runtime gate: `npm ci --prefix app`, `npm --prefix app run typecheck`, `npm --prefix app run test:unit`, and `npm --prefix app run test:int` under PostgreSQL 15 with a non-`SUPERUSER`/non-`BYPASSRLS` role. CI job `app-runtime` runs this without deploys or GitHub Environment binding; full local equivalent is `npm --prefix codegen run ci:local:temp-db`, and the targeted app integration rerun is `node scripts/db-temp-postgres-gate.mjs -- npm --prefix app run test:int`. The integration chain now includes real `PgGraphileRunEnqueuer` commit/rollback evidence for `run_claim` enqueue and D4.4 `SignedCommandRegistry` save/validate/promote coverage.
- [x] Workflow/OpenAPI/AsyncAPI parse: `npm --prefix codegen run yaml:parse` 또는 `python scripts/yaml-parse.py`. `.github/workflows/contract-gates.yml`, `codegen/openapi.yaml`, `codegen/asyncapi.yaml` YAML parse 성공.
- [x] Secret scan: `npm --prefix codegen run secret:scan-fixtures` and `npm --prefix codegen run secret:scan`. Private key, cloud token, GitHub token, Slack token, OpenAI key 형식의 고위험 secret marker 없음; contract workflow also has no GitHub secret context reference, `environment: staging` binding, or env dump command.
- [x] PostgreSQL 15 migration smoke: release evidence uses `npm --prefix codegen run db:smoke:release` 또는 `node scripts/db-migration-smoke.mjs --require-non-bypass`. PostgreSQL 15+에서 `db/migration_smoke.sql`이 isolated schema 안에 `db/migration_concurrency_idempotency.sql` 다음 `db/migration_core_entities.sql`을 적용하고 core table/RLS/CAS/idempotency smoke를 통과. Product Open evidence must include at least one non-SUPERUSER/non-BYPASSRLS role run so RLS/redaction assertions execute; CI provisions `rpa_smoke` for this, and the final smoke output must state that non-bypass RLS/redaction row-visibility assertions executed. Plain `db:smoke` remains diagnostic only when release evidence is not being claimed.
- [x] HTML/UI smoke: `npm --prefix codegen run html:smoke` 또는 `node scripts/html-smoke.mjs`. `rpa_enterprise_console.html`이 standalone 구조, hash router, empty/error state, 11개 view key를 유지하고 backend call을 만들지 않음.
- [x] Local repeatability: prefer `npm --prefix codegen run ci:local:temp-db` when PostgreSQL 15 binaries are installed but no disposable database is configured. Use `npm --prefix codegen run ci:local` when `PSQL_BIN`/PG env already points at a PostgreSQL 15 database with a non-`SUPERUSER`/non-`BYPASSRLS` role; the local gate now fails if it cannot prove that role matches CI's non-bypass DB smoke posture. The local gate includes app install, typecheck, unit tests, `db:smoke`, and app integration when DB is available. Use `npm --prefix codegen run ci:local:no-db` only when PostgreSQL 15 binaries are unavailable; it still runs app typecheck/unit but skips DB-dependent `db:smoke` and app integration, so record that skip reason in the PR body.
- [x] Historical remote GitHub Actions evidence: the tagged Product Open Candidate baseline has recorded `contract-gates` run URLs in `product-open-candidate-report.md`.
- [x] Current staging-readiness delta remote evidence: PR #5 latest `Contract Gates` check rollup on branch `codex/d44-app-runtime-staging-evidence-20260614` is the authoritative current-delta evidence source. The release packet must attach the latest successful PR or main run URL and the `secret-scan`, `PostgreSQL 15 migration smoke`, and `App runtime typecheck and tests` job URLs from that latest head. This closes only the current-delta remote evidence gate; it does not close external staging/open approval or the active `events_outbox.retention_until` blocker below.

- [x] HTML HTTP/UI route smoke: `npm --prefix codegen run html:http-smoke` 또는 `node scripts/html-http-smoke.mjs`. Standalone console를 `127.0.0.1` ephemeral port로 serve하고 initial `#openGate`, every hash route, invalid-hash fallback to `#dashboard`, Product-open to workitems nav click, no backend calls, HTTP 200/content-type/404/inline script syntax smoke를 확인.
- [x] DB static smoke: `npm --prefix codegen run db:static-smoke` 또는 `node scripts/db-static-smoke.mjs`. PostgreSQL 없이 migration order, isolated rollback harness, table set, tenant RLS loop, artifact redaction RLS, tenant composite FK, idempotency/CAS anchors, immutable audit hash-chain, event_type CHECK를 확인.
- [x] Blocked decision audit: `npm --prefix codegen run blocked:audit` 또는 `node scripts/blocked-decisions-audit.mjs`. Every actionable `TODO: [BLOCKED]` must have nearby Required decision text and be tracked by the release checklist; every active unchecked blocker in the staging/open blocker sections must also have a matching actionable TODO. The 13 resolved release decisions must remain present for traceability. Current local output: 24 markers, 10 actionable blockers, 13 known release decisions tracked, 13 release decisions checked.
- [x] Repo rollback/recovery evidence: DB smoke proves isolated migration transaction cleanup with `ROLLBACK`; runtime recovery smoke proves DLQ replay and idempotent recovery paths. External staging/deploy rollback evidence remains outside this contract repository and must be supplied by the platform/release owner.

## External Staging/Open Blockers

These do not invalidate the tagged repo-controlled Product Open Candidate, but
they block any executable staging/open deployment until external owners close
them in the release packet.

- [ ] External concrete staging deploy target, GitHub Environment `staging` protection/approver configuration, release approver, rollback owner, and SecretRef/SecretStore provisioning path. Required decision: see `product-open-candidate-report.md`.
- [ ] External staging SecretRef/SecretStore provisioning readiness - SecretStore backend alias/path is named without plaintext secret values. Required decision: see `product-open-candidate-report.md`.
- [ ] External staging SecretRef/SecretStore provisioning readiness - SecretRef namespace convention and runtime identities allowed to resolve each namespace are named. Required decision: see `product-open-candidate-report.md`.
- [ ] External staging SecretRef/SecretStore provisioning readiness - initial SecretRef inventory is listed by SecretRef identifiers only, with owning service/runtime and no resolved material. Required decision: see `product-open-candidate-report.md`.
- [ ] External staging SecretRef/SecretStore provisioning readiness - rotation owner/cadence and break-glass/update procedure are named. Required decision: see `product-open-candidate-report.md`.
- [ ] External staging SecretRef/SecretStore provisioning readiness - provisioning evidence artifact location, CI/deploy log redaction proof, and no-env-dump proof are named. Required decision: see `product-open-candidate-report.md`.
- [ ] External staging producer retention duration/source policy. Required decision: see `product-open-candidate-report.md`.

## Active Repo-Controlled D4.4 Blockers

These are not part of the tagged Product Open Candidate baseline, but they block
claiming the current D4.4 branch delta as executable staging-ready.

- [x] D4.4 signed command registry source. `ApiServerDeps` now requires a `SecretRef`/`SecretStore`-backed `SignedCommandRegistry`; scenario save/validate/promote pass registry refs into static validation, and shell `cmd_ref` tests cover registered, unregistered, and registry-unavailable paths.
- [ ] D4.4 events_outbox retention source. Required decision: define the repo-owned `events_outbox.retention_until` duration/source for `emitOutboxEvent`; after the decision, app/runtime producers must set `retention_until` or fail closed before the current app-runtime delta can claim executable staging readiness.

## Manual Release Review

- [x] 계약 변경은 root Markdown 계약에 먼저 반영되었고, `codegen/` 변경은 해당 계약의 산출물로 설명된다.
- [x] `README.md` 패치 로그와 현재 변경의 검증 결과가 모순되지 않는다.
- [x] `rpa_enterprise_console.html`을 브라우저에서 직접 열어 주요 view 전환, 빈 상태, 오류 상태, focus 이동을 확인했다.
- [x] PR 본문에 `contract:lint`, `typecheck`, `fixtures`, `validators`, `consistency`, `test`, YAML parse, secret scan fixtures, secret scan, app runtime typecheck/unit/integration, DB migration smoke, HTML smoke 결과가 적혀 있다.
- [x] PR 본문에 HTML/UI 변경이 있으면 스크린샷 또는 검토 메모가 포함되어 있다.

## Resolved Release Decisions

> The 13 Product Open release decisions are resolved in `release-decisions.md`. Former `Required decision:` text is preserved below only for traceability.

### Tier 1 — 기반 모델링 (D2 착수 전 결정)

- Resolved: Canonical step event/reference key is not defined. Former Required decision: `run_step_id` versus `(run_id, step_id, attempt)` for events, artifacts, and stagehand calls.
  - Decision v1: use `(tenant_id, run_id, step_id, attempt)` for events, artifacts, and stagehand calls; do not introduce `run_step_id` in v1. See `release-decisions.md`.
  - 권고: `(run_id, step_id, attempt)` 복합키 채택 — run_steps가 이미 `UNIQUE(run_id, step_id, attempt)`로 이 키를 진실원천으로 보유. surrogate `run_step_id`를 더하면 멱등 UNIQUE와 이중 진실원이 되므로 회피. events/artifacts/stagehand_calls FK를 복합키로 통일.
  - Owner: Contract + DB lead. (keystone — 나머지 FK가 여기 의존)
- Resolved: Event-specific closed payload body fields are not defined. Former Required decision: exact required/optional payload fields for every `events/{event_type}@1` schema.
  - Decision v1: every `events/{event_type}@1` payload body is a closed empty object; identity/correlation stay in the envelope. See `release-decisions.md`.
  - 권고: state-machine/api-surface가 실제 emit하는 필드에서 역산해 `events/{type}@1`을 closed shape로 고정. run.*/step.*/workitem.* 최소셋부터 schema/events placeholder를 실 본문으로 단계 교체.
  - Owner: Contract + Backend lead.
- Resolved: Worker job payload/completion event contracts are not defined. Former Required decision: job-specific input payloads and completion events for `run_claim`, `run_resume`, `workitem_checkout`, and artifact jobs.
  - Decision v1: use closed job-kind input payloads for `run_claim`, `run_resume`, `workitem_checkout`, and `artifact_redaction`; completion is expressed through existing state/event families. See `release-decisions.md`.
  - 권고: `runtime/fake-store.ts`가 이미 보유한 job 형태에서 역산해 runtime-contract.ts에 job별 input payload + 완료 이벤트를 closed로 고정. D2 슬라이스가 직접 사용.
  - Owner: Runtime lead.
- Resolved: Tenantless worker event routing contract is not defined. Former Required decision: tenantless infra event stream, operational tenant, or removal of `worker.*` events from tenant-scoped `events_outbox`.
  - Decision v1: remove `worker.*` events from tenant-scoped `events_outbox`; worker health/circuit telemetry is infrastructure telemetry. See `release-decisions.md`.
  - 권고: `worker.*`를 tenant-scoped `events_outbox`에서 분리(별도 infra event stream) 또는 고정 운영 테넌트로 라우팅 — 현재 `UNIQUE(tenant_id, idempotency_key)` + FORCE RLS와의 모순 해소(연기 아닌 내부 불일치 교정).
  - Owner: Contract + DB lead.
- Resolved: Reserved handler explicit return/input contract is not defined. Former Required decision: reserved-handler target object or handler-call node shape.
  - Decision v1: use a closed handler-call object with `handler`, `input`, and `return_node`; `@end_no_data` remains terminal. See `release-decisions.md`.
  - 권고: ir.schema에 handler-call 노드를 `{handler, input, return_node}` closed shape로 추가하고 reserved-handlers.md 입출력과 정합 → 승격 정적검증이 강제.
  - Owner: Contract lead.
- Resolved: Loop body/exit target contract is not defined. Former Required decision: loop body/exit shape that promotion validation can enforce.
  - Decision v1: loop nodes use `{ body_target, exit_target, until, max_iterations }`, with both targets validated and iteration bounded. See `release-decisions.md`.
  - 권고: `loop`을 `{body_target, exit_target, until, max_iterations}` 명시 shape로 고정 → V-rule(도달성/terminal)이 승격 시 검증 가능.
  - Owner: Contract lead.
- Resolved: Control-plane command/API error mapping is incomplete. Former Required decision: ErrorCode/HTTP response policy for unmatched routes, missing Idempotency-Key, request_hash mismatch, and concurrent duplicate in-flight Idempotency-Key.
  - Decision v1: unmatched route=`RESOURCE_NOT_FOUND`/404, missing Idempotency-Key=`IR_SCHEMA_INVALID`/422, request-hash mismatch=`SCENARIO_VERSION_CONFLICT`/412, in-flight duplicate=`WORKITEM_CHECKOUT_CONFLICT`/409. See `release-decisions.md`.
  - 권고: unmatched route→404(RESOURCE_NOT_FOUND 재사용 또는 ROUTE_NOT_FOUND 신설), missing Idempotency-Key→400, request_hash mismatch→409, in-flight 중복→409(retryable). error-catalog + error-middleware에 추가. 슬라이스의 run-create가 직접 경유.
  - Owner: API lead.
- Resolved: Human task escalation RBAC action is not defined. Former Required decision: add `human_task.escalate` to the RBAC matrix or explicitly reuse an existing action.
  - Decision v1: add dedicated `human_task.escalate`; allow reviewer, approver, and admin. See `release-decisions.md`.
  - 권고: RBAC 매트릭스에 `human_task.escalate`(reviewer/approver) 신규 추가 — resolve 재사용은 권한 혼선. H5 수동 에스컬레이션과 정합. (저비용·즉시 결정 가능)
  - Owner: Security/RBAC.

### Tier 2 — 운영/배포 (해당 단계까지 연기 가능)

- Resolved: Durable LLM idempotency contract is not defined. Former Required decision: durable `idempotency_key`/`request_hash` storage shape and request_hash mismatch ErrorCode/HTTP mapping, or explicit reuse of an existing call-cache table.
  - Decision v1: store `idempotency_key`/`request_hash` on `stagehand_calls`, unique by `(tenant_id, idempotency_key)`. See `release-decisions.md`.
  - 권고: 신규 테이블 대신 `stagehand_calls`에 `idempotency_key`/`request_hash` 컬럼 재사용, mismatch→`LLM_*` 코드. D5(Gateway)에서 확정.
  - Owner: Gateway lead.
- Resolved: Payload retention/deletion class is not defined for command cache, raw payload, normalized records, and event payload rows. Former Required decision: table-level retention columns versus external archive/purge policy.
  - Decision v1: use inline `retention_until`, `deleted_at`, and `legal_hold` columns on payload-bearing PostgreSQL tables. See `release-decisions.md`.
  - 권고: 우선 table-level `retention_until`/`deleted_at`(artifacts 기존 패턴 재사용), 외부 archive/purge는 후속. 추가형이라 저파급 → 연기 가능.
  - Owner: Ops/Compliance.
- Resolved: Durable immutable audit storage contract is not defined. Former Required decision: PostgreSQL append-only audit table versus external immutable/WORM audit sink, including retention, hash-chain anchoring, and access path.
  - Decision v1: v1 authority is PostgreSQL append-only `audit_log` with tenant-scoped hash chaining; WORM mirroring is optional later. See `release-decisions.md`.
  - 권고: v1=Postgres append-only `audit_log`(hash-chain anchor) 우선, 외부 WORM은 후속. D6 전 확정.
  - Owner: Compliance.
- Resolved: Connector target FK contract is not defined. Former Required decision: target entity key shape for `(tenant_id, connector_id, target_id)`.
  - Decision v1: `(tenant_id, connector_id, target_id)` is the canonical connector target key and future FK target. See `release-decisions.md`.
  - 권고: 3rd-party 커넥터가 README #12로 D7+ 연기이므로 함께 연기. 커넥터 도입 시 `(tenant_id, connector_id, target_id)` 키 확정.
  - Owner: Connector platform.
- Resolved: Staging deploy target is not defined. Former Required decision: GitHub Environment name, deploy target, approval owner, rollback owner, and secret provisioning model. CI must not create external deploys or materialize plaintext secrets from this contract-only repo.
  - Decision v1: GitHub Environment `staging`; approval owner `release-approvers`; rollback owner `platform-oncall`; secrets only through `SecretRef`/`SecretStore`. See `release-decisions.md`.
  - Scope note: Decision v1 resolves only the governance owner/environment/SecretRef model. The concrete platform repo, namespace/service deploy target, protection/approver configuration, rollback confirmation, and SecretStore provisioning evidence remain active external blockers above.
  - Historical recommendation superseded by Decision v1: use GitHub Environment `staging`; concrete deploy target is selected by the platform repo; approval owner is `release-approvers`; rollback owner is `platform-oncall`; secrets remain behind `SecretRef`/`SecretStore`.
  - Owner: Platform/DevOps.

## Release Decision

Release is open only when every automated gate is green, the manual review is complete, the current-delta remote evidence gate is closed, and no new required release decision remains blocking for the intended release scope. Any staging or external deploy must also close the active external blockers for the concrete deploy target, approvals, rollback owner confirmation, and SecretRef/SecretStore evidence.
