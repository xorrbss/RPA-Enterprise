# Release Decisions v1

These decisions resolve the 13 Product Open contract/release questions that were
previously tracked as blocked. They are contract decisions, not proof that every
dependent implementation artifact has already been migrated.

## Decisions

1. Canonical step reference key
   Decision: use the composite key `(tenant_id, run_id, step_id, attempt)` for
   events, artifacts, and stagehand calls. Do not introduce a surrogate
   `run_step_id` in v1.

2. Event-specific payload body fields
   Decision: every `events/{event_type}@1` payload body is a closed empty object
   in v1. Identity and correlation remain envelope fields. Adding event body
   fields requires a versioned schema change.

3. Reserved handler input/return
   Decision: use a handler-call object shape, not a string target, for returning
   reserved handlers. The object must include `handler`, `input`, and
   `return_node`; `@end_no_data` remains terminal and does not require a return
   node.

4. Loop body/exit target
   Decision: loop nodes use closed shape `{ body_target, exit_target, until,
   max_iterations }`. Promotion validation must prove both targets exist,
   `exit_target` is reachable, and `max_iterations` is bounded by
   `ops-defaults.md`.

5. Payload retention/deletion class
   Decision: payload-bearing PostgreSQL tables use inline
   `retention_until`, `deleted_at`, and `legal_hold` columns. External archive or
   purge workers may be added later, but the table-level retention contract is
   authoritative for v1.

6. Connector target FK
   Decision: connector targets are identified by
   `(tenant_id, connector_id, target_id)`. Until connector target tables are
   introduced, raw collection rows keep the triple as the canonical natural key;
   later connector target tables must expose the same triple as a composite FK
   target.

7. Control-plane command/API error mapping
   Decision: unmatched routes map to `RESOURCE_NOT_FOUND`/404; missing
   `Idempotency-Key` maps to `IR_SCHEMA_INVALID`/422 for this contract-first
   scaffold; idempotency request-hash mismatch maps to
   `SCENARIO_VERSION_CONFLICT`/412; concurrent duplicate in-flight idempotency
   maps to `WORKITEM_CHECKOUT_CONFLICT`/409 and remains retryable.

8. Human task escalation RBAC
   Decision: add a dedicated `human_task.escalate` RBAC action. It is allowed for
   `reviewer`, `approver`, and `admin` roles.

9. Worker job payload/completion events
   Decision: worker jobs use closed input payloads keyed by job kind:
   `run_claim`, `run_resume`, `run_abort`, `workitem_checkout`,
   `artifact_redaction`, and `artifact_retention`.
   Completion is represented by the existing state/event family:
   `run.started`, `run.resumed`, workitem state events, and artifact audit
   records; no freeform job completion event is allowed.

10. Durable LLM idempotency
    Decision: store LLM idempotency in `stagehand_calls` using
    `idempotency_key` and `request_hash`, unique by `(tenant_id,
    idempotency_key)`. Request-hash mismatch maps to
    `SCENARIO_VERSION_CONFLICT`/412; concurrent in-flight duplicate maps to
    `WORKITEM_CHECKOUT_CONFLICT`/409 and remains retryable until a dedicated LLM
    idempotency catalog code is added.

11. Durable immutable audit storage
    Decision: v1 uses a PostgreSQL append-only `audit_log` table with
    tenant-scoped hash chaining. External WORM storage can mirror the table later
    but is not the v1 authority.

12. Tenantless worker event routing
    Decision: remove `worker.*` events from tenant-scoped `events_outbox` for v1.
    Worker health/circuit telemetry belongs to infrastructure telemetry, while
    tenant-visible site circuit state remains tenant-scoped.

