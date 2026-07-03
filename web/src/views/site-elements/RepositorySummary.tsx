import type { SiteElementItem } from "../../api/types";
import { PROBE_LABEL, STABILITY_LABEL, formatCount, type BulkProbeState } from "./helpers";

export function RepositorySummary(props: {
  total: number;
  usageTotal: number;
  reviewCount: number;
  brokenCount: number;
  hasMore: boolean;
  priority: readonly SiteElementItem[];
  bulkProbe: BulkProbeState | null;
  bulkDisabled: boolean;
  onBulkProbe: () => void;
  onSelect: (elementId: string) => void;
}): JSX.Element {
  const unstableCount = props.reviewCount + props.brokenCount;
  return (
    <div className="object-repo-summary-wrap">
      <section className="object-repo-summary" aria-label="저장소 유지보수 요약">
        <div>
          <span>등록 요소</span>
          <strong>{formatCount(props.total)}{props.hasMore ? "+" : ""}</strong>
          {props.hasMore && <small>현재 표시 기준</small>}
        </div>
        <div>
          <span>점검 필요</span>
          <strong>{formatCount(unstableCount)}</strong>
          <small>검토 {formatCount(props.reviewCount)} · 재점검 {formatCount(props.brokenCount)}</small>
        </div>
        <div>
          <span>누적 사용</span>
          <strong>{formatCount(props.usageTotal)}</strong>
        </div>
      </section>
      <section className="object-repo-bulk" aria-label="현재 목록 재검증">
        <div>
          <strong>현재 목록 재검증</strong>
          <span className="subtle">
            {props.bulkProbe?.running === true
              ? `${formatCount(props.bulkProbe.checked)} / ${formatCount(props.bulkProbe.total)}건 진행 중`
              : `${formatCount(props.total)}건의 현재 표시 목록을 샘플 주소 기준으로 점검합니다.`}
          </span>
        </div>
        <button className="btn" type="button" disabled={props.bulkDisabled || props.bulkProbe?.running === true} onClick={props.onBulkProbe}>
          {props.bulkProbe?.running === true ? "재검증 중" : "현재 목록 재검증"}
        </button>
        {props.bulkProbe !== null && (
          <div className="object-repo-bulk-result" role="status">
            <span className="badge green">검증됨 {formatCount(props.bulkProbe.matched)}건</span>
            <span className="badge amber">확인 필요 {formatCount(props.bulkProbe.attention)}건</span>
            <span className="badge red">실패 {formatCount(props.bulkProbe.failed)}건</span>
            {props.bulkProbe.results.slice(0, 3).map((result) => (
              <small key={`${result.label}-${result.status}-${result.reason}`}>
                {result.label} · {PROBE_LABEL[result.status]} · {result.reason}
              </small>
            ))}
          </div>
        )}
      </section>
      {props.priority.length > 0 ? (
        <section className="object-repo-priority" aria-label="우선 점검 요소">
          <strong>우선 점검</strong>
          {props.priority.map((element) => (
            <button key={element.element_id} className="object-repo-priority-item" type="button" onClick={() => props.onSelect(element.element_id)}>
              <span>{element.label}</span>
              <small title="여러 자동화에서 재사용되는 화면 요소입니다.">업무 식별명 · {formatCount(element.usage_count)}회 · {STABILITY_LABEL[element.stability]}</small>
            </button>
          ))}
        </section>
      ) : (
        <p className="catalog-status-note">점검 필요한 저장소 요소가 없습니다.</p>
      )}
    </div>
  );
}
