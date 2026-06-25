import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useApiClient } from "../../api/context";
import type { BrowserRecordingAppendEvent, BrowserRecordingEvent, BrowserRecordingSession, SiteElementItem } from "../../api/types";
import { errorLabel } from "../badges";
import { AgentLaunchCommand } from "./AgentLaunchCommand";
import { EventForm } from "./EventForm";
import { EventList, QueuedEventList } from "./EventLists";
import {
  STATUS_LABEL,
  appendUniqueBy,
  cleanEvent,
  idempotencyKey,
  moveQueuedEvent,
  statusTone,
  type EventDraft,
} from "./helpers";

type RecorderMessage = { tone: "green" | "red"; text: string };

// 녹화 동작 기록 기능(동작 폼 + 임시 목록 + 추가/완료 + 동작·화면설명 페이지네이션) — fireTriggerId 류로 묶인 응집 단위를
//   BrowserRecorderPanel 에서 분리. 낙관적 세션(localSession)·완료 콜백·메시지는 상위가 소유하므로 prop 으로 받는다.
export function RecordingWorkbench({
  siteId,
  selectedRecordingId,
  selectedSession,
  startUrl,
  canRecord,
  setLocalSession,
  onMessage,
  onCompleted,
}: {
  siteId: string;
  selectedRecordingId: string | null;
  selectedSession: BrowserRecordingSession | null;
  startUrl: string;
  canRecord: boolean;
  setLocalSession: Dispatch<SetStateAction<BrowserRecordingSession | null>>;
  onMessage: (message: RecorderMessage) => void;
  onCompleted: (session: BrowserRecordingSession) => void;
}): JSX.Element {
  const api = useApiClient();
  const qc = useQueryClient();
  const [eventDraft, setEventDraft] = useState<EventDraft>({
    event_type: "click",
    selector: "",
    element_key: "",
    label: "",
    url: "",
    value_preview: "",
  });
  const [queuedEvents, setQueuedEvents] = useState<BrowserRecordingAppendEvent[]>([]);
  const [eventCursor, setEventCursor] = useState<string | null>(null);
  const [nextEventCursor, setNextEventCursor] = useState<string | null>(null);
  const [loadedEvents, setLoadedEvents] = useState<BrowserRecordingEvent[]>([]);
  const [repositoryElementCursor, setRepositoryElementCursor] = useState<string | null>(null);
  const [nextRepositoryElementCursor, setNextRepositoryElementCursor] = useState<string | null>(null);
  const [loadedRepositoryElements, setLoadedRepositoryElements] = useState<SiteElementItem[]>([]);

  const eventsQuery = useQuery({
    queryKey: ["browser-recording-events", siteId, selectedRecordingId, eventCursor],
    queryFn: () =>
      api.listBrowserRecordingEvents(siteId, selectedRecordingId as string, {
        limit: 100,
        ...(eventCursor !== null ? { cursor: eventCursor } : {}),
      }),
    enabled: siteId !== "" && selectedRecordingId !== null,
  });
  const hasMoreEvents = nextEventCursor !== null;
  const isFetchingMoreEvents = eventsQuery.isFetching && eventCursor !== null;

  const siteElementsQuery = useQuery({
    queryKey: ["site-elements", "browser-recorder", siteId, repositoryElementCursor],
    queryFn: () => api.listSiteElements(siteId, { limit: 100, ...(repositoryElementCursor !== null ? { cursor: repositoryElementCursor } : {}) }),
    enabled: siteId !== "",
  });
  const hasMoreRepositoryElements = nextRepositoryElementCursor !== null;
  const isFetchingMoreRepositoryElements = siteElementsQuery.isFetching && repositoryElementCursor !== null;

  useEffect(() => {
    setEventCursor(null);
    setNextEventCursor(null);
    setLoadedEvents([]);
  }, [selectedRecordingId, siteId]);

  useEffect(() => {
    if (eventsQuery.data === undefined) return;
    setLoadedEvents((prev) => eventCursor === null ? [...eventsQuery.data.items] : appendUniqueBy(prev, eventsQuery.data.items, (i) => i.event_id));
    setNextEventCursor(eventsQuery.data.next_cursor);
  }, [eventCursor, eventsQuery.data]);

  useEffect(() => {
    setRepositoryElementCursor(null);
    setNextRepositoryElementCursor(null);
    setLoadedRepositoryElements([]);
  }, [siteId]);

  useEffect(() => {
    if (siteElementsQuery.data === undefined) return;
    setLoadedRepositoryElements((prev) => repositoryElementCursor === null ? [...siteElementsQuery.data.items] : appendUniqueBy(prev, siteElementsQuery.data.items, (i) => i.element_id));
    setNextRepositoryElementCursor(siteElementsQuery.data.next_cursor);
  }, [repositoryElementCursor, siteElementsQuery.data]);

  useEffect(() => {
    setQueuedEvents([]);
  }, [selectedRecordingId, siteId]);

  function refreshEventsAfterAppend(recordingSessionId: string, eventCount: number): void {
    setLocalSession((session) =>
      session !== null && session.recording_session_id === recordingSessionId
        ? { ...session, event_count: eventCount }
        : session,
    );
    setEventCursor(null);
    setNextEventCursor(null);
    void api.listBrowserRecordingEvents(siteId, recordingSessionId, { limit: 100 }).then((page) => {
      setLoadedEvents([...page.items]);
      setNextEventCursor(page.next_cursor);
    }).catch(() => undefined);
    void qc.invalidateQueries({ queryKey: ["browser-recording-events", siteId, selectedRecordingId] });
    void qc.invalidateQueries({ queryKey: ["browser-recordings", siteId] });
  }

  const appendMutation = useMutation({
    mutationFn: () => {
      if (selectedSession === null) throw new Error("recording_required");
      return api.appendBrowserRecordingEvents(
        siteId,
        selectedSession.recording_session_id,
        { events: [cleanEvent(eventDraft, startUrl)] },
        idempotencyKey(),
      );
    },
    onSuccess: (result) => {
      setEventDraft((prev) => ({ ...prev, selector: "", element_key: "", label: "", url: "", value_preview: "" }));
      onMessage({ tone: "green", text: "녹화 동작을 추가했습니다." });
      refreshEventsAfterAppend(result.recording_session_id, result.event_count);
    },
    onError: (error) => onMessage({ tone: "red", text: errorLabel(error) }),
  });

  const appendQueuedMutation = useMutation({
    mutationFn: () => {
      if (selectedSession === null) throw new Error("recording_required");
      if (queuedEvents.length === 0) throw new Error("events_required");
      return api.appendBrowserRecordingEvents(
        siteId,
        selectedSession.recording_session_id,
        { events: queuedEvents },
        idempotencyKey(),
      );
    },
    onSuccess: (result) => {
      const count = queuedEvents.length;
      setQueuedEvents([]);
      onMessage({ tone: "green", text: `임시 동작 ${count}개를 녹화에 추가했습니다.` });
      refreshEventsAfterAppend(result.recording_session_id, result.event_count);
    },
    onError: (error) => onMessage({ tone: "red", text: errorLabel(error) }),
  });

  const completeMutation = useMutation({
    mutationFn: () => {
      if (selectedSession === null) throw new Error("recording_required");
      return api.completeBrowserRecording(siteId, selectedSession.recording_session_id, idempotencyKey());
    },
    onSuccess: (session) => {
      setLocalSession(session);
      onCompleted(session);
      onMessage({ tone: "green", text: "녹화를 완료하고 자동화 초안을 만들었습니다." });
      void qc.invalidateQueries({ queryKey: ["browser-recordings", siteId] });
    },
    onError: (error) => onMessage({ tone: "red", text: errorLabel(error) }),
  });

  const elementKeyValid =
    eventDraft.element_key.trim() === "" ||
    /^[A-Za-z][A-Za-z0-9_]{1,63}$/.test(eventDraft.element_key.trim());
  const cleanedEventDraft = cleanEvent(eventDraft, startUrl);
  const eventNeedsSelector = !["navigate", "wait"].includes(cleanedEventDraft.event_type);
  const eventValid =
    elementKeyValid &&
    selectedSession?.status === "recording" &&
    (cleanedEventDraft.event_type === "navigate"
      ? cleanedEventDraft.url !== undefined
      : eventNeedsSelector
        ? eventDraft.selector.trim() !== ""
        : true);
  const recordedEventCount = Math.max(selectedSession?.event_count ?? 0, loadedEvents.length);

  return (
    <section className="browser-recorder-workbench" aria-label="브라우저 녹화 동작 추가">
      <div className="panel-head compact">
        <h3>녹화 동작</h3>
        {selectedSession !== null && (
          <span className={`badge ${statusTone(selectedSession.status)}`}>
            {STATUS_LABEL[selectedSession.status]}
          </span>
        )}
      </div>
      {selectedSession === null ? (
        <p className="empty-state">녹화 기록을 선택하거나 새로 시작하세요.</p>
      ) : (
        <>
          <AgentLaunchCommand siteId={siteId} session={selectedSession} />
          <EventForm
            value={eventDraft}
            onChange={setEventDraft}
            startUrl={startUrl}
            repositoryElements={loadedRepositoryElements}
            disabled={selectedSession.status !== "recording"}
          />
          {hasMoreRepositoryElements && (
            <span className="badge amber">화면 설명 100건 기준</span>
          )}
          {hasMoreRepositoryElements && (
            <button className="btn" type="button" disabled={isFetchingMoreRepositoryElements} onClick={() => setRepositoryElementCursor(nextRepositoryElementCursor)}>
              {isFetchingMoreRepositoryElements ? "불러오는 중" : "화면 설명 더 보기"}
            </button>
          )}
          {!elementKeyValid && (
            <span className="badge amber">저장된 화면 설명을 다시 선택해 주세요.</span>
          )}
          <div className="browser-recorder-actions">
            <button
              className="btn"
              type="button"
              disabled={!canRecord || !eventValid}
              onClick={() => {
                setQueuedEvents((events) => [...events, cleanEvent(eventDraft, startUrl)]);
                setEventDraft((prev) => ({ ...prev, selector: "", element_key: "", label: "", url: "", value_preview: "" }));
                onMessage({ tone: "green", text: "동작 초안을 임시 목록에 담았습니다." });
              }}
            >
              임시 목록에 담기
            </button>
            <button
              className="btn"
              type="button"
              disabled={!canRecord || !eventValid || appendMutation.isPending}
              onClick={() => appendMutation.mutate()}
            >
              동작 추가
            </button>
            <button
              className="btn primary"
              type="button"
              disabled={
                !canRecord ||
                selectedSession.status !== "recording" ||
                queuedEvents.length > 0 ||
                recordedEventCount === 0 ||
                completeMutation.isPending
              }
              onClick={() => completeMutation.mutate()}
            >
              녹화 완료
            </button>
            {selectedSession.status === "recording" && queuedEvents.length > 0 && (
              <span className="badge amber">임시 목록을 먼저 추가하세요</span>
            )}
            {selectedSession.status === "recording" && queuedEvents.length === 0 && recordedEventCount === 0 && (
              <span className="badge amber">녹화 동작을 먼저 추가하세요</span>
            )}
          </div>
          <QueuedEventList
            events={queuedEvents}
            saving={appendQueuedMutation.isPending}
            onMove={(from, to) => setQueuedEvents((events) => moveQueuedEvent(events, from, to))}
            onRemove={(index) => setQueuedEvents((events) => events.filter((_event, eventIndex) => eventIndex !== index))}
            onSave={() => appendQueuedMutation.mutate()}
          />
          <EventList
            events={loadedEvents}
            loading={eventsQuery.isLoading}
            error={eventsQuery.isError}
            hasMore={hasMoreEvents}
            fetchingMore={isFetchingMoreEvents}
            onRetry={() => void eventsQuery.refetch()}
            onLoadMore={() => setEventCursor(nextEventCursor)}
          />
        </>
      )}
    </section>
  );
}