13. Staging deployment governance
    Decision: use GitHub Environment `staging`; the concrete platform repo and
    namespace/service remain deploy-time Required decision blockers before executable
    staging/open deployment; approval and rollback are owned by the single project
    owner at deploy time (no external `release-approvers`/`platform-oncall` team
    exists); deployment secrets
    are provisioned only through `SecretRef`/`SecretStore`. CI may validate but
    must not materialize staging/deploy/runtime secrets or `SecretRef`-resolved
    material. Repo-visible ephemeral PostgreSQL credentials are allowed only for
    isolated CI service containers and must not be used as staging secret
    provisioning evidence.

## D6 Decisions (Pipeline / Sink + outbox consumption)

These resolve or defer the open points surfaced while building the D6 data
pipeline. They are repo-controlled contract/scope decisions, not proof that the
real external sink integration exists.

D6-1. Sink delivery retry threshold
   Decision: sink delivery reuses the `workitem` retry family as its v1 default
   (`sink.delivery.max_attempts = 3`, `retry_backoff` base 5s·factor 2·max 5m,
   `sweeper.poll = 5s`), recorded in `ops-defaults.md#sink.delivery`. Rationale:
   sink delivery is structurally a retryable `system` operation (SINK_DELIVERY_FAILED
   is retryable), so the existing retry family is the conservative, in-pattern
   default; the value is injected via `SinkDeliveryPolicy`, never hardcoded.
   Impact if wrong: too few/many attempts before `dead_letter`; reversible by
   changing the ops-default (a dedicated sink operational policy may supersede it).

D6-2. Real sink egress is deferred behind an injected port
   Decision: D6 v1 builds the DB-side mechanics (sink_idempotency_key, attempt
   ledger, status CAS, dead_letter, sink.delivered/sink.dead_lettered events) and a
   `test_fake` `SinkDeliveryPort`. The actual network egress to a real downstream
   sink (real_sink binding, SecretRef-backed) is an external fact deferred behind
   the binding — same posture as the outbox→real-bus bridge (P3/D11) and the
   artifact object-store ports. It is covered by the existing external
   object-store/SecretStore blockers; `test_fake` is local fixture evidence only and
   is not staging/product-open delivery evidence. Impact if wrong: none for v1
   mechanics; the real adapter is a later phase.

D6-3. Sink-DLQ list wired; sink-DLQ replay routing deferred
   Decision: `GET /v1/dlq?kind=sink` now lists `sink_deliveries.status='dead_letter'`
   (api-surface §4), tenant-scoped and cursor-paginated. The sink-DLQ replay path is
   deferred: api-surface §4 says a sink replay triggers re-delivery, but the shared
   `POST /v1/dlq/{id}/replay` route resolves ids against the workitem `dead_letter`
   table only and the contract does not disambiguate a sink id at that path, nor does
   the W10 `abandoned→new` transition map onto sink statuses. Re-delivery also depends
   on the deferred real egress (D6-2). Open decision: a separate sink-replay endpoint
   vs a `kind` discriminator on the shared route, with the sink-replay action being
   "enqueue a new sink_deliveries attempt (new attempt_no, same sink_idempotency_key)"
   rather than a state transition on the original row. Impact if wrong: operators can
   observe the sink DLQ but cannot replay it until routed — conservative (no false
   success); the D6 core does not depend on it.

D6-4. Checkout-expiry sweeper (W6/W7) + pause-window TTL deferred
   Decision: the workitem checkout-expiry sweeper that drives W6 (retry) / W7
   (abandoned + dead_letter) is not built in D6. state-machine W11 mandates that
   `checkout_expired` be computed excluding the W9 pause window (`checkout_paused_at`),
   but no contract pins the exact remaining-TTL formula. Building it on a guessed
   formula could falsely expire suspended workitems (spurious dead-letters), so it is
   deferred. The D6 pipeline/sink core does not depend on it (it is a workitem
   lifecycle concern). Open decision: on W11 resume, rewrite
   `checkout_expires_at = now() + remaining-TTL-captured-at-pause` vs accumulate the
   paused duration and subtract at sweep time. Impact if wrong: incorrect expiry
   timing for suspended workitems — deferred rather than guessed.

## D7 Decisions (finish-loop build deferrals)

