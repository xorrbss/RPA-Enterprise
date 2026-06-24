// Orchestration 트리거 타입·표시/폼 헬퍼 — 뷰·TriggerScheduler·폼이 공유한다.
import type { ApiClient } from "../../api/client";
import type { OpsAlertSeverity, OpsAlertSource, RunTriggerItem, ScenarioItem } from "../../api/types";
import { formatDateTime } from "./format";

export type Cadence = "daily" | "weekly" | "monthly";
export type TriggerMode = "cron" | "webhook";
export type AlertSeverityFilter = OpsAlertSeverity | "all";
export type AlertSourceFilter = OpsAlertSource | "all";
export type ScenarioPickerPage = { readonly items: readonly ScenarioItem[]; readonly truncated: boolean };

export function countLabel(count: number | undefined): string {
  return count === undefined ? "-" : String(count);
}

export function scenarioLabel(scenario: ScenarioItem): string {
  return `${scenario.name} · 변경 ${scenario.version}`;
}

export async function listScenarioPicker(api: ApiClient): Promise<ScenarioPickerPage> {
  let cursor: string | undefined;
  const items: ScenarioItem[] = [];
  for (let page = 0; page < 10; page += 1) {
    const result = await api.listScenarios({ limit: 50, ...(cursor !== undefined ? { cursor } : {}) });
    items.push(...result.items);
    if (result.next_cursor === null) return { items, truncated: false };
    cursor = result.next_cursor;
  }
  return { items, truncated: true };
}

export function idempotencyKey(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function cronFrom(cadence: Cadence, time: string): string {
  const [hour = "9", minute = "0"] = time.split(":");
  if (cadence === "weekly") return `${Number(minute)} ${Number(hour)} * * 1`;
  if (cadence === "monthly") return `${Number(minute)} ${Number(hour)} 1 * *`;
  return `${Number(minute)} ${Number(hour)} * * *`;
}

export function concurrencyFrom(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(1, Math.min(20, Math.trunc(value)));
}

export function canSaveTriggerEdit(trigger: RunTriggerItem, cronExpression: string, timezone: string, webhookSecretRef: string): boolean {
  if (trigger.trigger_type === "webhook") return webhookSecretRef.trim().length > 0;
  return cronExpression.trim().length > 0 && timezone.trim().length > 0;
}

export function secretRefToDisplay(value: string | null): string {
  if (value === null) return "";
  return value.startsWith("secret://") ? value.slice("secret://".length) : value;
}

export function displayToSecretRef(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("secret://")) return trimmed;
  return `secret://${trimmed}`;
}

export function triggerSummary(trigger: RunTriggerItem): string {
  if (trigger.trigger_type === "webhook") return "외부 이벤트";
  return humanCronSummary(trigger.cron_expression);
}

export function triggerSecondary(trigger: RunTriggerItem): string {
  if (trigger.trigger_type === "webhook") return trigger.webhook_secret_ref !== null || trigger.webhook_secret_configured === true ? "보안 키 연결됨" : "보안 키 미설정";
  return trigger.timezone !== null ? `${trigger.timezone} 기준` : "시간대 미설정";
}

export function nextFireLabel(trigger: RunTriggerItem): string {
  if (trigger.trigger_type === "webhook") return "이벤트 수신 시";
  if (trigger.status === "enabled" && trigger.next_fire_at === null) return "스케줄러 확인 필요";
  return formatDateTime(trigger.next_fire_at);
}

function humanCronSummary(cronExpression: string | null): string {
  if (cronExpression === null) return "예약 실행";
  const parts = cronExpression.trim().split(/\s+/);
  if (parts.length !== 5) return "고급 예약";
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts as [string, string, string, string, string];
  if (!/^\d+$/.test(minute) || !/^\d+$/.test(hour)) return "고급 예약";
  const minuteNumber = Number(minute);
  const hourNumber = Number(hour);
  if (minuteNumber < 0 || minuteNumber > 59 || hourNumber < 0 || hourNumber > 23) return "고급 예약";
  const time = `${String(hourNumber).padStart(2, "0")}:${String(minuteNumber).padStart(2, "0")}`;
  if (month === "*" && dayOfMonth === "*" && dayOfWeek === "*") return `매일 ${time}`;
  if (month === "*" && dayOfMonth === "*" && dayOfWeek === "1-5") return `평일 ${time}`;
  if (month === "*" && dayOfMonth === "*" && /^\d+$/.test(dayOfWeek)) return `매주 ${weekdayLabel(Number(dayOfWeek))} ${time}`;
  if (month === "*" && /^\d+$/.test(dayOfMonth) && dayOfWeek === "*") return `매월 ${Number(dayOfMonth)}일 ${time}`;
  return "고급 예약";
}

function weekdayLabel(day: number): string {
  const labels = ["일요일", "월요일", "화요일", "수요일", "목요일", "금요일", "토요일"];
  return labels[day] ?? "지정 요일";
}

export function statusLabel(value: RunTriggerItem["status"]): string {
  if (value === "paused") return "일시정지";
  if (value === "archived") return "보관됨";
  return "사용 중";
}

export function catchupPolicyLabel(policy: RunTriggerItem["catchup_policy"]): string {
  if (policy === "fire_once") return "순차 보강";
  return "건너뛰기";
}
