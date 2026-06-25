import type {
  BrowserRecordingAppendEvent,
  BrowserRecordingEvent,
  BrowserRecordingEventType,
  BrowserRecordingSession,
  BrowserRecordingValidationIssue,
  SiteElementItem,
} from "../../api/types";

export const EVENT_TYPES: readonly BrowserRecordingEventType[] = [
  "navigate",
  "click",
  "input",
  "select",
  "submit",
  "wait",
];

export const EVENT_LABEL: Record<BrowserRecordingEventType, string> = {
  navigate: "페이지 이동",
  click: "클릭",
  input: "입력",
  select: "선택",
  submit: "제출",
  wait: "대기",
};

export const STATUS_LABEL: Record<BrowserRecordingSession["status"], string> = {
  recording: "녹화 중",
  completed: "자동화 준비",
  discarded: "폐기됨",
  failed: "실패",
};

export function statusTone(status: BrowserRecordingSession["status"]): string {
  if (status === "recording") return "blue";
  if (status === "completed") return "green";
  if (status === "failed") return "red";
  return "muted";
}

interface DraftStepSummary {
  id: string;
  action: string;
  detail: string | null;
}

export interface DraftSummary {
  name: string;
  start: string | null;
  steps: DraftStepSummary[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(
  value: Record<string, unknown>,
  key: string,
): string | null {
  const field = value[key];
  return typeof field === "string" && field.trim().length > 0 ? field : null;
}

function draftActionLabel(action: string): string {
  if (action === "navigate") return "페이지 이동";
  if (action === "click") return "클릭";
  if (action === "input") return "입력";
  if (action === "select") return "선택";
  if (action === "submit") return "제출";
  if (action === "wait") return "대기";
  if (action === "act") return "녹화 동작";
  if (action === "observe") return "확인";
  if (action === "terminal:success") return "완료";
  if (action === "terminal:failure") return "실패";
  return "녹화 동작";
}

function firstAction(node: Record<string, unknown>): Record<string, unknown> | null {
  const what = Array.isArray(node.what) ? node.what : [];
  const first = what.find(isRecord);
  if (first !== undefined) return first;
  return stringField(node, "action") !== null ? node : null;
}

function draftStepDetail(action: Record<string, unknown>): string | null {
  const instruction = stringField(action, "instruction");
  if (instruction !== null) return instruction;
  const label = stringField(action, "label");
  if (label !== null) return label;
  const selectorKeys = ["element_key", "selector", "click_selector", "fill_selector", "select_selector"];
  if (selectorKeys.some((key) => stringField(action, key) !== null))
    return "화면에서 찾는 조건 사용";
  if (stringField(action, "url") !== null || stringField(action, "url_ref") !== null)
    return "페이지 이동 주소 사용";
  return null;
}

export function draftSummary(session: BrowserRecordingSession): DraftSummary {
  const draft = session.draft_ir;
  if (!isRecord(draft)) return { name: session.name, start: null, steps: [] };
  const meta = isRecord(draft.meta) ? draft.meta : null;
  const nodes = isRecord(draft.nodes) ? draft.nodes : {};
  const steps = Object.entries(nodes).flatMap(
    ([id, node]): DraftStepSummary[] => {
      if (!isRecord(node)) return [];
      const terminal = stringField(node, "terminal");
      const actionRecord = firstAction(node);
      const actionName = actionRecord !== null ? stringField(actionRecord, "action") : null;
      const action = draftActionLabel(
        actionName ??
          (terminal !== null ? `terminal:${terminal}` : "step"),
      );
      const args = actionRecord !== null && isRecord(actionRecord.args) ? actionRecord.args : {};
      const detail = actionRecord !== null ? draftStepDetail({ ...actionRecord, ...args }) : null;
      return [{ id, action, detail }];
    },
  );
  return {
    name: stringField(meta ?? {}, "name") ?? session.name,
    start: stringField(draft, "start"),
    steps,
  };
}

export function draftStartLabel(summary: DraftSummary): string {
  if (summary.start === null) return "-";
  const index = summary.steps.findIndex((step) => step.id === summary.start);
  return index >= 0 ? `${index + 1}번째` : "확인 필요";
}

export function idempotencyKey(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `browser-recorder-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
}

// 커서 페이지네이션 누적 — key 별로 중복 제거하며 append.
export function appendUniqueBy<T>(prev: readonly T[], next: readonly T[], keyOf: (item: T) => string): T[] {
  const seen = new Set(prev.map(keyOf));
  return [...prev, ...next.filter((item) => !seen.has(keyOf(item)))];
}

export function recordingIssueSummary(issue: BrowserRecordingValidationIssue): string {
  const text =
    `${issue.rule ?? ""} ${issue.code ?? ""} ${issue.detail ?? ""} ${issue.message ?? ""} ${issue.reason ?? ""}`.toLowerCase();
  if (text.includes("selector") || text.includes("element"))
    return "화면에서 찾는 조건을 확인하세요.";
  if (text.includes("target") || text.includes("node"))
    return "다음에 이어질 녹화 동작을 확인하세요.";
  if (text.includes("action")) return "녹화 동작을 확인하세요.";
  if (text.includes("url") || text.includes("navigate"))
    return "시작 주소 또는 페이지 이동 동작을 확인하세요.";
  return "녹화 결과를 확인하세요. 필요한 경우 화면 요소 저장소에서 화면에서 찾는 조건을 다시 확인하세요.";
}

export function recordedEventDetail(event: BrowserRecordingEvent): string {
  if (event.label !== null && event.label.trim() !== "") return event.label;
  if (event.url !== null && event.url.trim() !== "") return "페이지 이동 주소 사용";
  if (event.element_key !== null && event.element_key.trim() !== "") return "저장된 화면 설명 사용";
  return "화면에서 찾는 조건 사용";
}

export function queuedEventDetail(event: BrowserRecordingAppendEvent): string {
  if (event.label !== undefined && event.label.trim() !== "") return event.label;
  if (event.url !== undefined && event.url.trim() !== "") return "페이지 이동 주소 사용";
  if (event.element_key !== undefined && event.element_key.trim() !== "") return "저장된 화면 설명 사용";
  if (event.value_preview !== undefined && event.value_preview.trim() !== "") return "입력값 미리보기 사용";
  return "화면에서 찾는 조건 사용";
}

export function moveQueuedEvent(
  events: readonly BrowserRecordingAppendEvent[],
  from: number,
  to: number,
): BrowserRecordingAppendEvent[] {
  if (to < 0 || to >= events.length || from === to) return [...events];
  const next = [...events];
  const [item] = next.splice(from, 1);
  if (item === undefined) return next;
  next.splice(to, 0, item);
  return next;
}

export interface EventDraft {
  event_type: BrowserRecordingEventType;
  selector: string;
  element_key: string;
  label: string;
  url: string;
  value_preview: string;
}

export function cleanEvent(value: EventDraft, startUrlFallback = ""): BrowserRecordingAppendEvent {
  const url = value.url.trim() !== "" ? value.url.trim() : value.event_type === "navigate" ? startUrlFallback.trim() : "";
  return {
    event_type: value.event_type,
    ...(value.selector.trim() !== ""
      ? { selector: value.selector.trim() }
      : {}),
    ...(value.element_key.trim() !== ""
      ? { element_key: value.element_key.trim() }
      : {}),
    ...(value.label.trim() !== "" ? { label: value.label.trim() } : {}),
    ...(url !== "" ? { url } : {}),
    ...(value.value_preview.trim() !== ""
      ? { value_preview: value.value_preview.trim() }
      : {}),
  };
}

export function defaultStartUrlFromPattern(pattern: string | undefined): string {
  if (pattern === undefined || pattern.trim() === "") return "";
  try {
    return new URL(pattern).toString();
  } catch {
    return pattern;
  }
}

export function repositoryOptionLabel(item: SiteElementItem): string {
  return `${item.label} · ${repositoryMetaLabel(item)}`;
}

export function repositoryMetaLabel(item: SiteElementItem): string {
  return `${siteElementTypeLabel(item.element_type)} · ${siteElementStabilityLabel(item.stability)} · ${formatCount(item.usage_count)}회 사용`;
}

function siteElementTypeLabel(type: SiteElementItem["element_type"]): string {
  if (type === "button") return "버튼";
  if (type === "input") return "입력 필드";
  if (type === "link") return "링크";
  if (type === "table") return "테이블";
  if (type === "row") return "행";
  if (type === "field") return "데이터 필드";
  if (type === "message") return "메시지";
  return "기타";
}

function siteElementStabilityLabel(stability: SiteElementItem["stability"]): string {
  if (stability === "stable") return "안정";
  if (stability === "review_needed") return "검토 필요";
  return "재점검 필요";
}

function formatCount(value: number): string {
  return new Intl.NumberFormat("ko-KR").format(value);
}

export function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("ko-KR", { dateStyle: "short", timeStyle: "short" }).format(date);
}

export function agentApiBase(): string {
  const configured = import.meta.env.VITE_API_BASE_URL;
  if (typeof configured === "string" && /^https?:\/\//i.test(configured))
    return configured.replace(/\/+$/, "");
  return "http://127.0.0.1:3000";
}

export function psQuote(value: string): string {
  return `"${value.replace(/`/g, "``").replace(/"/g, '`"')}"`;
}
