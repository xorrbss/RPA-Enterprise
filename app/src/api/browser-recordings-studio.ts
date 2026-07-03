import { createHash } from "node:crypto";

import type { IRScenario, StudioGraph, StudioValidationStage } from "../../../codegen/types";
import { isRecord } from "./command";
import type { RecordingEventRow, SiteElementLookupRow } from "./browser-recordings-store";

export function withStudioMode(value: unknown, name: string, version: number, studioMode: "visual"): unknown {
  if (!isRecord(value)) return value;
  const meta = isRecord(value.meta) ? value.meta : {};
  return {
    ...value,
    meta: {
      ...meta,
      name: typeof meta.name === "string" && meta.name.trim() !== "" ? meta.name : name,
      version: typeof meta.version === "number" && Number.isInteger(meta.version) && meta.version >= 1 ? meta.version : version,
      studio_mode: studioMode,
    },
  };
}

export function studioGraphFromIr(
  projectId: string,
  name: string,
  ir: IRScenario,
  scenarioId: string,
  scenarioVersion: number,
  stages: readonly StudioValidationStage[],
): StudioGraph {
  const graphNodeIds = new Set(
    Object.entries(ir.nodes)
      .filter(([, node]) => !("terminal" in node))
      .map(([nodeId]) => nodeId),
  );
  const nodes = [...graphNodeIds].map((nodeId, index) => {
    const node = ir.nodes[nodeId]!;
    const action = Array.isArray(node.what)
      ? node.what.find((candidate) => isRecord(candidate)) as Record<string, unknown> | undefined
      : undefined;
    const label = studioNodeLabel(nodeId, action);
    return studioNodeFromAction(nodeId, label, { x: 80 + index * 220, y: 120 }, action);
  });
  const edges = Object.entries(ir.nodes).flatMap(([nodeId, node]) => {
    if (!graphNodeIds.has(nodeId) || !("next" in node) || typeof node.next !== "string" || !graphNodeIds.has(node.next)) return [];
    return [{ id: `${nodeId}_to_${node.next}`, source: nodeId, target: node.next, type: "next" as const }];
  });
  return {
    graph_id: `studio_${projectId.replace(/-/g, "_")}`,
    name,
    version: 1,
    compiler_version: "studio-graph@1",
    start_node_id: graphNodeIds.has(ir.start) ? ir.start : nodes[0]?.id ?? "start",
    nodes,
    edges,
    validation_stages: [...stages],
    compiled_ir_ref: { scenario_id: scenarioId, version: scenarioVersion },
  };
}

function studioNodeLabel(nodeId: string, action: Record<string, unknown> | undefined): string {
  const instruction = typeof action?.instruction === "string" && action.instruction.trim() !== "" ? action.instruction : null;
  return instruction ?? nodeId;
}

function studioNodeFromAction(
  id: string,
  label: string,
  position: { x: number; y: number },
  action: Record<string, unknown> | undefined,
): StudioGraph["nodes"][number] {
  if (action?.action === "navigate") {
    return {
      id,
      type: "navigate",
      label,
      position,
      config: { url_ref: typeof action.url_ref === "string" ? action.url_ref : "entry_url", wait_until: "load" },
    };
  }
  if (action?.action === "observe") {
    const selectorRef = selectorRefFromAction(action);
    return {
      id,
      type: "extract",
      label,
      position,
      config: {
        instruction: label,
        schema_ref: "recording_observation",
        ...(selectorRef !== undefined ? { selector_ref: selectorRef } : {}),
      },
    };
  }
  const selectorRef = selectorRefFromAction(action);
  const valueRef = isRecord(action?.args) && typeof action.args.value_ref === "string" ? action.args.value_ref : undefined;
  const actionKind = actionKindFromAction(action);
  return {
    id,
    type: "act",
    label,
    position,
    config: {
      intent: label,
      ...(selectorRef !== undefined ? { selector_ref: selectorRef } : {}),
      ...(valueRef !== undefined ? { value_ref: valueRef } : {}),
      ...(actionKind !== undefined ? { action_kind: actionKind } : {}),
    },
  };
}

function selectorRefFromAction(action: Record<string, unknown> | undefined): string | undefined {
  const args = isRecord(action?.args) ? action.args : {};
  for (const key of ["click_selector", "fill_selector", "select_selector", "selector"]) {
    const value = args[key] ?? action?.[key];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return undefined;
}

function actionKindFromAction(action: Record<string, unknown> | undefined): "click" | "fill" | "select" | "submit" | undefined {
  const args = isRecord(action?.args) ? action.args : {};
  if (typeof args.fill_selector === "string") return "fill";
  if (typeof args.select_selector === "string") return "select";
  return "click";
}

export function sha256Hex(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`)
    .join(",")}}`;
}

export function buildDraftIr(
  name: string,
  events: readonly RecordingEventRow[],
  elementLookup: ReadonlyMap<string, SiteElementLookupRow> = new Map(),
): Record<string, unknown> {
  const nodes: Record<string, unknown> = {};
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]!;
    const nodeId = `step_${String(index + 1).padStart(2, "0")}`;
    const next = index === events.length - 1 ? "done" : `step_${String(index + 2).padStart(2, "0")}`;
    const action = actionFromEvent(event, elementLookup.get(event.id), properties, required);
    nodes[nodeId] = {
      what: [action],
      ...(event.event_type === "submit" ? { side_effect: { kind: "submit", idempotency_key: `recorded_submit_${event.seq}` } } : {}),
      next,
    };
  }
  nodes.done = { terminal: "success" };
  return {
    meta: { name, version: 1, studio_mode: "easy" },
    ...(Object.keys(properties).length > 0 ? { params_schema: { type: "object", properties, required } } : {}),
    start: "step_01",
    nodes,
  };
}

function actionFromEvent(
  event: RecordingEventRow,
  element: SiteElementLookupRow | undefined,
  properties: Record<string, unknown>,
  required: string[],
): Record<string, unknown> {
  const selector = element?.selector ?? event.selector;
  const label = element?.label ?? event.label ?? event.element_key ?? selector ?? event.url ?? event.event_type;
  if (event.event_type === "navigate") {
    const key = event.seq === 1 ? "entry_url" : `url_${event.seq}`;
    properties[key] = { type: "string", format: "uri", default: event.url };
    required.push(key);
    return { action: "navigate", url_ref: key };
  }
  if (event.event_type === "input") {
    const key = `input_${event.seq}`;
    properties[key] = { type: "string", description: `${label} 입력값` };
    required.push(key);
    return { action: "act", instruction: `${label} 입력`, args: { fill_selector: selector, value_ref: key } };
  }
  if (event.event_type === "select") {
    return { action: "act", instruction: `${label} 선택`, args: { select_selector: selector, select_value: event.value_preview ?? "" } };
  }
  if (event.event_type === "wait") {
    return { action: "observe", instruction: `${label} 대기`, args: { selector: selector ?? undefined } };
  }
  return { action: "act", instruction: `${label} 클릭`, args: { click_selector: selector } };
}
