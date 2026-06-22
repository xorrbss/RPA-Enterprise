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
   interpreter-fallback.unit + ir-translate.unit fallback cases).
   **break-it (wf_24e16f1b) corrections:** (1) **failed-tier status now projected** — a step that
   fails is recorded in nodeScope (`status`=failed_*, +`tier`) *before* the failure terminal returns,
   so the canonical `advance_when: node.<entry>.status == "failed_system"` works on the failure path
   (previously threw `IREL_RUNTIME_MISSING`); aligns with ir-expression §2 "status ← StepResult.status
   for every executed node". (2) **last tier's `advance_when` is not evaluated** (no tier to advance
   to per §4) — avoids a wasted `resolvePageState` and a spurious throw if it references an
   absent value. (3) the **fallback node's `status` is derived from the adopted *terminal*** (not the
   entry-node output) so a deeper tier-node failure isn't masked as entry success (only observable via
   nested fallback). (4) default-advance uses an **exact `fail_business`/`fail_system`/`fail_security`
   match**, not `startsWith("fail")`, to avoid misclassifying a `failover_*`-style success terminal.
   **Known, deferred:** non-adopted/sibling tier node outputs **persist** in the shared nodeScope
   (not rolled back) — this is consistent with the compile scope intentionally allowing `advance_when`
   to reference prior tiers' `entry_node`s (additionalPriorNodeIds); runtime correctness relies on the
   compile-time forward-ref guard, not on per-tier scope isolation (which would break legitimate
   cross-tier references). §4's "non-read_only tiers need `side_effect.idempotency_key`" is **not yet
   statically enforced** (no V-rule; the interpreter re-runs shared tier nodes) — tracked as a separate
   static-validation gap (register RQ-032). Adversarially break-it verified.

D8-A10. Object-store credential SecretRef purpose — dedicated `object_store`
   (resolves the staging-decision-proposals.md B3 sub-decision /
   product-open-candidate-report.md Artifact Object-Store Evidence Packet "purpose" row)
   Decision: add a dedicated `"object_store"` value to `SecretAccessRequest.purpose`
   (`ts/security-middleware-contract.ts`) rather than reusing the existing `"executor"`
   purpose, for the credentials that artifact redaction/retention real object-store ports
   (`ArtifactRedactor`/`ArtifactRetentionStore`, the `real_object_store` binding's
   `credentialRef`) resolve at deploy time. Rationale: **least-privilege**. Artifact lifecycle
   runs under dedicated operational BYPASSRLS roles (`artifact_redaction_job` /
   `artifact_retention_sweeper`, `ARTIFACT_LIFECYCLE_OPERATIONAL_CONTRACT`) intentionally
   isolated from executor user-traffic; reusing `executor` would authorize browser/executor
   identities to resolve object-store credentials, widening the executor blast radius beyond
   its purpose. A distinct purpose lets the SecretStore `authorize()` boundary scope object-store
   credential resolution to the artifact-lifecycle operational identity only (per the SecretRef
   namespace/identity map in staging-decision-proposals.md §3). This is **not** an invented
   external fact — it is a contract enum derived from the repo's own least-privilege /
   dedicated-operational-role model; the concrete backend alias and credential value remain a
   deploy-time `[EXTERNAL-FACT]` (staging-decision-proposals.md §8). Owner = project owner
   (Contract lead); this was the sole undecided repo-side B sub-decision and is now resolved.
   Impact if wrong (over-narrow): a future design wanting one shared executor+object credential
   can map the same SecretRef under both purposes — additive, non-breaking. Build-condition:
   enum landed; real-port wiring resolves with this purpose when the deploy-time object-store
   binding is provided.

