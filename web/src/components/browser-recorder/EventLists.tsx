import type { BrowserRecordingAppendEvent, BrowserRecordingEvent } from "../../api/types";
import { ErrorState, Loading } from "../states";
import { EVENT_LABEL, queuedEventDetail, recordedEventDetail } from "./helpers";

export function EventList(props: {
  events: readonly BrowserRecordingEvent[];
  loading: boolean;
  error: boolean;
  hasMore: boolean;
  fetchingMore: boolean;
  onRetry: () => void;
  onLoadMore: () => void;
}): JSX.Element {
  if (props.loading) return <Loading />;
  if (props.error)
    return (
      <ErrorState
        message="녹화 동작 목록을 불러오지 못했습니다."
        onRetry={props.onRetry}
      />
    );
  const { events } = props;
  if (events.length === 0)
    return <p className="empty-state">아직 추가된 녹화 동작이 없습니다.</p>;
  return (
    <>
      <ol className="browser-recorder-event-list">
        {events.map((event) => (
          <li key={event.event_id}>
            <span className="badge muted">{event.seq}</span>
            <strong>{EVENT_LABEL[event.event_type]}</strong>
            <span>{recordedEventDetail(event)}</span>
          </li>
        ))}
      </ol>
      {props.hasMore && (
        <div className="list-pager">
          <button className="btn" type="button" disabled={props.fetchingMore} onClick={props.onLoadMore}>
            {props.fetchingMore ? "불러오는 중" : "동작 더 보기"}
          </button>
        </div>
      )}
    </>
  );
}

export function QueuedEventList(props: {
  events: readonly BrowserRecordingAppendEvent[];
  saving: boolean;
  onMove: (from: number, to: number) => void;
  onRemove: (index: number) => void;
  onSave: () => void;
}): JSX.Element | null {
  if (props.events.length === 0) return null;
  return (
    <div className="browser-recorder-queued-events" aria-label="임시 녹화 동작 목록">
      <div className="browser-recorder-queued-head">
        <strong>임시 동작 목록</strong>
        <span className="subtle">저장 전에 순서 조정과 삭제가 가능합니다.</span>
        <button className="btn primary" type="button" disabled={props.saving} onClick={props.onSave}>
          {props.saving ? "추가 중" : `${props.events.length}개 동작 추가`}
        </button>
      </div>
      <ol className="browser-recorder-event-list">
        {props.events.map((event, index) => (
          <li key={`${event.event_type}-${index}`}>
            <span className="badge muted">{index + 1}</span>
            <strong>{EVENT_LABEL[event.event_type]}</strong>
            <span>{queuedEventDetail(event)}</span>
            <span className="browser-recorder-event-actions">
              <button className="btn" type="button" disabled={index === 0} onClick={() => props.onMove(index, index - 1)}>위로</button>
              <button className="btn" type="button" disabled={index === props.events.length - 1} onClick={() => props.onMove(index, index + 1)}>아래로</button>
              <button className="btn" type="button" onClick={() => props.onRemove(index)}>삭제</button>
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
