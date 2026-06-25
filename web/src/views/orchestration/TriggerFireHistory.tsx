import { navigate } from "../../router";
import type { RunTriggerFireItem } from "../../api/types";
import { detailPart, opsErrorCodeLabel, formatDateTime } from "./format";

export function TriggerFireHistory({
  fires,
  isLoading,
  isError,
}: {
  fires: readonly RunTriggerFireItem[];
  isLoading: boolean;
  isError: boolean;
}): JSX.Element {
  if (isError) {
    return <p className="empty-state">발화 이력을 불러오지 못했습니다.</p>;
  }
  if (isLoading) {
    return <p className="empty-state">발화 이력을 불러오는 중입니다.</p>;
  }
  if (fires.length === 0) {
    return <p className="empty-state">최근 발화 이력이 없습니다.</p>;
  }

  return (
    <table className="ops-table trigger-fire-table">
      <thead>
        <tr>
          <th scope="col">예정 시각</th>
          <th scope="col">결과</th>
          <th scope="col">실행</th>
          <th scope="col">사유</th>
          <th scope="col">작업</th>
        </tr>
      </thead>
      <tbody>
        {fires.map((fire) => {
          const runId = fire.run_id;
          return (
            <tr key={fire.fire_id}>
              <th scope="row">{formatDateTime(fire.scheduled_for)}</th>
              <td>
                <span className={`badge ${triggerFireStatusTone(fire.status)}`}>{triggerFireStatusLabel(fire.status)}</span>
              </td>
              <td>{runId !== null ? <span title={runId}>실행 연결됨</span> : <span className="subtle">미생성</span>}</td>
              <td>{triggerFireFailureLabel(fire.failure_reason)}</td>
              <td>
                {runId !== null ? (
                  <button className="linklike" type="button" onClick={() => navigate("runTrace", { run: runId })}>
                    실행 보기
                  </button>
                ) : (
                  <span className="subtle">-</span>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function triggerFireStatusTone(status: RunTriggerFireItem["status"]): "green" | "amber" | "red" {
  if (status === "queued") return "green";
  if (status === "skipped") return "amber";
  return "red";
}

function triggerFireStatusLabel(status: RunTriggerFireItem["status"]): string {
  if (status === "queued") return "실행 생성";
  if (status === "skipped") return "건너뜀";
  return "실패";
}

function triggerFireFailureLabel(reason: RunTriggerFireItem["failure_reason"]): string {
  if (reason === null) return "-";
  const codeLabel = opsErrorCodeLabel(reason.code);
  const details = reason.details;
  if (details === null || typeof details !== "object" || Array.isArray(details)) return codeLabel;
  const record = details as Record<string, unknown>;
  const parts = [
    detailPart("reason", record.reason),
    detailPart("field", record.field),
    detailPart("detail", record.detail),
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? `${codeLabel} (${parts.join(" · ")})` : codeLabel;
}
