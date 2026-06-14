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
   `run_claim`, `run_resume`, `workitem_checkout`, and `artifact_redaction`.
   Completion is represented by the existing state/event family:
   `run.started`, `run.resumed`, workitem state events, and artifact audit
   records; no freeform job completion event is allowed.

10. Durable LLM idempotency
    Decision: store LLM idempotency in `stagehand_calls` using
    `idempotency_key` and `request_hash`, unique by `(tenant_id,
    idempotency_key)`. Hash mismatch maps to the same 409-style gateway conflict
    policy used by the in-memory gateway fixture until a dedicated catalog code
    is added.

11. Durable immutable audit storage
    Decision: v1 uses a PostgreSQL append-only `audit_log` table with
    tenant-scoped hash chaining. External WORM storage can mirror the table later
    but is not the v1 authority.

12. Tenantless worker event routing
    Decision: remove `worker.*` events from tenant-scoped `events_outbox` for v1.
    Worker health/circuit telemetry belongs to infrastructure telemetry, while
    tenant-visible site circuit state remains tenant-scoped.

13. Staging deploy target
    Decision: use GitHub Environment `staging`; deploy target is the staging
    namespace/service selected by the platform repo; approval owner is
    `release-approvers`; rollback owner is `platform-oncall`; deployment secrets
    are provisioned only through `SecretRef`/`SecretStore`. CI may validate but
    must not materialize plaintext secrets.

## Follow-Up Rule

Any remaining historical blocked marker that names one of the decisions above is
an implementation migration task, not an unresolved decision. It should be
removed as the dependent contract artifact is updated.
