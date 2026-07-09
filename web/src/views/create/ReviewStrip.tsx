import { mergeParams, navigate } from "../../router";
import { StatusBadge, kindLabel } from "../../components/badges";
import type { HumanTaskItem } from "../../api/types";
import { isSimpleGate, taskTitle, useMyReviewQueue } from "./review-queue";

// E1: 만들기 홈 상단 확인 스트립 — 내게 확인이 필요한 업무가 있을 때만 컴팩트하게 노출(빈 상태 미렌더).
// 데이터·판정은 useMyReviewQueue(구 MyWork 큐 로직) 공유. 처리 자체는 사람 확인 화면이 담당(딥링크).
export function ReviewStrip(): JSX.Element | null {
  const queue = useMyReviewQueue();
  if (queue.tasks.length === 0) return null;
  return (
    <section className="panel review-strip" aria-label="지금 확인이 필요한 업무">
      <div className="review-strip-head">
        <strong>지금 확인이 필요합니다 ({queue.tasks.length})</strong>
        <button className="linklike" type="button" onClick={() => navigate("humanTasks")}>사람 확인 전체 →</button>
      </div>
      <ul className="review-strip-list">
        {queue.tasks.slice(0, 3).map((t: HumanTaskItem) => {
          const title = taskTitle(t);
          return (
            <li key={t.human_task_id}>
              <span className="review-strip-title">{title}</span>
              <span className="subtle review-strip-meta">
                {/* 제목이 종류 폴백이면 부제에 같은 문자열을 반복하지 않는다(E1 수용 기준 — 감사 P2). */}
                {title !== kindLabel(t.kind) && <span>{kindLabel(t.kind)}</span>}
                <StatusBadge status={t.state} />
                <span>{t.assignee !== null ? "나에게 배정" : "미배정"}</span>
              </span>
              <button
                className="btn primary"
                type="button"
                onClick={() => {
                  navigate("humanTasks");
                  mergeParams({ ht: t.human_task_id });
                }}
              >
                {isSimpleGate(t.kind) ? "처리하기" : "검토 열기"}
              </button>
            </li>
          );
        })}
      </ul>
      {queue.tasks.length > 3 && (
        <p className="subtle review-strip-more">외 {queue.tasks.length - 3}건 — 사람 확인에서 전체를 확인하세요.</p>
      )}
    </section>
  );
}