These record scope/deferral decisions surfaced while completing the buildable
backlog in the autonomous finish-loop. They are repo-controlled decisions, not
proof that the deferred external/runtime work exists. None is an active external
release blocker (those stay in `release-open-checklist.md`); each names the
condition under which it becomes buildable.

D7-1. GET /v1/artifacts/{id} deferred
   Decision: the artifact fetch endpoint (api-surface §5) is not implemented in v1.
   Rationale: two independent blockers. (a) The `redaction → RBAC` 2-gate cannot be
   honored under the current RLS: `artifacts_visible_isolation` (migration_core_entities.sql)
   hides any artifact whose `redaction_status` is not `redacted`/`not_required` (also
   deleted/quarantined) from the application role, so the endpoint cannot distinguish
   `ARTIFACT_NOT_REDACTED` (409, "준비 중입니다") from `RESOURCE_NOT_FOUND` (404) without
   BYPASSRLS, which the API layer must never use (auth-rbac §4). (b) The 200 response
   body / signed URL is external object-store egress, covered by the existing external
   object-store/SecretStore blockers. Required decision before building: the redaction-gate
   read mechanism — either split the artifact RLS into a tenant-only metadata-visible
   policy plus a separate body-egress gate, or accept "pending ⇒ 404" (existence
   non-disclosure, which contradicts api-surface §5's 409) — plus the object-store binding.
   Impact: operators cannot fetch artifact bodies through the control plane in v1; all
   other artifact lifecycle mechanics (metadata, RLS read gate, lifecycle jobs) exist.

D7-2. OTel call-site instrumentation: wired spans done; remainder + metrics + prod export deferred
   Decision: §E trace spans are instrumented at every call site that is wired into a
   tested runtime/gateway flow (7/11): `llm_gateway.call`, `pipeline.raw_persist`,
   `sink.deliver`, `run.claim`, `browser.lease.acquire`, `session.restore`,
   `executor.execute`. The remaining 4 (`page_state.resolve`, `action_plan_cache.lookup`,
   `verify.run`, `artifact.capture`) live in D3-skeletal executor-plugin code that is not
   yet wired into a tested execution flow (`resolvePageState` has no runtime caller;
   `verify.run`/`artifact.capture` are dry-run/Chrome-only; `action_plan_cache.lookup` is in
   the LLM DOM executor pending D5). Metrics (`@opentelemetry/sdk-metrics`): the gateway-sourced
   §E metrics `llm_cost` and `llm_ttfb_ms` are recorded (low-cardinality tenant_id/model attrs,
   unit-tested with an in-memory metric reader); the remaining §E metrics (`run_success_rate`,
   `cache_hit_rate`, `self_heal_rate`, `vlm_fallback_rate`, `challenge_rate`, `site_block_rate`,
   `workitem_sla_violation`, `queue_depth`) are deferred — their source events are spread across
   flows not all wired (same deferral basis as the remaining spans). Rationale: instrumenting
   uncalled/skeletal code is YAGNI and
   cannot be integration-tested; metric value and span export only materialize once a
   provider/exporter is registered in a long-lived process. The OTel provider/exporter
   production wiring is out of repo scope (architecture §5 — browser/worker pools are
   separate deploy processes; this repo has no long-lived worker entry, and recurring
   per-tenant fan-out is blocked by D7-3). Becomes buildable when: the executor flow lands
   (remaining spans), and a deploy owner registers a TracerProvider/MeterProvider +
   exporter target (activation). Impact: existing instrumentation is correct and unit/
   integration-tested with in-memory providers; it is inert until a provider is registered.

D7-3. Recurring scheduler / sweeper per-tenant fan-out deferred
   Decision: the recurring scheduler that periodically enqueues outbox relay + lease
   sweeper + artifact lifecycle sweepers (architecture §4/§5, ops-defaults §2/§6) is not
   built. Rationale: those jobs are tenant-scoped (RLS), so a recurring driver must
   enumerate tenants, but there is no tenant registry (`tenants` table) in the schema to
   enumerate, and a cross-tenant infra relay would need a dedicated BYPASSRLS role that is
   not provisioned. The per-job handlers (relayOutbox, handleLeaseSweeper, artifact
   redaction/retention, sink_deliver) and the enqueue paths (which carry tenantId in the
   job payload) are complete and tested — only the recurring tenant fan-out is missing.
   Required decision before building: a tenant enumeration source (tenant registry table +
   a dedicated non-superuser BYPASSRLS infra-relay role), per release-decisions #13's
   SecretStore/role boundary. Impact: enqueued jobs run; time-based sweeps are not
   auto-scheduled in v1 (operationally driven until the fan-out source exists).

D7-4. Migration model is forward-only with transactional rollback
   Decision: v1 SQL migrations are forward-only and applied exactly once, in order
   (`migration_concurrency_idempotency.sql` then `migration_core_entities.sql`). DDL-level
   re-apply idempotency (e.g. blanket `IF NOT EXISTS`) is intentionally NOT adopted; the
   migration runner/ledger is responsible for not re-applying a migration. The rollback
   model is transactional: `db/migration_smoke.sql` applies both migrations inside a
   `BEGIN … ROLLBACK` isolated schema, proving clean reversibility of a single apply; no
   down-migration scripts are authored. Rationale: adding ~30 `CREATE … IF NOT EXISTS`
   guards + guarded policies would be a large, low-value DDL change of debatable
   correctness (it would mask drift), and forward-only + runner-tracked is the conventional
   v1 model. Impact: re-running a migration against an already-migrated database is the
   runner's responsibility, not the DDL's; documented so future agents do not "fix"
   migrations by bulk-adding `IF NOT EXISTS`.

## D8 Decisions (finish-loop contract/design resolutions)

These resolve the six open contract/design questions (A1–A6) surfaced by the gap
scan as "needs a decision before building". Each states the chosen resolution, the
rationale, the impact-if-wrong, and the build-condition (what unblocks the
implementation). Where a build is gated on an external fact or another stream,
that is named; the decision itself is no longer open. Boundary-sensitive choices
default to the most conservative reading (auth-rbac §2 / least-privilege).

D8-A1. GET /v1/artifacts/{id} — pending-artifact disclosure
   Decision: in v1 the application role returns `RESOURCE_NOT_FOUND` (404) for any
   artifact that is pending/failed redaction, quarantined, or soft-deleted — i.e. the
   existing `artifacts_visible_isolation` RLS is the gate (existence non-disclosure).
   `ARTIFACT_NOT_REDACTED` (409, "준비 중") is NOT exposed in v1. Rationale: most
   conservative (do not reveal unredacted-artifact existence to the app role); honoring
   api-surface §5's 409 would require a tenant-only metadata-visible RLS policy plus a
   separate body-egress gate, and would disclose redaction status — deferred. Impact:
   operators see 404 (not 409) for not-yet-redacted artifacts; when built, api-surface §5
   is amended to record the v1 404 behavior. Build-condition: this decision (done) AND
   the external object-store binding for the 200 body (B3) — so the endpoint is not built
   until object I/O exists. Alternative if 409 is later required: add a SECURITY DEFINER
   metadata read path (not a second permissive RLS policy, which would broaden all
   artifact SELECTs) + RBAC-before-disclosure ordering.
   Built (RQ-010 route): GET /v1/artifacts/{id} is implemented in-repo (app/src/api/reads.ts) —
   artifact.read RBAC + the `artifacts_visible_isolation` RLS AS the redaction gate: only
   redacted/not_required·non-deleted·non-quarantined rows are SELECTable by the app role, so
   pending/failed/quarantined/deleted/cross-tenant all resolve to RESOURCE_NOT_FOUND(404) and
   ARTIFACT_NOT_REDACTED(409) stays unexposed in v1 (no BYPASSRLS). The 200 body is read via an
   injected narrow `ArtifactObjectReader` (`ObjectStore.get` added to FsObjectStore); the route is
   registered ONLY when `ApiServerDeps.artifactStore` is wired. In-repo/CI uses FsObjectStore; the
   REAL distributed object-store binding (S3, shared across API/worker processes) stays
   deploy-time/external (B3) — same posture as the sink real egress (D6-2) and outbox real-bus
   bridge. api-surface §5 is now amended with the v1 404 note. Operators reach the artifact-read
   capability (original RQ-010 finding resolved). Verified: app/test/api-artifacts.int.ts (12
   checks: redacted/not_required 200+body, viewer artifact.read 200, pending/failed/quarantined/
   deleted/cross-tenant/absent/invalid-uuid 404).

D8-A2. PUT /v1/gateway/policy — version concurrency + PUT-time coherence
   Decision: PUT validates the body shape, requires `If-Match`(current version) and
   `Idempotency-Key`, enforces admin RBAC (`gateway_policy.edit`), and applies a
   `(tenant_id, model, version)` CAS update bumping `gateway_policies.version`; a missing
   policy or stale version maps to `POLICY_VERSION_CONFLICT` (412). PUT-time
   `LLM_CAPABILITY_MISMATCH` (422) is the deterministic STRUCTURAL coherence check only —
   `budget.maxInputTokens`/`maxOutputTokens` must not exceed `capabilities.maxContextTokens`
   (a token budget that cannot fit the model context is incoherent). SEMANTIC
   model-capability truth (does the model really support jsonMode?) stays at call time
   (existing `SafeCapabilityGate`) + the external D5 live-capability probe — PUT does not
   guess live caps. Rationale: the endpoint is fully contracted (api-surface §6, openapi)
   and self-contained; the only unspecified piece was the PUT-time coherence rule, and the
   token-vs-context bound is the one model-capability coherence checkable without live caps.
   Impact: a policy with an impossible token budget is rejected at definition; subtle live
   incompatibilities still surface at call time. Build-condition: **buildable now in-repo**
   (no external dependency). Implementation note: add `updateGatewayPolicy` to the
   `OperationId` union (ts/control-plane-contract.ts) for the idempotency endpoint key; set
   `gateway_policies.updated_by = principal.subjectId`.

D8-A3. POST /v1/dlq/{id}/replay — sink-DLQ routing (resolves D6-3)
   Decision: the shared replay route takes `?kind=workitem|sink` (matching the
   `GET /v1/dlq?kind=` list). For `kind=sink` the `{id}` resolves a
   `sink_deliveries.status='dead_letter'` row; the replay action ENQUEUES A NEW
   `sink_deliver` attempt (new `attempt_no`, same `sink_idempotency_key`) — it is not a
   state transition (W10 abandoned→new does not map onto sink statuses). RBAC for the sink
   branch is `sink_dlq.replay` (authorized in-handler; its role set is identical to
   `dlq.replay`). Rationale: a `kind` discriminator keeps one operator-facing route and
   matches the list endpoint; "new attempt, same idempotency key" preserves downstream
   dedup. Impact: operators can trigger sink re-delivery from the DLQ they already see.
   Build-condition: control-plane routing + enqueue are buildable now (the
   `sink_deliver` worker uses the injected `SinkDeliveryPort`); the ACTUAL network
   re-delivery stays behind the port (test_fake local; real egress = D6-2/B3 external).
   Implementation note: add `replaySinkDeadLetter` to `OperationId`; add an
   `enqueueSinkDeliver` enqueuer method.
   Built (RQ-011 route): control-plane routing + enqueue implemented — `POST /v1/dlq/{id}/replay?kind=sink`
   resolves a `sink_deliveries.status='dead_letter'` row (tenant-scoped; RLS-hidden/absent/non-dead_letter ⇒ 404),
   authorizes `sink_dlq.replay` in-handler (key-cost-free deny), and enqueues a new `sink_deliver` job in the
   idempotent command tx (`replaySinkDeadLetter` idempotency partition), returning 202 "enqueued". The 202 is honest
   (accepted+enqueued, NOT a delivery claim). ACTUAL re-delivery stays BLOCK on the external egress (D6-2/B3): the
   worker surfaces `SINK_DELIVERY_FAILED` when no real port is bound. Verified: app/test/api-sink-replay.int.ts (19
   checks: operator 202+enqueue identity, viewer 403 key-unused, cross-tenant 404, absent/delivered 404, invalid kind
   422, missing Idempotency-Key 422, idempotent-replay enqueues once, kind=workitem regression).

D8-A4. Checkout-expiry timer formula (resolves D6-4)
   Decision: the W9/W11 pause-window model is REWRITE-AT-RESUME. W1/W8 stamp
   `checkout_expires_at = now() + workitem.checkout_timeout` (ops-defaults §1). At W9
   (run_suspended) set `checkout_paused_at = now()` and capture remaining =
   `checkout_expires_at - now()`. At W11 (run_resumed) set
   `checkout_expires_at = now() + remaining` and clear `checkout_paused_at`. The sweeper
   selects rows where `checkout_paused_at IS NULL AND checkout_expires_at < now()` and
   emits `checkout_expired` → W6 (retry, attempts<max) / W7 (abandoned + dead_letter).
   Rationale: rewrite-at-resume is simpler and correct (no accumulation arithmetic at
   sweep time) and never expires a currently-suspended item. Impact if wrong: mis-timed
   expiry for suspended workitems — bounded by re-reading the captured remaining. Build-
   condition: the timer stamping (W1/W8/W9/W11) + the W6/W7 transition driver + the sweep
   query are buildable and unit/integration-testable now (sweep invoked directly in a
   test); the RECURRING auto-invocation depends on D8-A6 (tenant fan-out).

D8-A5. openGate / idempotency console views
   Decision: `openGate` is a STATIC contract-documentation view — it renders the
   release-gate map / RBAC matrix from contract-derived constants with no backend (there
   is no control-plane gate/checklist resource, and inventing one is YAGNI). `idempotency`
   requires a tenant-scoped read endpoint over `control_plane_idempotency_keys` (cursor-
   paginated, RLS) if operators need that surface; until that endpoint is decided it stays
   an honest Placeholder. Rationale: do not invent backend resources; openGate's content
   is documentation, idempotency's is a real (but unspecified) read surface. Impact:
   openGate becomes a real (static) view; idempotency stays Placeholder until an endpoint
   is added. Build-condition: both are FRONTEND work owned by the console stream (currently
   the parallel codex); idempotency additionally needs the read-endpoint decision/build.

D8-A6. Tenant registry for recurring sweeper fan-out (recommendation — owner review)
   Recommendation (NOT unilaterally adopted — schema + deploy impact, needs DB/security
   lead sign-off): add a `tenants` registry table (`tenant_id` PK, `status`, timestamps)
   and a dedicated non-`SUPERUSER` `BYPASSRLS` infra-relay role, so a recurring scheduler
   (graphile crontab) can enumerate active tenants and enqueue per-tenant outbox-relay /
   lease-sweeper / artifact-lifecycle jobs. Rationale: `tenant_id` is currently a JWT
   claim only (no registry), so recurring RLS-scoped jobs have no enumeration source
   (this is the root blocker behind D7-3). Impact: enables time-based sweeps; introduces a
   new table + a privileged operational role (deploy-coupled). Build-condition: owner
   approval of the registry + infra-role addition; then the scheduler (and D8-A4's
   recurring invocation) is buildable. Until approved, this stays a recommendation, not a
   decision.

D8-A7. Interpreter graph-step ceiling — ops-defaults source (resolves RQ-017)
   Decision: the IR interpreter's whole-graph non-termination guard
   (`ir-interpreter.ts` `runScenario`) is sourced from a new ops-defaults row
   `interpreter.graph_max_steps` (§5), default **200** — identical to the prior inline
   `DEFAULT_MAX_STEPS`, so this is a zero-behavior-change contract-fidelity alignment, not a
   value change. Rationale: RQ-017 flagged the 200 as a hardcoded default with no
   ops-defaults source; ops-defaults.md is the designated SSoT for "numeric values the
   contract body leaves empty" (its own §intro), so the graph-step ceiling belongs there.
   It is **distinct from `loop.max_iterations`** (10000, ir.schema): that bounds iterations
   *within one loop node body*; `interpreter.graph_max_steps` bounds the *total node
   traversal* from start to terminal. The value is not invented — 200 is the pre-existing
   defensive guard now made traceable (inline-value-with-`// ops-defaults §5`-citation,
   matching every other ops-defaults consumer: codex-sse-adapter, llm-gateway, outbox,
   sink-delivery). Exceeding it throws `InterpreterError("IR_LOOP_LIMIT")` (no silent
   infinite loop). Impact if wrong: a graph legitimately needing >200 distinct node visits
   would fail loud (overridable per-run via `deps.maxSteps`); 200 is generous for the v1
   deterministic-traversal interpreter (no loop/fallback yet). Build-condition: done
   (contract row + citation landed; no runtime wiring beyond the citation is needed because
   the repo convention for ops-defaults values is inline-with-citation, not a central
   config module).

D8-A8. Loop interpreter execution + `loop.page_count` semantics (resolves RQ-002 loop)
   Decision: implement the IR `loop` flow in the interpreter as a **while-loop controlled at the
   loop node** (`ir-interpreter.ts` `runScenario`, `ir-translate.ts`). The `body_target` subgraph
   cycles back to the loop node (V4 permits cycles only when they contain a loop node); on each
   arrival the interpreter resolves PageState (flags, same boundary as `on[]`), injects the
   `loop.*` scope, and evaluates the compiled `until`. `until == true` OR `iteration >= max_iterations`
   → `exit_target` (both graceful, per ir.schema). `loop.iteration` is the
   0-base count of completed body passes (run-scoped, per loop node).
   **graph_max_steps vs loop independence (break-it wf_bc9d71fe correction):** D8-A7 sized
   `interpreter.graph_max_steps`=200 as "total node traversal" *before loops landed*; counting loop
   body re-iterations against it would make a loop with `max_iterations > ~99` trip `IR_LOOP_LIMIT`
   instead of exiting gracefully — contradicting the "independent guards" intent. To make them truly
   independent, `runScenario` sizes the effective step budget to **`graph_max_steps +
   Σ_loopNodes(max_iterations × nodeCount)`**: graph_max_steps bounds the *structural (non-loop)*
   traversal; each loop's iterations are bounded solely by its own `max_iterations` (loopState,
   graceful exit) and contribute an allowance so they don't spuriously consume the structural
   ceiling. `IR_LOOP_LIMIT` now only fires on an actual non-terminating bug (loops self-bound; V4
   forbids non-loop cycles). Non-loop graphs are unchanged (allowance 0 → 200). Deeply-nested loops
   (a loop body containing another loop) may still need a `deps.maxSteps` override (the additive
   allowance under-counts the multiplicative nesting). The 200 baseline value is unchanged.
   **Loop-node `what` semantics:** the loop node is a **control point** — its own `what` actions run on
   every arrival (to feed the `until` evaluation, e.g. an observe refreshing flags), *including the
   final exit arrival* (run `iterations+1` times). Scenario work belongs in the `body_target`
   subgraph, not the loop node. (Canonical pagination loop nodes are observe-only → empty `what`
   after translate, so this is a control-point convention, not a behavioral surprise for well-formed
   scenarios.)
   **`loop.page_count` is defined equal to `loop.iteration`** in the deterministic interpreter:
   one loop body pass = one "page", so the interpreter has no page concept distinct from a body
   pass. Rationale / 비발명: ir-expression §2 lists both `loop.iteration` and `loop.page_count` as
   loop-scope ints but does not pin a separate increment rule for `page_count`; equating it to the
   single observable (completed body passes) is the minimal non-inventing mapping. A finer
   "pages that yielded data" metric, and the `cursor.*` namespace, are **collection-pipeline**
   concerns that don't exist yet — they remain **un-projected** and surface as `IREL_RUNTIME_MISSING`
   when referenced (ir-expression §2 line 68, "compile-then-throw, 발명 금지"; not silently false).
   Impact if wrong: a scenario relying on `page_count` meaning "data pages only" (≠ body passes)
   would over/under-count; revisited when the collection cursor/pipeline lands (same increment that
   would populate `cursor.*`). Build-condition: loop done (ir-translate loop flow + interpreter
   while-loop + `loop.*` scope; tests interpreter-loop.unit 10 + ir-translate.unit loop cases).

