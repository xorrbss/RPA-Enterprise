# Release Open Checklist

이 저장소는 contract-first SSoT이므로 release-open 판단은 루트 계약과 `codegen/` 산출물이 함께 통과해야 한다. 실제 secret 주입이나 외부 배포는 이 체크리스트 범위에 포함하지 않는다.

## Required Automated Gates

- [ ] Root contract lint: `npm --prefix codegen run contract:lint` 또는 `node scripts/contract-lint.mjs`. Authoritative Markdown/Schema/SQL/TS 계약 파일 존재, UTF-8, merge conflict marker 없음, `TODO:`는 `TODO: [BLOCKED]` 형식.
- [ ] Codegen install: `npm ci --prefix codegen`.
- [ ] TypeScript strict: `npm --prefix codegen run typecheck`.
- [ ] Fixtures: `npm --prefix codegen run fixtures`.
- [ ] Schema negative fixtures: `npm --prefix codegen run validators`.
- [ ] Contract consistency: `npm --prefix codegen run consistency`.
- [ ] Full codegen gate: `npm --prefix codegen test`.
- [ ] Workflow/OpenAPI/AsyncAPI parse: `npm --prefix codegen run yaml:parse` 또는 `python scripts/yaml-parse.py`. `.github/workflows/contract-gates.yml`, `codegen/openapi.yaml`, `codegen/asyncapi.yaml` YAML parse 성공.
- [ ] Secret scan: `npm --prefix codegen run secret:scan` 또는 `node scripts/secret-scan.mjs`. Private key, cloud token, GitHub token, Slack token, OpenAI key 형식의 고위험 secret marker 없음.
- [ ] PostgreSQL 15 migration smoke: `npm --prefix codegen run db:smoke` 또는 `node scripts/db-migration-smoke.mjs`. PostgreSQL 15+에서 `db/migration_smoke.sql`이 isolated schema 안에 `db/migration_concurrency_idempotency.sql` 다음 `db/migration_core_entities.sql`을 적용하고 core table/RLS/CAS/idempotency smoke를 통과. Product Open evidence must include at least one non-SUPERUSER/non-BYPASSRLS role run so RLS/redaction assertions execute; CI provisions `rpa_smoke` for this.
- [ ] HTML/UI smoke: `npm --prefix codegen run html:smoke` 또는 `node scripts/html-smoke.mjs`. `rpa_enterprise_console.html`이 standalone 구조, hash router, empty/error state, 11개 view key를 유지하고 backend call을 만들지 않음.
- [ ] Local repeatability: prefer `npm --prefix codegen run ci:local:temp-db` when PostgreSQL 15 binaries are installed but no disposable database is configured. Use `npm --prefix codegen run ci:local` when `PSQL_BIN`/PG env already points at a PostgreSQL 15 database with a non-`SUPERUSER`/non-`BYPASSRLS` role; the local gate now fails if it cannot prove that role matches CI's non-bypass DB smoke posture. Use `npm --prefix codegen run ci:local:no-db` only when PostgreSQL 15 binaries are unavailable, and record the DB smoke skip reason in the PR body.
- [ ] Remote GitHub Actions evidence: `.github/workflows/contract-gates.yml` must be tracked, committed, and pushed before Product Open evidence can use it. Record the PR/push `contract-gates` run URL, or run `workflow_dispatch` only after GitHub shows the workflow on a remote ref; attach the `db-migration-smoke` job result. An untracked local workflow file does not satisfy this gate.

- [ ] HTML HTTP smoke: `npm --prefix codegen run html:http-smoke` 또는 `node scripts/html-http-smoke.mjs`. Standalone console를 `127.0.0.1` ephemeral port로 serve하고 HTTP 200/content-type/hash route/404/inline script syntax smoke를 확인.
- [ ] DB static smoke: `npm --prefix codegen run db:static-smoke` 또는 `node scripts/db-static-smoke.mjs`. PostgreSQL 없이 migration order, isolated smoke harness, table set, tenant RLS loop, artifact redaction RLS, tenant composite FK, idempotency/CAS anchors, event_type CHECK를 확인.
- [ ] Blocked decision audit: `npm --prefix codegen run blocked:audit` 또는 `node scripts/blocked-decisions-audit.mjs`. Every actionable `TODO: [BLOCKED]` must have nearby Required decision text and must be tracked by the release checklist; the 13 resolved release decisions must remain present for traceability.

## Manual Release Review

- [ ] 계약 변경은 root Markdown 계약에 먼저 반영되었고, `codegen/` 변경은 해당 계약의 산출물로 설명된다.
- [ ] `README.md` 패치 로그와 현재 변경의 검증 결과가 모순되지 않는다.
- [ ] `rpa_enterprise_console.html`을 브라우저에서 직접 열어 주요 view 전환, 빈 상태, 오류 상태, focus 이동을 확인했다.
- [ ] PR 본문에 `contract:lint`, `typecheck`, `fixtures`, `validators`, `consistency`, `test`, YAML parse, secret scan, DB migration smoke, HTML smoke 결과가 적혀 있다.
- [ ] PR 본문에 HTML/UI 변경이 있으면 스크린샷 또는 검토 메모가 포함되어 있다.

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
  - 권고: GitHub Environment `staging`, 컨테이너 배포(단일 노드/k8s ns), approval·rollback owner=lead, 시크릿=Vault/KMS. 배포 단계(D7 이후)에서 확정.
  - Owner: Platform/DevOps.

## Release Decision

Release is open only when every automated gate is green, the manual review is complete, and no new required release decision remains blocking for the intended release scope. Any staging or external deploy uses the resolved staging decision above.