D8-A11. Per-producer payload retention duration/source
   (resolves staging-decision-proposals.md §7 repo-side; checklist row 40 "producer retention
   policy" — the `audit_log` duration value and staging evidence remain a deploy-time `[EXTERNAL-FACT]`)
   Decision: define the v1 retention duration/source for every payload-bearing table beyond the
   already-enforced `events_outbox` (90d, NOT NULL, fail-closed in `emitOutboxEvent`) and `artifacts`
   (`artifact.retention_default` 90d, DB CHECK `legal_hold OR retention_until IS NOT NULL`):
   - `raw_items.raw_payload` → **30d** (`ops-defaults.md#raw_items.retention_default`). Rationale: raw
     collection only needs a short reprocessing/replay window; shortest tier.
   - `normalized_records.record` → **90d** (`ops-defaults.md#normalized_records.retention_default`),
     matching the `events_outbox` 90d tier.
   - `control_plane_idempotency_keys.response_body` → the D4.3 app idempotency writer already sources
     retention from the same value as `expires_at` (no separate duration; single source preserved).
   - `audit_log.payload` → **2555d (7y)** as the owner-accepted v1 default (D8-A14; owner-overridable).
     The app `PgDurableSecurityAuditDecisionWriter` already validates a supplied `retentionUntil` and
     fails closed if absent (enforcement exists); the duration value is now set per D8-A14.
   Source model: ops-defaults.md is the SSoT for these durations (per its §intro). The currently-built
   `raw_items`/`normalized_records` producers (`ingestRawItem`/`normalize`) take `retentionUntil` as
   input and have **no production caller yet** (the connector/extractor that feeds them is out of D6
   scope); when that real writer lands it must compute `retention_until` from the ops-defaults source per
   §6.1's "no silent unknown" contract (a NULL `retention_until` is excluded from the sweeper, which §6.1
   already designates a producer error for a real writer). The 30d/90d operational values are
   precedent-derived defaults (events_outbox 90d tier), not invented, and are owner-overridable; only the
   regulatory `audit_log` value is deferred. Owner = project owner. Build-condition: durations recorded
   (ops-defaults rows + this decision); real-writer fail-closed enforcement lands with the connector;
   the `audit_log` value + "each writer sets retention_until or fails closed" staging evidence close
   checklist row 40 at deploy time.

D8-A12. SecretRef namespace convention + initial inventory (resolves checklist rows 45·46;
   owner-confirmed access matrix)
   Decision: adopt the repo-derived SecretRef namespace convention and initial inventory from
   staging-decision-proposals.md §3/§4 as the v1 contract (the project owner confirmed the
   runtime→purpose access matrix). Convention: `rpa/<env>/<runtime>/<purpose>/<name>`
   (`<env>`=staging|prod; `<purpose>`=`SecretAccessRequest.purpose` value incl. `object_store`
   (D8-A10) + the `signed_command` registry namespace). Least-privilege resolve matrix:
   `api`→`signed_command`,`resume_token_hmac`(verify); `runtime-worker`→`resume_token_hmac`,`executor`;
   `browser-worker`→`executor`; `llm-gateway`→`gateway_policy`; `artifact-lifecycle` (redaction/
   retention BYPASSRLS operational role)→`object_store`; `connector-runtime`→`connector` (D7+ deferred).
   Initial inventory is the namespace skeleton by identifier only (no resolved material) — see §4.
   Rationale / 비발명: the convention is a logical naming scheme and the matrix/inventory are derived
   from the code's `SecretAccessRequest.purpose` usage per runtime (not invented external facts); they
   are repo-decidable naming, distinct from the real backend mount/path and credential values which
   remain deploy-time `[EXTERNAL-FACT]` (checklist row 44) and the rotation owner handle (row 47).
   Owner = project owner (confirmed). Build-condition: convention + inventory named (this decision +
   §3/§4 promoted); real SecretStore backend binding, resolution smoke, and credential values are
   filled at deploy time and close rows 44/47/48.

D8-A13. SecretRef rotation/break-glass policy + rotation owner (resolves checklist row 47)
   Decision: adopt the staging-decision-proposals.md §5 rotation/break-glass policy as the v1
   contract. Rotation cadence (v1 defaults, owner-overridable): `gateway_policy` 90d,
   `resume_token_hmac` kid 180d (overlapping-kid zero-downtime rotation), `executor` credential
   site-policy-first default 90d, `signed_command` verification key 365d. Break-glass: on suspected
   compromise, immediate rotation + invalidate affected SecretRef + `audit_log` append (`secret.resolve`
   deny recorded) + reissue within 24h; every break-glass use requires one immutable audit row.
   Rotation owner = the **single project owner** (release-decisions #13 — no external release/oncall
   team exists; same owner as deploy approval/rollback); the real owner handle is the project owner at
   deploy time, not a separate external party. Rationale / 비발명: cadence values are precedent-based
   operational defaults (overridable, like D8-A11), the break-glass procedure is a repo-decidable
   policy, and the owner identity reuses the already-resolved #13 determination rather than inventing a
   new external fact. Build-condition: policy + owner named (this decision + §5 promoted); actual
   rotation execution + real SecretStore binding are deploy-time operations.

