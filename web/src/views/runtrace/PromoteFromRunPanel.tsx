import { errorLabel } from "../../components/badges";
import type { PromoteFromRunResult } from "../../api/types";

function promotionSkipLabel(reason: string): string {
  switch (reason) {
    case "multi_act_node_ambiguous":
      return "한 노드에 여러 동작이 있어 자동 승격하지 않았습니다.";
    case "node_not_found":
      return "원본 노드를 찾지 못했습니다.";
    case "node_what_missing":
      return "노드 동작 정의가 없어 승격하지 않았습니다.";
    case "no_promotable_act":
      return "승격할 수 있는 동작이 없습니다.";
    case "fill_no_value_source":
      return "입력값 출처가 없어 fill 셀렉터를 고정하지 않았습니다.";
    case "fill_already_deterministic":
      return "이미 결정형 입력으로 구성되어 있습니다.";
    case "unsupported_operation":
      return "지원하지 않는 동작 유형입니다.";
    default:
      return reason;
  }
}

export function PromoteFromRunPanel({
  status,
  scenarioId,
  allowed,
  mutation,
  onPromote,
}: {
  status: string;
  scenarioId: string | null;
  allowed: boolean;
  onPromote: () => void;
  mutation: {
    readonly isPending: boolean;
    readonly isError: boolean;
    readonly error: unknown;
    readonly data: PromoteFromRunResult | undefined;
  };
}): JSX.Element | null {
  if (status !== "completed" || !allowed) return null;
  const result = mutation.data;
  return (
    <div className="pbd-promotion" role="region" aria-label="성공 실행 봇 승격">
      <div>
        <strong>성공 실행을 봇으로 굳히기</strong>
        <p className="subtle">
          이번 실행에서 검증된 클릭·입력·선택 동작을 새 초안 버전에 반영합니다.
        </p>
      </div>
      <button
        className="btn primary"
        type="button"
        onClick={onPromote}
        disabled={scenarioId === null || mutation.isPending || result !== undefined}
      >
        {mutation.isPending
          ? "승격 중"
          : result !== undefined
            ? "이미 초안으로 굳힘"
            : "이 실행을 봇으로 굳히기"}
      </button>
      {scenarioId === null && (
        <span className="badge amber">자동화 연결 정보 없음</span>
      )}
      {mutation.isError && (
        <div className="form-alert red" role="alert">
          {errorLabel(mutation.error)}
        </div>
      )}
      {result !== undefined && (
        <div className="pbd-result" role="status">
          <span className="badge green">초안 변경 {result.version} 생성</span>
          <span className="subtle">
            초안 참조 번호 {result.scenario_version_id.slice(0, 8)}
          </span>
          <span className="subtle">
            자동화 단계 {result.promoted_node_ids.length}개 반영
          </span>
          {result.skipped.length > 0 && (
            <span className="badge amber">
              검토 필요 {result.skipped.length}개
            </span>
          )}
          {(result.promoted_node_ids.length > 0 ||
            result.skipped.length > 0) && (
            <details className="developer-details">
              <summary>반영 기준 보기</summary>
              {result.promoted_node_ids.length > 0 && (
                <p className="subtle" style={{ margin: "8px 0 4px" }}>
                  원문 단계 참조: {result.promoted_node_ids.slice(0, 8).join(", ")}
                  {result.promoted_node_ids.length > 8 ? "..." : ""}
                </p>
              )}
              {result.skipped.length > 0 && (
                <ul className="pbd-skip-list">
                  {result.skipped.slice(0, 4).map((item) => (
                    <li key={`${item.nodeId}:${item.reason}`}>
                      <code>{item.nodeId}</code>{" "}
                      {promotionSkipLabel(item.reason)}
                    </li>
                  ))}
                </ul>
              )}
            </details>
          )}
        </div>
      )}
    </div>
  );
}
