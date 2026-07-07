// 사람 확인 업무 표시 헬퍼 — 접수번호/담당자/마감/만료 정책 라벨과 문서 검증(구조화 검토) 판별.

import type { HumanTaskItem } from "../../api/types";
import { formatDeadline } from "../../util/time";

export function dueTime(task: HumanTaskItem): number {
  return task.timeout !== null ? Date.parse(task.timeout) : Number.POSITIVE_INFINITY;
}

function shortRef(id: string): string {
  return id.slice(0, 8);
}

export function humanTaskRef(id: string): string {
  return `접수번호 #${shortRef(id)}`;
}

export function principalLabel(
  assignee: string | null,
  principalOptions: readonly { value: string; label?: string }[],
): string {
  if (assignee === null) return "미배정";
  const match = principalOptions.find((option) => option.value === assignee);
  if (match?.label !== undefined && match.label.trim() !== "") return match.label;
  return "담당자 정보 확인 필요";
}

export function timeoutActionLabel(value: string | null): string {
  switch (value) {
    case null:
      return "—";
    case "escalate":
      return "상위 담당자에게 이관";
    case "retry":
      return "자동 재검토";
    case "cancel":
      return "자동 종료";
    default:
      return "처리 정책 확인 필요";
  }
}

export function DeadlineText({ value }: { value: string | null | undefined }): JSX.Element {
  const deadline = formatDeadline(value);
  if (deadline.text === "-") return <span className="subtle">-</span>;
  if (deadline.overdue) return <span className="badge red" title={value ?? undefined}>{deadline.text}</span>;
  return <span title={value ?? undefined}>{deadline.text}</span>;
}

export function hasBusinessForm(task: HumanTaskItem): boolean {
  const schema = task.result_schema;
  return schema !== null && schema !== undefined && typeof schema === "object" && !Array.isArray(schema)
    && (schema as { version?: unknown }).version === "business_form_v1";
}

export function artifactCount(task: HumanTaskItem): number {
  return task.artifact_refs?.length ?? 0;
}

function hasStructuredResultSchema(task: HumanTaskItem): boolean {
  const schema = task.result_schema;
  if (schema === null || schema === undefined) return false;
  if (typeof schema !== "object" || Array.isArray(schema)) return true;
  return Object.keys(schema as Record<string, unknown>).length > 0;
}

export function requiresStructuredReviewInput(task: HumanTaskItem): boolean {
  return hasStructuredResultSchema(task) || artifactCount(task) > 0;
}

export function isDocumentValidationTask(task: HumanTaskItem): boolean {
  return task.kind === "validation" && (hasBusinessForm(task) || artifactCount(task) > 0);
}
