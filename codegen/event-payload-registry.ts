/**
 * D1 codegen -- tenant event_type <-> payload_schema_ref registry.
 *
 * Decisions v1:
 * - every events/{event_type}@1 payload body is a closed empty object;
 * - identity and correlation stay in the event envelope;
 * - worker telemetry is infrastructure telemetry, not a tenant-scoped
 *   events_outbox/event-envelope event type.
 */
import runCreatedPayloadSchema from "../schema/events/run.created.schema.json";
import runStartedPayloadSchema from "../schema/events/run.started.schema.json";
import runSuspendedPayloadSchema from "../schema/events/run.suspended.schema.json";
import runResumeRequestedPayloadSchema from "../schema/events/run.resume_requested.schema.json";
import runResumedPayloadSchema from "../schema/events/run.resumed.schema.json";
import runCancelledPayloadSchema from "../schema/events/run.cancelled.schema.json";
import runCompletedPayloadSchema from "../schema/events/run.completed.schema.json";
import runFailedBusinessPayloadSchema from "../schema/events/run.failed_business.schema.json";
import runFailedSystemPayloadSchema from "../schema/events/run.failed_system.schema.json";
import stepStartedPayloadSchema from "../schema/events/step.started.schema.json";
import stepCompletedPayloadSchema from "../schema/events/step.completed.schema.json";
import stepVerifyFailedPayloadSchema from "../schema/events/step.verify.failed.schema.json";
import llmStreamStartedPayloadSchema from "../schema/events/llm.stream.started.schema.json";
import llmStreamCompletedPayloadSchema from "../schema/events/llm.stream.completed.schema.json";
import llmStreamAbortedPayloadSchema from "../schema/events/llm.stream.aborted.schema.json";
import challengeDetectedPayloadSchema from "../schema/events/challenge.detected.schema.json";
import challengeResolvedPayloadSchema from "../schema/events/challenge.resolved.schema.json";
import humanTaskCreatedPayloadSchema from "../schema/events/human_task.created.schema.json";
import humanTaskResolvedPayloadSchema from "../schema/events/human_task.resolved.schema.json";
import humanTaskExpiredPayloadSchema from "../schema/events/human_task.expired.schema.json";
import humanTaskEscalatedPayloadSchema from "../schema/events/human_task.escalated.schema.json";
import workitemCompletedPayloadSchema from "../schema/events/workitem.completed.schema.json";
import workitemDeadLetteredPayloadSchema from "../schema/events/workitem.dead_lettered.schema.json";
import pipelineStageCompletedPayloadSchema from "../schema/events/pipeline.stage.completed.schema.json";
import sinkDeliveredPayloadSchema from "../schema/events/sink.delivered.schema.json";
import sinkDeadLetteredPayloadSchema from "../schema/events/sink.dead_lettered.schema.json";
import siteCircuitOpenedPayloadSchema from "../schema/events/site.circuit_opened.schema.json";
import siteCircuitClosedPayloadSchema from "../schema/events/site.circuit_closed.schema.json";
import type { EventType } from "./types";

export type WorkerEventType = Extract<EventType, `${"worker"}.${string}`>;
export type TenantEventType = Exclude<EventType, WorkerEventType>;
export type EventPayloadSchemaRef = `events/${TenantEventType}@1`;

export type EventPayloadSchema = {
  readonly $id: string;
  readonly $schema?: string;
  readonly title?: string;
  readonly description?: string;
  readonly type: "object";
  readonly additionalProperties: false;
};

export const TENANT_EVENT_TYPES = [
  "run.created",
  "run.started",
  "run.suspended",
  "run.resume_requested",
  "run.resumed",
  "run.cancelled",
  "run.completed",
  "run.failed_business",
  "run.failed_system",
  "step.started",
  "step.completed",
  "step.verify.failed",
  "llm.stream.started",
  "llm.stream.completed",
  "llm.stream.aborted",
  "challenge.detected",
  "challenge.resolved",
  "human_task.created",
  "human_task.resolved",
  "human_task.expired",
  "human_task.escalated",
  "workitem.completed",
  "workitem.dead_lettered",
  "pipeline.stage.completed",
  "sink.delivered",
  "sink.dead_lettered",
  "site.circuit_opened",
  "site.circuit_closed",
] as const satisfies readonly TenantEventType[];