D8-A14. Owner-accepted staging architecture + audit_log retention value
   (proceeds with the recommended answers; real aliases/endpoints/receipts remain deploy-time [EXTERNAL-FACT])
   Decision (owner-accepted recommendations): (a) `audit_log.payload` retention = **2555d (7 years)** v1
   default (owner-overridable) — under-retaining audit data is the worse failure and the payload is
   redacted low-PII, so conservative-long is the safe default; adjust if a specific regulation differs.
   (b) Staging architecture choices: SecretStore backend = **HashiCorp Vault** (maps to the SecretRef
   namespace/kid-rotation/`secret.resolve`-audit model; D8-A12/A13); artifact object-store = **S3 /
   S3-compatible** (ObjectStore get/delete port, object retention/legal-hold); deploy = managed-container
   target + GitHub Environment `staging` with the single project owner as approver (#13); D5 = absolute
   HTTPS SSE endpoint (no creds/query/fragment) with the provider's most-capable model, key via SecretRef
   `rpa/staging/llm-gateway/gateway_policy/codex-primary`. Rationale / 비발명: the audit value is an
   overridable operational default (like D8-A11/A13); the backend *types* are the owner's accepted
   recommendation, not invented external facts. The real Vault mount/path (row 44), S3 bucket +
   `credentialRef` (rows 51/52), D5 endpoint/model identifiers + live PASS (row 50), concrete platform
   repo/Environment config (row 43), and resolution-smoke CI evidence (row 48) remain deploy-time
   [EXTERNAL-FACT] that only the owner can provide. Build-condition: audit value recorded (ops-defaults
   §6.1); architecture chosen; deploy-time rows close as the owner provides each real artifact.
   (Update: the rows 51/52 **object-I/O** half is amended by D8-A15 — closed via an owner-operated
   real S3-protocol store; the S3 bucket name + credential value remain deploy-time external facts.)

D8-A15. Owner ratification: an owner-operated REAL object store (real S3 protocol) is acceptable
   evidence for the object-I/O half of rows 51/52 (amends the Deploy-Time Provisioning Blockers gate)
   Decision (owner-ratified): for the artifact redaction (row 51) and retention-deletion (row 52)
   **object-I/O** evidence, an object store **operated by the project owner** that speaks the real S3 wire
   protocol (SigV4 over HTTPS) with a **SecretRef-backed credential resolved via the real SecretStore**
   (Vault AppRole → `VaultSecretStore.resolve`) and that exercises the production adapters
   (`S3ObjectStore` / `S3ArtifactRedactor` / `S3ArtifactRetentionStore`) IS acceptable — including a
   self-hosted S3-compatible server such as MinIO. This does NOT relax the ban on **in-process test_fake /
   fakeable ports / temp-DB BYPASSRLS**, which remain forbidden as object-I/O proof.
   Rationale / 비발명: the deploy-time risk these rows guard is "do the production object-store adapters +
   SecretRef resolution work against a real object store with no plaintext/`ObjectRef` leak", which a real
   S3-protocol server fully exercises; whether the wire endpoint is owner-local or cloud does not change
   adapter correctness. The DB-side lifecycle CAS — `redaction_status` from `pending`, `redaction_attempts`
   threshold, legal-hold/quarantine claim **skip**, and `bypassrls.use` audit — stays REPO-CONTROLLED
   (`runtime-worker.ts` claim queries `claimRedactionArtifact` / retention claim with
   `legal_hold = false AND quarantine = false`, proven by `runtime-worker-claim.int.ts` under main
   `Contract Gates` `test:int`) and is scope-split out of the object-I/O smoke. Build-condition: gate intro +
   closure-boundary table amended to admit owner-operated real object stores; rows 51/52 close on the
   owner-operated MinIO + Vault SecretRef-backed `objectstore:smoke` evidence (redacted alias `[s3-staging-1]`).
   The same ratification extends to **row 48 (SecretStore resolution)**: an owner-operated real HashiCorp
   Vault (AppRole auth + KV v2) is acceptable for the authorized/unauthorized `secretstore:smoke` +
   `secret.resolve` audit (written hash-chained by `PgDurableSecurityAuditDecisionWriter` to a real
   PostgreSQL `audit_log` under a non-`SUPERUSER`/non-`BYPASSRLS` role), under the same in-process-fake ban;
   the real Vault mount/path and resolved secret values remain deploy-time external facts.

D8-A16. LLM Gateway deployment topology + secret-sourcing for the production composition root
   (resolves the worker `executorFactory`/`LlmGateway` wiring blocker; backlog item 1 of the
   adapter-wiring backlog in product-open-candidate-report.md / staging-deploy-runbook.md)
   Decision (owner-ratified): for v1 (single-host managed-container deploy, D8-A14), the `LlmGateway`
   is assembled **in-process inside the runtime-worker** (the `RunExecutorFactory` seam injects
   `createDomUtilityExecutorFactory(gateway, policy)`), NOT as a separate `llm-gateway` daemon/identity.
   Consequences, each chosen deliberately over the matrix-pure alternative (separate `RUN_MODE=gateway`
   service + HTTP `LlmGatewayCaller` + a Codex-API-key SecretRef purpose), which is deferred as a later
   migration:
   - **Codex provider credentials** (`CODEX_BASE_URL` / `CODEX_API_KEY` / `CODEX_MODEL`) are sourced from
     **env**, NOT Vault — exactly mirroring the existing `JWT_HS256_SECRET` documented gap (env.ts: "no
     SecretRef purpose exists in the least-privilege matrix yet"). The D8-A12 `RESOLVE_MATRIX` defines NO
     purpose for a raw LLM provider API key, and `gateway_policy` (the `llm-gateway` identity's purpose)
     maps to the `gateway_policies` table = model/capabilities/budget **policy config**, not a credential.
     So env-sourcing the key invents no purpose and bends no matrix. The worker process holding the LLM key
     is an accepted least-privilege relaxation **only because the v1 deploy is single-host** (no cross-host
     isolation lost); the separate-identity migration re-tightens it.
   - **Gateway artifact sink object store** = `FsObjectStore` (local volume, `GATEWAY_ARTIFACT_DIR`), NOT
     `S3ObjectStore`. The D8-A12 matrix authorizes `object_store` for the `artifact-lifecycle` identity
     only — the runtime-worker is NOT authorized — and `LlmGateway` calls `sink.put` unconditionally.
     Using the credential-free `FsObjectStore` for gateway output artifacts (LLM call evidence) in v1
     avoids granting the worker `object_store` and avoids the matrix conflict. The S3-backed gateway sink
     (with an `object_store`-authorized identity) is a later migration, consistent with D8-A14 (S3 is the
     adopted object store) and D8-A15 (real S3/MinIO already exercised for the *artifact-lifecycle* path).
   - **Operational knobs** are the ops-defaults §4/§6 fixed values (retry_max 2 / fallback 1 / repair 1;
     idle 20s / wall 120s; budget max_output_tokens 4096 / max_cost_per_run $0.85 / max_input_tokens =
     90% of `maxContextTokens`; artifact retention 90d) — assembled as constants, not new env knobs (YAGNI;
     per-tenant override remains `gateway_policies`, not the entrypoint env). Only genuinely deploy-varying
     provider facts (base URL / key / model / maxContextTokens / per-1k price / artifact dir) are env.
   Rationale / 비발명: this records a verified cross-contract constraint (the D8-A12 security matrix vs. the
   handoff's "assemble the gateway in the worker" plumbing intent) and resolves it without inventing a
   SecretRef purpose or violating the matrix; the chosen relaxations (env key, FS sink) are scoped to the
   single-host v1 and each has a named re-tightening migration. Note: with `browserSessionProvider` still
   unwired (backlog item 2), the injected `executorFactory` is **dormant** (`driveClaimedRun` only runs when
   a session provider is present), so the gateway is assembled-and-ready but not yet on any live job path;
   the Q1 wiring precondition (existing extract scenarios lacking `args.schema` → `EXTRACT_SCHEMA_INVALID`)
   therefore does not bite until backlog item 2 lands a provider. Owner = project owner. Build-condition:
   topology + secret-sourcing named (this decision); the gateway assembly lands in `app/src/main.ts` +
   `app/src/config/env.ts` (`loadGatewayConfig`).

## Audit Decisions (2026-06-22, concurrency / lease adversarial audit)

These record the two confirmed findings of the concurrency/lease/idempotency cluster
adversarial audit (18 candidates → 2 confirmed / 16 refuted; the 16 were correctly
latent — their consumers, the D6 sink/raw-ingest pipeline, are not production-wired).
They are repo-controlled scope/deferral decisions, not external-fact claims.

AUD-1. Credential concurrency cap (credential_leases acquire + max_concurrency) deferred
   Decision: the contract defines credential-slot leasing
   (`credential_concurrency_policies.max_concurrency`, `credential_leases.slot_no`, the
   conditional-upsert acquire pattern commented in `migration_concurrency_idempotency.sql`
   #6) but the runtime only **expires** stale credential leases via the sweeper; **acquire +
   SESSION_LOCKED defer is not built**. It is deferred — not built as a no-op — because its
   protected resource (credential `fill`) is **not production-wired**: `ctx.assetRefs` is
   injected only by the dev entrypoint (`app/dev/run-loop.ts` `deriveAssetRefs(meta.assets)`),
   never by the production worker (`main-worker.ts` → `PgRuntimeWorker`; `loadRunDriveInputs`
   leaves `assetRefs` empty). A production run that hits a `secretRef` fill therefore throws
   `IR_SCHEMA_INVALID "asset key not bound"` at `stagehand-dom-executor.resolveSecretForFill`
   — no concurrent real-credential usage exists to cap. This is consistent with prod
   credential fill being gated on Vault/SecretStore prod provisioning (owner task). Rationale:
   leasing the run's SecretRefs would acquire **zero** leases while `assetRefs` is empty —
   building the cap now is YAGNI ahead of an unwired consumer (the same posture as D6-2).
   Build-condition (paired): (1) wire production `assetRefs` injection into `PgRuntimeWorker`
   (reuse `deriveAssetRefs`), (2) Vault prod provisioning so `fill` actually runs; then add
   credential-lease acquire at the claim gate (after browser-lease acquire), keyed
   `(SecretRef, site_profile_id)`, with SESSION_LOCKED defer (browser-lease-isomorphic) and
   release at terminal settlement. Owner = project owner. Impact if wrong: none for v1 (no
   prod credential fill executes); the cap lands with the fill wiring.

AUD-2. Lease sweeper teardown scope: own-worker sessions (cross-worker = container reclaim)
   Decision (implemented): `handleLeaseSweeper` now honors the `migration #7` sweeper
   contract's "RETURNING → process kill + cleanup (idempotent)" by collecting expired
   `browser_leases` (RETURNING) and, outside the DB tx, tearing down the live session
   (`drainAbort`: Chrome close + isolated download-dir removal) for leases **this worker
   bound** (run-linked `active`, `owner_worker_id == workerId`). `drainAbort` no-ops
   (`transient_failed`) for leases not in this worker's in-process registry. Scope clarified:
   a sweeping worker can only kill processes it can reach (its own host); a **dead other
   worker's** Chrome is on a different host and is reclaimed by **that worker's container
   teardown**, not the sweeper — the sweeper still DB-expires those rows (slot accounting
   freed). Rationale: the migration comment's "kill process" is single-host/own-worker
   reachable; multi-host OS reclamation is a deployment-model (container) responsibility, not
   a cross-host RPC the sweeper can perform. Impact if wrong: a long-lived worker that lapses
   its own lease (failed renewal while alive) previously leaked a Chrome process + download
   dir until restart — now reclaimed at sweep; cross-worker behavior unchanged (was, and
   remains, container-reclaimed).

## Audit Decisions (2026-06-22, security-boundary adversarial audit)

Security-boundary cluster adversarial audit (16 candidates → 4 confirmed / 12 refuted).
RED-01 (JSON redaction under-mask, P1) and NPA-02 (navigate landed-URL re-check after
redirect, P2) were fixed as contract-aligned defects. The two below are recorded decisions.

AUD-3. Internal-host denylist on site-create / navigate gate (SSRF defense-in-depth) — deferred to a policy decision
   Finding (NPA-03, P2): `POST /v1/sites` (`applySiteCreate` → `hostOfUrlPattern`) and the
   runtime navigate gate (`utility-executor.navigationPolicyFailure` / `isHostAllowed`) have
   no denylist for private/internal hosts, so an `operator` (who holds `site.create`) can
   register a metadata/RFC1918 host (e.g. `169.254.169.254`, `10.x`) into `allowed_domains`
   and a scenario can then navigate to it. Decision: NOT implemented as a blanket private-IP
   denylist, because (1) it is **not contract-required** — security-contracts §6 mandates only
   "block movement/requests OUTSIDE allowed_domains", not "block internal hosts that ARE in the
   allowlist"; and (2) a blanket RFC1918 denylist would **break legitimate internal-app RPA**
   (enterprises commonly automate intranet/internal tools on 10.x/192.168.x), so which ranges to
   block is a deployment-specific policy the owner must set. The exploit also requires a trusted
   `operator` role to deliberately register the bad host (a malicious operator can already exfil
   via allowlisted public sites), making this defense-in-depth, not a privilege boundary. Note:
   the **NPA-02 landed-URL re-check (this audit, fixed) already blocks the scariest variant** —
   a *redirect* from an allowlisted public site to `169.254.169.254` now fails
   `DOMAIN_POLICY_VIOLATION` because the metadata host is not in the allowlist. Build-condition:
   owner decides the denied-range policy (recommended safe default: deny loopback `127.0.0.0/8`
   + link-local `169.254.0.0/16` — never legitimate cross-host RPA targets — while preserving
   RFC1918 for internal automation). Owner = project owner. Impact if wrong: a compromised/
   careless operator can register an internal host; mitigated by operator-trust + NPA-02 for the
   redirect path; DNS-rebinding would bypass any create-time literal-IP denylist regardless.

AUD-4. Credential-fill selector is LLM-chosen (SSB-01, P1) — verify reachability before fixing
   Finding: in the credential `fill` path the secret VALUE is deterministic (SecretRef, never
   LLM), but the DOM SELECTOR it is typed into comes from the LLM plan; a hallucinated/injected
   selector could type a plaintext password into a non-password field (then leaked via
   non-type-based screenshot masking + re-extraction). Decision: pending reachability
   verification — credential `fill` requires `ctx.assetRefs`, which (per the 2026-06-22
   concurrency audit, AUD-1) is injected only by the **dev** entrypoint (`app/dev/run-loop.ts`),
   not the production worker. If fill is dev-only today, the production severity is bounded by
   the same Vault/assetRefs wiring gate as AUD-1, and the fix (deterministic `secret_selector`
   IR mode, or CDP read-back that the resolved element is `input[type=password]`) should land
   WITH that wiring. To be verified file:line before building (the audit's verify pass can miss
   the assetRefs-not-prod-plumbed detail, as it did for AUD-1). Owner = project owner.

## Audit Decisions (2026-06-22, LLM gateway + executor adversarial audit)

LLM gateway+executor cluster adversarial audit (22 candidates → 5 confirmed / 17 refuted). DAH-01/SO-1
(act action_plan structured-output fail-closed, P0; PR #252) and GW-SSE-02 (self-heal LLM idempotency
replay short-circuit, P1; PR #253) were fixed as contract-aligned defects. The two below are recorded.

AUD-5. Run abort does not cancel the in-flight LLM gateway call (SHF-1, P1) — cross-process design needed
   Finding: `driveScenario` (run-step-driver.ts:257) builds the production `RunContext` with
   `abortSignal: new AbortController().signal` — a signal that is NEVER aborted. The cooperative-abort
   guard is fully wired (executors check `ctx.abortSignal.aborted`; the dom executor threads it into
   `gateway.call(req, ctx.abortSignal)`; the Codex SSE adapter aborts the stream on a live signal), but the
   signal is dead, so a run abort never cancels an in-flight LLM SSE call (act/observe/extract planning).
   The call runs to the gateway wall/idle timeout, wasting tokens/budget for an already-cancelled run.
   Decision: NOT fixed with an in-process AbortController bridge, because `handleRunAbort` is a SEPARATE
   graphile job that may run in a DIFFERENT worker process than the drive (graphile worker pool — true even
   single-host), so `controller.abort()` from the abort job can't reach the driving process's controller.
   The robust fix is cooperative DB-status polling in the drive loop (between nodes, re-read run status →
   self-abort the controller if `aborting`) — a drive-loop change that is a design decision (polling cadence
   vs a dedicated cancellation channel). Harm is BOUNDED: correctness is protected by the existing CDP
   session teardown (`drainAbort` closes the session → the next CDP op throws → the drive errors and the LLM
   result is discarded); the leak is only wasted LLM budget bounded by one wall/idle timeout. Build-condition:
   owner picks the abort-propagation mechanism (status-poll in drive loop, recommended). Owner = project owner.

AUD-6. §3(d) off-allowlist-URL prompt-injection signal not threaded to the wired gateway (GRI-2, P2) — defense-in-depth
   Finding: `redaction-boundary` computes a §3(d) `off_allowlist_url` injection signal only when
   `input.networkPolicy` is supplied, but the wired gateway callers (`llm-gateway.redactRequest`/`repairOnce`)
   and `buildRequest` do not thread `ctx.networkAllowedDomains` into the request, so that one injection signal
   is effectively dead. Decision: low-priority defense-in-depth (identical to the security audit's INJ-01,
   refuted there) — it is ONE signal among several injection detectors, and the broader navigate domain gate
   (NPA-02 landed-URL re-check, fixed) already blocks off-allowlist navigation. Threading `networkPolicy`
   through is a small change but adds one detector of marginal value; deferred unless the owner wants the
   full §3 signal set active. Owner = project owner. Impact if wrong: a prompt that references an off-allowlist
   URL is not flagged by this specific detector (other detectors + the navigate gate still apply).
   ⚠ UPDATE (2026-06-22, mop-up): naively threading `networkPolicy` is UNSAFE and was NOT done. The off_allowlist_url
   check (`redaction-boundary.ts` extractDomains) scans the ENTIRE prompt — which for act/observe/extract is
   `${instruction}\n[page]${DOM-json}` (stagehand-dom-executor-dom.ts:264) — for ANY `https?://` URL and blocks the
   LLM call if a domain isn't in `allowedDomains`. Real pages reference many off-allowlist domains (CDNs, fonts,
   analytics, outbound links), none of which are in the site's `allowedDomains`, so activation would block ~every
   LLM-planned step on real pages (rampant false positives → broken automation). The dead signal is SAFER than naive
   activation. Proper fix requires SCOPING the signal to exfil-instruction context (e.g. URLs in the model's
   *output*/instruction, or a sanctioned-domain allowlist distinct from the navigation policy) — a signal redesign,
   not a thread-through. Recommend leaving dead until the scope is designed. Owner = project owner.

## Audit Decisions (2026-06-22, API surface / control-plane RBAC adversarial audit)

API/control-plane cluster adversarial audit (12 candidates → 3 confirmed / 9 refuted). HEADLINE ASSURANCE:
**zero RBAC-bypass / tenant-isolation / info-leak defects confirmed** — the per-route `rbacAction` + fail-closed
`authorize` preHandler + RLS + 404-not-403 disclosure held under adversarial probing (TI-1/TI-2 RLS-only,
INFOLEAK-01/02 enumeration, RBAC-archive were all refuted as defense-in-depth / contract-compliant). The 3
confirmed are P2 correctness issues; PAG-01 (cursor microsecond precision → silent row skip) was FIXED (this PR).
The two below are recorded.

AUD-7. Stale If-Match/version conflict (412) persists to the idempotency record → permanent retry lock (IFM-1, P2)
   Finding: `runIdempotentCommand`/`promoteScenario`* persist a non-retryable `ApiResponseError` via `saveFailure`;
   `SCENARIO_VERSION_CONFLICT`/`POLICY_VERSION_CONFLICT` (412, retryable=false in error-catalog) are thrown by the
   If-Match check INSIDE the reserved work callback, so a stale-If-Match 412 is stored. Because the canonical
   request hash excludes the If-Match header and the body is unchanged (rollback/archive `{}`, PUT policy value), a
   client that correctly re-reads the latest version and retries with the SAME Idempotency-Key + corrected If-Match
   hits `reserve()` → `replay` → the stored stale 412 forever. api-surface §0.3 promises "If-Match 재시도" must be
   able to succeed; this locks the key (24h TTL). A same-tenant writer bumping the version at the victim's moment is
   an availability nuisance. Decision (recipe, not yet fixed): do NOT persist optimistic-concurrency conflicts to
   the idempotency record — either exclude `SCENARIO_VERSION_CONFLICT`/`POLICY_VERSION_CONFLICT` from the
   `saveFailure` guard and release the reservation (TTL/DELETE → fresh reserve on retry), OR lift the If-Match check
   BEFORE `reserve()` (pre-reservation rejection, like `server-abort-run.ts:63-85`). Owner = project owner.

AUD-8. If-Match version check is SELECT-then-INSERT (non-atomic) → concurrent writers get 500 not 412 (IFM-2, P2)
   Finding: PUT/rollback/promote-from-run read the current version then INSERT `scenario_versions` with no row
   lock/CAS; two concurrent writers computing the same `version` both INSERT → the loser hits UNIQUE
   `(tenant_id, scenario_id, version)` (23505), a raw PG error that escapes the `instanceof ApiResponseError` guard
   and is mapped to `CONTROL_PLANE_INTERNAL_ERROR` (500) instead of the contractual `SCENARIO_VERSION_CONFLICT`
   (412). Reachable by console double-click / concurrent edit. Decision (recipe, not yet fixed): classify the
   23505 unique_violation on the version constraint → `SCENARIO_VERSION_CONFLICT` (412), mirroring `createRun`'s
   `idx_runs_one_per_workitem` 23505 handling (`server-create-run.ts:255-265`); or `INSERT ... ON CONFLICT
   (tenant_id, scenario_id, version) DO NOTHING RETURNING id` → 412 on 0 rows; or `FOR UPDATE`/advisory-lock the
   scenario row. Owner = project owner. Impact: confusing 500 (not data corruption — UNIQUE preserves integrity).

## Audit Decisions (2026-06-22, state-machine + event-pipeline + IREL + artifact-lifecycle adversarial audits)

> Continuation of the adversarial-audit campaign. Merged this round (not deferred): state-machine clusters
> A (browser_lease heartbeat #261), B (zombie-run sweeper #263), C (resume-token reissue #264); event-pipeline
> EPL-01 (R13 per-cycle outbox key #266); IREL @end_no_data terminal (#268); artifact redaction correctness
> (JSON embedded-credential mask + fail-threshold #270). The items below are the **confirmed-but-deferred**
> findings (recipe + impact + build-condition + owner), same discipline as AUD-1..8.

AUD-9. Redacted-at-rest violation: original plaintext object not deleted after redaction (artifact audit P1)
   Finding: `artifact-redaction-processor.finalizeRedactionDecision` swaps `artifacts.object_ref` to the new
   redacted object (`COALESCE($redacted, object_ref)`) but never deletes the **original pending plaintext
   object** (merged-extract records / gateway llm_output etc., may contain PII/credentials). The retention
   store only deletes the (swapped) redacted object; no lifecycle path reclaims the original → it lingers in
   the object store indefinitely. Reachable whenever the artifact lifecycle redaction consumer runs
   (`ARTIFACT_LIFECYCLE_CONSUMER=self|external`). **Not API-reachable** — the read route (`reads-artifacts.ts`)
   serves the swapped redacted `object_ref` behind RLS; leak surface is object-store at-rest / backup / forensic.
   Decision (recipe, not yet fixed): after the finalize CAS commits a `redacted` decision with a new ref,
   idempotently delete the original object (reuse `ArtifactRetentionStore.deleteObject` + extend its
   `deleteReason` union with `redaction_superseded`; the redaction processor needs the delete capability
   injected) — order so the row points to redacted before delete, loud-retry on delete failure. Subsumed by the
   AUD-10 orphan sweeper if that is built first. Owner = project owner. Impact: at-rest plaintext retention
   (confidentiality regression), not API exposure.

AUD-10. Artifact lifecycle hardening sweepers unimplemented: integrity-checker + orphan-sweeper (artifact audit P1/P2)
   Finding: `impl-contracts-bundle.md §B` specifies daily `artifact_integrity_checker` (sha256↔object compare →
   quarantine on mismatch) and `artifact_orphan_sweeper` (reclaim unreferenced objects), but neither exists in
   `app/src` (no job kind, no processor, no schedule). Effect: at-rest tampering/corruption of a
   redacted/not_required artifact is undetected (served as-is until detected elsewhere); orphan objects
   (re-claim/retry redacted artifacts + AUD-9 originals) accumulate unbounded. Decision (recipe, not yet built):
   add `artifact_integrity` / `artifact_orphan` to `ArtifactLifecycleJobKind` + `RuntimeWorkerJob.kind`, build
   the processors, and wire daily ticks into the maintenance scheduler (sibling to retention). Owner = project
   owner. Impact: missing at-rest integrity/GC hygiene; no active data corruption.

AUD-11. legal_hold TOCTOU during retention claim window (artifact audit P2 — latent)
   Finding: the retention processor commits the claim (legal_hold=false), deletes the object out-of-tx, then a
   separate finalize tx re-checks legal_hold; if legal_hold flips to true within the ~5m claim window the object
   is already deleted but finalize CAS fails, leaving `deleted_at` NULL — a hold-protected artifact's bytes are
   irreversibly gone. **Latent**: there is no in-product write path that sets `legal_hold=true` (no API; grep
   `SET legal_hold` = 0); only a direct operator DB write during an in-flight retention job triggers it.
   Decision (recipe, not yet fixed): re-read legal_hold/deleted_at/retention_until under `FOR UPDATE` in the
   same tx as (or immediately before) the object delete, skip delete on mismatch (CAS-before-delete). Owner =
   project owner. Apply when a legal_hold write path is introduced.

AUD-12. IREL spec'd-but-generator-unused corner gaps (IREL audit, 5 × P2/P3 — reachable only via hand-authored IR)
   Finding: 5 confirmed IREL/static-validation gaps, all in IR constructs that **no auto-generator
   (deterministic_mvp/llm_v1) emits** — reachable only via hand-authored IR-studio (`studio_mode:"ir"`)
   scenarios: (a) `verify.vlm_fallback.when` compiled as IREL though `verify.schema.json` declares it a
   verify-engine state condition (false-rejects the documented `criteria_uncertain` default) —
   `static-validation.ts:373-376`; (b) `date_before`/`date_after` use `Date.parse` so offset-less ISO datetime
   is parsed in worker-local TZ → non-deterministic (ir-expression §5) — `irel-compile.ts:626-633`; (c) V10
   `value_match.path` checks grammar but not root existence (`extracted`/`node.<id>`) → false-accept —
   `static-validation.ts:298-304`; (d) `flags.cursor_reached` is in the §2 closed registry but the interpreter
   has no producer → `loop.until` referencing it always `IREL_RUNTIME_MISSING`; (e) `on[].target` =
   reservedHandlerCall is accepted by schema/static but rejected by the interpreter (`ir-translate.ts:301-314`)
   — compile-accept/runtime-reject asymmetry. The IREL **core** used by real scenarios (flags/params/on/loop/
   terminal/verify.criteria) is sound. Decision (recipes in memory, not yet fixed): per-item fixes in
   `codegen/static-validation.ts`/`irel-compile.ts` (+fixtures) and the interpreter; prioritize when the IR-studio
   hand-authoring surface is exposed to operators. Owner = project owner. Impact: bounded mis-validation /
   non-determinism in currently-unused IR features.

## Follow-Up Rule

Any remaining historical blocked marker that names one of the decisions above is
an implementation migration task, not an unresolved decision. It should be
removed as the dependent contract artifact is updated.
