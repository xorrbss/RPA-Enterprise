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
    namespace/service remain external Required decision blockers before executable
    staging/open deployment; approval owner is
    `release-approvers`; rollback owner is `platform-oncall`; deployment secrets
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

## Follow-Up Rule

Any remaining historical blocked marker that names one of the decisions above is
an implementation migration task, not an unresolved decision. It should be
removed as the dependent contract artifact is updated.