const TENANT_EVENT_PAYLOAD_SCHEMA_REFS = {
  "run.created": "events/run.created@1",
  "run.started": "events/run.started@1",
  "run.suspended": "events/run.suspended@1",
  "run.resume_requested": "events/run.resume_requested@1",
  "run.resumed": "events/run.resumed@1",
  "run.cancelled": "events/run.cancelled@1",
  "run.completed": "events/run.completed@1",
  "run.failed_business": "events/run.failed_business@1",
  "run.failed_system": "events/run.failed_system@1",
  "step.started": "events/step.started@1",
  "step.completed": "events/step.completed@1",
  "step.verify.failed": "events/step.verify.failed@1",
  "llm.stream.started": "events/llm.stream.started@1",
  "llm.stream.completed": "events/llm.stream.completed@1",
  "llm.stream.aborted": "events/llm.stream.aborted@1",
  "challenge.detected": "events/challenge.detected@1",
  "challenge.resolved": "events/challenge.resolved@1",
  "human_task.created": "events/human_task.created@1",
  "human_task.resolved": "events/human_task.resolved@1",
  "human_task.expired": "events/human_task.expired@1",
  "human_task.escalated": "events/human_task.escalated@1",
  "workitem.completed": "events/workitem.completed@1",
  "workitem.dead_lettered": "events/workitem.dead_lettered@1",
  "pipeline.stage.completed": "events/pipeline.stage.completed@1",
  "sink.delivered": "events/sink.delivered@1",
  "sink.dead_lettered": "events/sink.dead_lettered@1",
  "site.circuit_opened": "events/site.circuit_opened@1",
  "site.circuit_closed": "events/site.circuit_closed@1",
} as const satisfies Record<TenantEventType, EventPayloadSchemaRef>;

export const EVENT_PAYLOAD_SCHEMA_REFS = TENANT_EVENT_PAYLOAD_SCHEMA_REFS as unknown as Readonly<
  Record<EventType, EventPayloadSchemaRef>
>;

const TENANT_EVENT_PAYLOAD_SCHEMAS = {
  "run.created": runCreatedPayloadSchema as EventPayloadSchema,
  "run.started": runStartedPayloadSchema as EventPayloadSchema,
  "run.suspended": runSuspendedPayloadSchema as EventPayloadSchema,
  "run.resume_requested": runResumeRequestedPayloadSchema as EventPayloadSchema,
  "run.resumed": runResumedPayloadSchema as EventPayloadSchema,
  "run.cancelled": runCancelledPayloadSchema as EventPayloadSchema,
  "run.completed": runCompletedPayloadSchema as EventPayloadSchema,
  "run.failed_business": runFailedBusinessPayloadSchema as EventPayloadSchema,
  "run.failed_system": runFailedSystemPayloadSchema as EventPayloadSchema,
  "step.started": stepStartedPayloadSchema as EventPayloadSchema,
  "step.completed": stepCompletedPayloadSchema as EventPayloadSchema,
  "step.verify.failed": stepVerifyFailedPayloadSchema as EventPayloadSchema,
  "llm.stream.started": llmStreamStartedPayloadSchema as EventPayloadSchema,
  "llm.stream.completed": llmStreamCompletedPayloadSchema as EventPayloadSchema,
  "llm.stream.aborted": llmStreamAbortedPayloadSchema as EventPayloadSchema,
  "challenge.detected": challengeDetectedPayloadSchema as EventPayloadSchema,
  "challenge.resolved": challengeResolvedPayloadSchema as EventPayloadSchema,
  "human_task.created": humanTaskCreatedPayloadSchema as EventPayloadSchema,
  "human_task.resolved": humanTaskResolvedPayloadSchema as EventPayloadSchema,
  "human_task.expired": humanTaskExpiredPayloadSchema as EventPayloadSchema,
  "human_task.escalated": humanTaskEscalatedPayloadSchema as EventPayloadSchema,
  "workitem.completed": workitemCompletedPayloadSchema as EventPayloadSchema,
  "workitem.dead_lettered": workitemDeadLetteredPayloadSchema as EventPayloadSchema,
  "pipeline.stage.completed": pipelineStageCompletedPayloadSchema as EventPayloadSchema,
  "sink.delivered": sinkDeliveredPayloadSchema as EventPayloadSchema,
  "sink.dead_lettered": sinkDeadLetteredPayloadSchema as EventPayloadSchema,
  "site.circuit_opened": siteCircuitOpenedPayloadSchema as EventPayloadSchema,
  "site.circuit_closed": siteCircuitClosedPayloadSchema as EventPayloadSchema,
} as const satisfies Record<TenantEventType, EventPayloadSchema>;

export const EVENT_PAYLOAD_SCHEMAS = TENANT_EVENT_PAYLOAD_SCHEMAS as unknown as Readonly<
  Record<EventType, EventPayloadSchema>
>;