D8-A9. fallback_chain interpreter execution + `tier` projection (resolves RQ-002 fallback)
   Decision: implement the IR `fallback_chain` flow. ir-static-validation §4 fixes the *semantics*
   (tiers tried T0→T3 in order; `advance_when` true → try next tier; omitted `advance_when` → advance
   if the tier failed; last tier still failing → the node adopts that tier's result, not a masked
   empty/success); ir.schema/V11 fix the structure. This decision records the *runtime execution
   model*, which §4 leaves to the interpreter and which the graph model + the static fixtures imply
   (since V4 forbids non-loop cycles, a tier subgraph cannot loop back to the fallback node):
   - **Each tier is a recursive sub-traversal** from its `entry_node`, sharing the run's
     nodeScope/loopState/step-budget (refactor: `runScenario` → reentrant `traverse`). A tier runs its
     entry_node subgraph until a terminal (the fixture `entry_node` is itself a terminal node).
   - **The fallback node is terminal-producing:** the adopted (winning, or last) tier's terminal *is*
     the node's outcome. There is no separate `exit_target` (unlike loop) and no continuation after the
     fallback node — any "post-fallback" work lives inside the winning tier's subgraph. (Consistent
     with the graph: F's only out-edges are to tier `entry_node`s; tiers flow forward to terminals.)
   - **`tier` projection:** nodes executed *under* a tier carry `tier` (T0..T3) in their `node.<id>.*`
     output (`traverse(currentTier)`), so a node inside the winning tier's subgraph can branch on which
     tier it runs under (`node.<id>.tier`). This makes the projection observable (projecting only onto
     the terminal-producing fallback node would be dead). The fallback node's own output adopts the
     winning tier's `entry_node` result (+`tier`), per §4 "노드는 ... 마지막 티어의 StepResult를 채택".
   - **`advance_when` scope** = `{flags (resolved PageState), params, node}` — matching its compile
     scope (no `allowLoopScope`, so no `loop.*`/`cursor.*`).
   - **Step budget:** each fallback node adds `tiers.length × nodeCount` to the structural budget
     (same independence rationale as loop, D8-A8) so tier retries don't trip `IR_LOOP_LIMIT`.
   Rationale / 비발명: the inferred aspects (sub-traversal, terminal-producing, tier-onto-tier-nodes)
   are the only model consistent with §4 + V4 (no non-loop cycles) + the static fixture (`entry_node`
   = a terminal node); they are recorded here rather than silently assumed. Impact if wrong: a scenario
   author expecting a post-fallback continuation node (outside the tiers) or `tier` on the fallback
   node itself would need rework — but no contract/fixture exercises that shape. Build-condition: done
   (ir-translate fallback flow + interpreter sub-traversal + `tier` projection; tests
   interpreter-fallback.unit 9 + ir-translate.unit fallback cases). Adversarially break-it verified.

## Follow-Up Rule

Any remaining historical blocked marker that names one of the decisions above is
an implementation migration task, not an unresolved decision. It should be
removed as the dependent contract artifact is updated.
