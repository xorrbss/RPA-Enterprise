import { useEffect, useMemo, useState } from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

import { useApiClient } from "../api/context";
import { useCan } from "../api/permissions";
import type {
  BrowserRecordingAppendEvent,
  BrowserRecordingEvent,
  BrowserRecordingEventType,
  BrowserRecordingSession,
  BrowserRecordingValidationIssue,
  ScenarioMutationResult,
  SiteElementItem,
  SiteItem,
} from "../api/types";
import { navigate } from "../router";
import { errorLabel } from "./badges";
import { ErrorState, Loading } from "./states";

const EVENT_TYPES: readonly BrowserRecordingEventType[] = [
  "navigate",
  "click",
  "input",
  "select",
  "submit",
  "wait",
];

const EVENT_LABEL: Record<BrowserRecordingEventType, string> = {
  navigate: "페이지 이동",
  click: "클릭",
  input: "입력",
  select: "선택",
  submit: "제출",
  wait: "대기",
};

const STATUS_LABEL: Record<BrowserRecordingSession["status"], string> = {
  recording: "녹화 중",
  completed: "자동화 준비",
  discarded: "폐기됨",
  failed: "실패",
};

function statusTone(status: BrowserRecordingSession["status"]): string {
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

interface DraftSummary {
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

function draftSummary(session: BrowserRecordingSession): DraftSummary {
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

function draftStartLabel(summary: DraftSummary): string {
  if (summary.start === null) return "-";
  const index = summary.steps.findIndex((step) => step.id === summary.start);
  return index >= 0 ? `${index + 1}번째` : "확인 필요";
}

function idempotencyKey(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `browser-recorder-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
}

function appendUniqueSessions(prev: readonly BrowserRecordingSession[], next: readonly BrowserRecordingSession[]): BrowserRecordingSession[] {
  const seen = new Set(prev.map((item) => item.recording_session_id));
  return [...prev, ...next.filter((item) => !seen.has(item.recording_session_id))];
}

function appendUniqueBrowserSites(prev: readonly SiteItem[], next: readonly SiteItem[]): SiteItem[] {
  const seen = new Set(prev.map((item) => item.site_profile_id));
  return [...prev, ...next.filter((item) => !seen.has(item.site_profile_id))];
}

function appendUniqueEvents(prev: readonly BrowserRecordingEvent[], next: readonly BrowserRecordingEvent[]): BrowserRecordingEvent[] {
  const seen = new Set(prev.map((item) => item.event_id));
  return [...prev, ...next.filter((item) => !seen.has(item.event_id))];
}

function appendUniqueSiteElements(prev: readonly SiteElementItem[], next: readonly SiteElementItem[]): SiteElementItem[] {
  const seen = new Set(prev.map((item) => item.element_id));
  return [...prev, ...next.filter((item) => !seen.has(item.element_id))];
}

export function BrowserRecorderPanel(): JSX.Element {
  const api = useApiClient();
  const can = useCan();
  const qc = useQueryClient();
  const canRecord = can("site.update");
  const [siteId, setSiteId] = useState("");
  const [name, setName] = useState("브라우저 녹화 자동화");
  const [startUrl, setStartUrl] = useState("");
  const [startUrlTouched, setStartUrlTouched] = useState(false);
  const [selectedRecordingId, setSelectedRecordingId] = useState<string | null>(
    null,
  );
  const [localSession, setLocalSession] =
    useState<BrowserRecordingSession | null>(null);
  const [completedDraft, setCompletedDraft] =
    useState<BrowserRecordingSession | null>(null);
  const [savedScenario, setSavedScenario] =
    useState<ScenarioMutationResult | null>(null);
  const [eventDraft, setEventDraft] = useState({
    event_type: "click" as BrowserRecordingEventType,
    selector: "",
    element_key: "",
    label: "",
    url: "",
    value_preview: "",
  });
  const [queuedEvents, setQueuedEvents] = useState<BrowserRecordingAppendEvent[]>([]);
  const [message, setMessage] = useState<{
    tone: "green" | "red";
    text: string;
  } | null>(null);
  const [browserSiteCursor, setBrowserSiteCursor] = useState<string | null>(null);
  const [nextBrowserSiteCursor, setNextBrowserSiteCursor] = useState<string | null>(null);
  const [loadedBrowserSites, setLoadedBrowserSites] = useState<SiteItem[]>([]);
  const [recordingCursor, setRecordingCursor] = useState<string | null>(null);
  const [nextRecordingCursor, setNextRecordingCursor] = useState<string | null>(null);
  const [loadedRecordings, setLoadedRecordings] = useState<BrowserRecordingSession[]>([]);
  const [eventCursor, setEventCursor] = useState<string | null>(null);
  const [nextEventCursor, setNextEventCursor] = useState<string | null>(null);
  const [loadedEvents, setLoadedEvents] = useState<BrowserRecordingEvent[]>([]);
  const [repositoryElementCursor, setRepositoryElementCursor] = useState<string | null>(null);
  const [nextRepositoryElementCursor, setNextRepositoryElementCursor] = useState<string | null>(null);
  const [loadedRepositoryElements, setLoadedRepositoryElements] = useState<SiteElementItem[]>([]);

  const sitesQuery = useQuery({
    queryKey: ["sites", "browser-recorder", browserSiteCursor],
    queryFn: () => api.listSites({ limit: 100, ...(browserSiteCursor !== null ? { cursor: browserSiteCursor } : {}) }),
  });
  const sites = loadedBrowserSites;
  const hasMoreBrowserSites = nextBrowserSiteCursor !== null;

  useEffect(() => {
    if (sitesQuery.data === undefined) return;
    setLoadedBrowserSites((prev) => browserSiteCursor === null ? [...sitesQuery.data.items] : appendUniqueBrowserSites(prev, sitesQuery.data.items));
    setNextBrowserSiteCursor(sitesQuery.data.next_cursor);
  }, [browserSiteCursor, sitesQuery.data]);

  useEffect(() => {
    if (siteId === "" && sites[0] !== undefined)
      setSiteId(sites[0].site_profile_id);
  }, [siteId, sites]);

  const selectedSite = useMemo(
    () => sites.find((site) => site.site_profile_id === siteId) ?? null,
    [siteId, sites],
  );

  useEffect(() => {
    if (!startUrlTouched) setStartUrl(defaultStartUrlFromPattern(selectedSite?.url_pattern));
  }, [selectedSite?.url_pattern, startUrlTouched]);

  const recordingsQuery = useQuery({
    queryKey: ["browser-recordings", siteId, recordingCursor],
    queryFn: () => api.listBrowserRecordings(siteId, { limit: 20, ...(recordingCursor !== null ? { cursor: recordingCursor } : {}) }),
    enabled: siteId !== "",
  });
  const hasMoreRecordings = nextRecordingCursor !== null;
  const isFetchingMoreRecordings = recordingsQuery.isFetching && recordingCursor !== null;

  useEffect(() => {
    setRecordingCursor(null);
    setNextRecordingCursor(null);
    setLoadedRecordings([]);
  }, [siteId]);

  useEffect(() => {
    if (recordingsQuery.data === undefined) return;
    setLoadedRecordings((prev) => recordingCursor === null ? [...recordingsQuery.data.items] : appendUniqueSessions(prev, recordingsQuery.data.items));
    setNextRecordingCursor(recordingsQuery.data.next_cursor);
  }, [recordingCursor, recordingsQuery.data]);

  const sessions = useMemo(() => {
    const serverItems = loadedRecordings;
    if (localSession === null || localSession.site_profile_id !== siteId)
      return serverItems;
    if (
      serverItems.some(
        (item) =>
          item.recording_session_id === localSession.recording_session_id,
      )
    )
      return serverItems;
    return [localSession, ...serverItems];
  }, [loadedRecordings, localSession, siteId]);

  useEffect(() => {
    if (selectedRecordingId === null && sessions[0] !== undefined)
      setSelectedRecordingId(sessions[0].recording_session_id);
    if (
      selectedRecordingId !== null &&
      !sessions.some(
        (item) => item.recording_session_id === selectedRecordingId,
      )
    ) {
      setSelectedRecordingId(sessions[0]?.recording_session_id ?? null);
    }
  }, [selectedRecordingId, sessions]);

  const selectedSession = useMemo(
    () =>
      sessions.find(
        (item) => item.recording_session_id === selectedRecordingId,
      ) ?? null,
    [selectedRecordingId, sessions],
  );

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
    setLoadedEvents((prev) => eventCursor === null ? [...eventsQuery.data.items] : appendUniqueEvents(prev, eventsQuery.data.items));
    setNextEventCursor(eventsQuery.data.next_cursor);
  }, [eventCursor, eventsQuery.data]);

  useEffect(() => {
    setRepositoryElementCursor(null);
    setNextRepositoryElementCursor(null);
    setLoadedRepositoryElements([]);
  }, [siteId]);

  useEffect(() => {
    if (siteElementsQuery.data === undefined) return;
    setLoadedRepositoryElements((prev) => repositoryElementCursor === null ? [...siteElementsQuery.data.items] : appendUniqueSiteElements(prev, siteElementsQuery.data.items));
    setNextRepositoryElementCursor(siteElementsQuery.data.next_cursor);
  }, [repositoryElementCursor, siteElementsQuery.data]);

  useEffect(() => {
    setQueuedEvents([]);
  }, [selectedRecordingId, siteId]);

  const startMutation = useMutation({
    mutationFn: () =>
      api.startBrowserRecording(
        siteId,
        {
          name: name.trim(),
          ...(startUrl.trim() !== "" ? { start_url: startUrl.trim() } : {}),
        },
        idempotencyKey(),
      ),
    onSuccess: (session) => {
      setLocalSession(session);
      setCompletedDraft(null);
      setSavedScenario(null);
      setSelectedRecordingId(session.recording_session_id);
      setMessage({ tone: "green", text: "녹화를 시작했습니다." });
      void qc.invalidateQueries({ queryKey: ["browser-recordings", siteId] });
    },
    onError: (error) => setMessage({ tone: "red", text: errorLabel(error) }),
  });

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
      setLocalSession((session) =>
        session !== null && session.recording_session_id === result.recording_session_id
          ? { ...session, event_count: result.event_count }
          : session,
      );
      setEventDraft((prev) => ({
        ...prev,
        selector: "",
        element_key: "",
        label: "",
        url: "",
        value_preview: "",
      }));
      setMessage({ tone: "green", text: "녹화 동작을 추가했습니다." });
      setEventCursor(null);
      setNextEventCursor(null);
      void api.listBrowserRecordingEvents(siteId, result.recording_session_id, { limit: 100 }).then((page) => {
        setLoadedEvents([...page.items]);
        setNextEventCursor(page.next_cursor);
      }).catch(() => undefined);
      void qc.invalidateQueries({ queryKey: ["browser-recording-events", siteId, selectedRecordingId] });
      void qc.invalidateQueries({ queryKey: ["browser-recordings", siteId] });
    },
    onError: (error) => setMessage({ tone: "red", text: errorLabel(error) }),
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
      setLocalSession((session) =>
        session !== null && session.recording_session_id === result.recording_session_id
          ? { ...session, event_count: result.event_count }
          : session,
      );
      const count = queuedEvents.length;
      setQueuedEvents([]);
      setMessage({ tone: "green", text: `임시 동작 ${count}개를 녹화에 추가했습니다.` });
      setEventCursor(null);
      setNextEventCursor(null);
      void api.listBrowserRecordingEvents(siteId, result.recording_session_id, { limit: 100 }).then((page) => {
        setLoadedEvents([...page.items]);
        setNextEventCursor(page.next_cursor);
      }).catch(() => undefined);
      void qc.invalidateQueries({ queryKey: ["browser-recording-events", siteId, selectedRecordingId] });
      void qc.invalidateQueries({ queryKey: ["browser-recordings", siteId] });
    },
    onError: (error) => setMessage({ tone: "red", text: errorLabel(error) }),
  });

  const completeMutation = useMutation({
    mutationFn: () => {
      if (selectedSession === null) throw new Error("recording_required");
      return api.completeBrowserRecording(
        siteId,
        selectedSession.recording_session_id,
        idempotencyKey(),
      );
    },
    onSuccess: (session) => {
      setLocalSession(session);
      setCompletedDraft(session);
      setSavedScenario(null);
      setMessage({
        tone: "green",
        text: "녹화를 완료하고 자동화 초안을 만들었습니다.",
      });
      void qc.invalidateQueries({ queryKey: ["browser-recordings", siteId] });
    },
    onError: (error) => setMessage({ tone: "red", text: errorLabel(error) }),
  });

  const saveDraftMutation = useMutation({
    mutationFn: (session: BrowserRecordingSession) => {
      if (session.draft_ir === null) throw new Error("draft_ir_required");
      return api.createScenario(session.draft_ir);
    },
    onSuccess: (result) => {
      setSavedScenario(result);
      setMessage({
        tone: "green",
        text: `자동화로 저장했습니다. 변경 ${result.version}`,
      });
      void qc.invalidateQueries({ queryKey: ["scenarios"] });
    },
    onError: (error) => setMessage({ tone: "red", text: errorLabel(error) }),
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
  const draftSession =
    completedDraft ??
    (selectedSession !== null && selectedSession.draft_ir !== null
      ? selectedSession
      : null);

  return (
    <section
      className="panel browser-recorder"
      aria-label="브라우저 녹화로 자동화 만들기"
    >
      <div className="panel-head">
        <div>
          <h2>브라우저 녹화로 만들기</h2>
          <p className="subtle">
            현업 사용자가 웹 화면을 따라 하며 클릭·입력 순서를 녹화하고, 검토
            가능한 봇 초안을 만듭니다.
          </p>
        </div>
        <span className="badge blue">로컬 브라우저 실행</span>
      </div>

      {sitesQuery.isLoading ? (
        <Loading />
      ) : sitesQuery.isError ? (
        <ErrorState
          message="사이트 목록을 불러오지 못했습니다."
          onRetry={() => void sitesQuery.refetch()}
        />
      ) : sites.length === 0 ? (
        <p className="empty-state">
          먼저 보안 메뉴에서 자동화할 웹 사이트를 등록하세요.
        </p>
      ) : (
        <>
          <div className="browser-recorder-grid">
            <label>
              <span>녹화 사이트</span>
              <select
                value={siteId}
                onChange={(event) => {
                  setSiteId(event.target.value);
                  setStartUrlTouched(false);
                  setSelectedRecordingId(null);
                  setLocalSession(null);
                }}
              >
                {sites.map((site: SiteItem) => (
                  <option
                    key={site.site_profile_id}
                    value={site.site_profile_id}
                  >
                    {site.name ?? "등록 사이트"}
                  </option>
                ))}
              </select>
              {hasMoreBrowserSites && (
                <small className="subtle">사이트 100건 기준입니다. 더 많은 사이트는 보안 메뉴에서 먼저 확인하세요.</small>
              )}
            </label>
            {hasMoreBrowserSites && (
              <button className="btn" type="button" disabled={sitesQuery.isFetching} onClick={() => setBrowserSiteCursor(nextBrowserSiteCursor)}>
                {sitesQuery.isFetching && browserSiteCursor !== null ? "불러오는 중" : "사이트 더 보기"}
              </button>
            )}
            <label>
              <span>녹화 이름</span>
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="예: 협력사 송장 상태 확인"
              />
            </label>
            <label className="field-wide">
              <span>녹화 시작 주소</span>
              <input
                value={startUrl}
                onChange={(event) => {
                  setStartUrlTouched(true);
                  setStartUrl(event.target.value);
                }}
                placeholder="https://portal.example.com/invoices"
              />
            </label>
          </div>

          <div className="browser-recorder-actions">
            <button
              className="btn primary"
              type="button"
              disabled={
                !canRecord ||
                siteId === "" ||
                name.trim() === "" ||
                startMutation.isPending
              }
              onClick={() => startMutation.mutate()}
            >
              녹화 시작
            </button>
            <button
              className="btn"
              type="button"
              onClick={() => void recordingsQuery.refetch()}
              disabled={siteId === ""}
            >
              새로고침
            </button>
            {!canRecord && (
              <span className="badge amber">사이트 수정 권한 필요</span>
            )}
            {message !== null && (
              <span
                className={`badge ${message.tone}`}
                role={message.tone === "red" ? "alert" : "status"}
              >
                {message.text}
              </span>
            )}
          </div>

          <div className="browser-recorder-layout">
            <section
              className="browser-recorder-sessions"
              aria-label="브라우저 녹화 기록"
            >
              <div className="panel-head compact">
                <h3>녹화 기록</h3>
                {recordingsQuery.isFetching && (
                  <span className="badge muted">동기화 중</span>
                )}
                {hasMoreRecordings && (
                  <span className="badge amber">최근 20건 기준</span>
                )}
              </div>
              {recordingsQuery.isError ? (
                <ErrorState
                  message="녹화 기록을 불러오지 못했습니다."
                  onRetry={() => void recordingsQuery.refetch()}
                />
              ) : sessions.length === 0 ? (
                <p className="empty-state">아직 녹화 기록이 없습니다.</p>
              ) : (
                <div className="browser-recorder-session-list">
                  {sessions.map((session) => (
                    <button
                      key={session.recording_session_id}
                      className={
                        session.recording_session_id ===
                        selectedSession?.recording_session_id
                          ? "active"
                          : undefined
                      }
                      type="button"
                      onClick={() => {
                        setSelectedRecordingId(session.recording_session_id);
                        setCompletedDraft(
                          session.draft_ir !== null ? session : null,
                        );
                        setSavedScenario(null);
                      }}
                    >
                      <strong>{session.name}</strong>
                      <span>
                        <span className={`badge ${statusTone(session.status)}`}>
                          {STATUS_LABEL[session.status]}
                        </span>
                        <span className="badge muted">
                          {session.event_count}개 동작
                        </span>
                      </span>
                      <small>{formatDateTime(session.updated_at)}</small>
                    </button>
                  ))}
                </div>
              )}
              {hasMoreRecordings && (
                <div className="list-pager">
                  <button className="btn" type="button" disabled={isFetchingMoreRecordings} onClick={() => setRecordingCursor(nextRecordingCursor)}>
                    {isFetchingMoreRecordings ? "불러오는 중" : "녹화 더 보기"}
                  </button>
                </div>
              )}
            </section>

            <section
              className="browser-recorder-workbench"
              aria-label="브라우저 녹화 동작 추가"
            >
              <div className="panel-head compact">
                <h3>녹화 동작</h3>
                {selectedSession !== null && (
                  <span
                    className={`badge ${statusTone(selectedSession.status)}`}
                  >
                    {STATUS_LABEL[selectedSession.status]}
                  </span>
                )}
              </div>
              {selectedSession === null ? (
                <p className="empty-state">
                  녹화 기록을 선택하거나 새로 시작하세요.
                </p>
              ) : (
                <>
                  <AgentLaunchCommand
                    siteId={siteId}
                    session={selectedSession}
                  />
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
                    <span className="badge amber">
                      저장된 화면 설명을 다시 선택해 주세요.
                    </span>
                  )}
                  <div className="browser-recorder-actions">
                    <button
                      className="btn"
                      type="button"
                      disabled={!canRecord || !eventValid}
                      onClick={() => {
                        setQueuedEvents((events) => [...events, cleanEvent(eventDraft, startUrl)]);
                        setEventDraft((prev) => ({
                          ...prev,
                          selector: "",
                          element_key: "",
                          label: "",
                          url: "",
                          value_preview: "",
                        }));
                        setMessage({ tone: "green", text: "동작 초안을 임시 목록에 담았습니다." });
                      }}
                    >
                      임시 목록에 담기
                    </button>
                    <button
                      className="btn"
                      type="button"
                      disabled={
                        !canRecord || !eventValid || appendMutation.isPending
                      }
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
          </div>

          {draftSession !== null && (
            <RecordingDraftPreview
              session={draftSession}
              canSave={can("scenario.create")}
              saving={saveDraftMutation.isPending}
              savedScenario={savedScenario}
              onSave={() => saveDraftMutation.mutate(draftSession)}
            />
          )}
        </>
      )}
    </section>
  );
}

function RecordingDraftPreview(props: {
  session: BrowserRecordingSession;
  canSave: boolean;
  saving: boolean;
  savedScenario: ScenarioMutationResult | null;
  onSave: () => void;
}): JSX.Element {
  const { session } = props;
  const report = session.validation_report;
  const errors = report?.errors ?? [];
  const warnings = report?.warnings ?? [];
  const saveDisabled =
    !props.canSave ||
    props.saving ||
    session.draft_ir === null ||
    report === null ||
    errors.length > 0;
  const tone =
    errors.length > 0
      ? "red"
      : warnings.length > 0
        ? "amber"
        : report === null
          ? "muted"
          : "green";
  const [developerOpen, setDeveloperOpen] = useState(false);
  const summary = draftSummary(session);
  const startLabel = draftStartLabel(summary);
  const label =
    report === null
        ? "검사 대기"
      : errors.length > 0
        ? `수정 필요 ${errors.length}건`
        : warnings.length > 0
          ? `경고 ${warnings.length}건`
          : "자동화 검사 통과";
  return (
    <details className="browser-recorder-draft" open>
      <summary>
        생성된 자동화 확인
        <span className={`badge ${tone}`}>{label}</span>
      </summary>
      {report !== null && (
        <div
          className="browser-recorder-validation"
          role={errors.length > 0 ? "alert" : "status"}
        >
          <ValidationIssueList title="오류" items={errors} tone="red" />
          <ValidationIssueList title="경고" items={warnings} tone="amber" />
          {errors.length === 0 && warnings.length === 0 && (
            <p className="subtle">
              저장 전 자동화와 같은 실행 전 검사를 통과했습니다. 실제 사이트
              상태와 입력값은 첫 실행에서 다시 확인해야 합니다.
            </p>
          )}
        </div>
      )}
      <div className="browser-recorder-draft-summary" aria-label="자동화 요약">
        <span>
          <strong>{summary.name}</strong>
          <small>자동화 이름</small>
        </span>
        <span>
          <strong>{summary.steps.length}</strong>
          <small>녹화 동작</small>
        </span>
        <span>
          <strong>{startLabel}</strong>
          <small>처음 동작</small>
        </span>
      </div>
      {summary.steps.length === 0 ? (
        <p className="empty-state">
          표시할 녹화 동작 요약이 없습니다. 고급 세부 정보에서 생성 결과를 확인하세요.
        </p>
      ) : (
        <ol
          className="browser-recorder-draft-steps"
          aria-label="녹화 동작 요약"
        >
          {summary.steps.slice(0, 8).map((step, index) => (
            <li key={step.id}>
              <span className="badge muted">{index + 1}번째</span>
              <strong>{step.action}</strong>
              {step.detail !== null && <span>{step.detail}</span>}
            </li>
          ))}
        </ol>
      )}
      {summary.steps.length > 8 && (
        <p className="subtle">
          나머지 {summary.steps.length - 8}개 녹화 동작은 고급 세부 정보에서
          확인할 수 있습니다.
        </p>
      )}
      <details className="developer-details" open={developerOpen}>
        <summary
          onClick={(event) => {
            event.preventDefault();
            setDeveloperOpen((open) => !open);
          }}
        >
          고급 세부 정보 보기
        </summary>
        {developerOpen && (
          <pre>{JSON.stringify(session.draft_ir, null, 2)}</pre>
        )}
      </details>
      <div className="browser-recorder-draft-actions">
        <button
          className="btn primary"
          type="button"
          disabled={saveDisabled}
          onClick={props.onSave}
        >
          {props.saving ? "저장 중" : "자동화로 저장"}
        </button>
        {props.savedScenario !== null && (
          <>
            <span className="badge green">
              저장됨: 변경 {props.savedScenario.version}
            </span>
            <button
              className="btn"
              type="button"
              onClick={() =>
                navigate("playground", {
                  scenario: props.savedScenario?.scenario_id ?? "",
                })
              }
            >
              미리보기
            </button>
            <button
              className="btn"
              type="button"
              onClick={() =>
                navigate("automationOps", {
                  scenario: props.savedScenario?.scenario_id ?? "",
                })
              }
            >
              운영 예약
            </button>
            <button
              className="btn"
              type="button"
              onClick={() =>
                navigate("coePipeline", {
                  scenario: props.savedScenario?.scenario_id ?? "",
                })
              }
            >
              CoE 연결
            </button>
          </>
        )}
        {!props.canSave && (
          <span className="badge amber">자동화 생성 권한 필요</span>
        )}
        {errors.length > 0 && (
          <span className="badge red">검사 오류 수정 필요</span>
        )}
      </div>
    </details>
  );
}

function ValidationIssueList(props: {
  title: string;
  items: readonly BrowserRecordingValidationIssue[];
  tone: "red" | "amber";
}): JSX.Element | null {
  if (props.items.length === 0) return null;
  return (
    <div>
      <strong>
        {props.title} ({props.items.length})
      </strong>
      <ul>
        {props.items.map((issue, index) => (
          <li key={`${issue.rule ?? issue.code ?? props.title}-${index}`}>
            <span className={`badge ${props.tone}`}>
              {props.tone === "red" ? "확인 필요" : "주의"}
            </span>
            <span>{recordingIssueSummary(issue)}</span>
            {(issue.nodeId ?? issue.node_id) !== undefined && (
              <span className="subtle">
                {" "}
                확인할 녹화 동작 연결 정보가 있습니다.
              </span>
            )}
            <details className="developer-details">
              <summary>고급 검사 정보 보기</summary>
              <pre>{JSON.stringify(issue, null, 2)}</pre>
            </details>
          </li>
        ))}
      </ul>
    </div>
  );
}

function recordingIssueSummary(issue: BrowserRecordingValidationIssue): string {
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

function AgentLaunchCommand({
  siteId,
  session,
}: {
  siteId: string;
  session: BrowserRecordingSession;
}): JSX.Element | null {
  const [copied, setCopied] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const command = useMemo(() => {
    const apiBase = agentApiBase();
    return [
      `$env:RPA_OPERATOR_TOKEN=${psQuote("<paste operator JWT>")}`,
      `npm --prefix app run record:browser -- --api ${psQuote(apiBase)} --site ${psQuote(siteId)} --recording ${psQuote(session.recording_session_id)} --start-url ${psQuote(session.start_url)}`,
    ].join("\n");
  }, [session.recording_session_id, session.start_url, siteId]);

  if (session.status !== "recording") return null;

  const copy = async (): Promise<void> => {
    const clipboard = globalThis.navigator?.clipboard;
    if (clipboard?.writeText !== undefined) await clipboard.writeText(command);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="browser-recorder-agent">
      <div>
        <strong>내 PC 브라우저 녹화 도우미</strong>
        <span className="badge blue">내 PC Chrome</span>
      </div>
      <p className="subtle">
        업무 담당자 PC에서 실행하면 녹화에 필요한 권한은 PC 안에서만 쓰이고,
        대상 웹페이지에는 전달되지 않습니다.
      </p>
      <details className="developer-details" open={commandOpen}>
        <summary
          onClick={(event) => {
            event.preventDefault();
            setCommandOpen((open) => !open);
          }}
        >
          고급 실행 정보 보기
        </summary>
        {commandOpen && (
          <pre>
            <code>{command}</code>
          </pre>
        )}
      </details>
      <button className="btn" type="button" onClick={() => void copy()}>
        {copied ? "복사됨" : "실행 명령 복사"}
      </button>
    </div>
  );
}

function EventForm(props: {
  value: {
    event_type: BrowserRecordingEventType;
    selector: string;
    element_key: string;
    label: string;
    url: string;
    value_preview: string;
  };
  onChange: (next: {
    event_type: BrowserRecordingEventType;
    selector: string;
    element_key: string;
    label: string;
    url: string;
    value_preview: string;
  }) => void;
  startUrl: string;
  repositoryElements: readonly SiteElementItem[];
  disabled: boolean;
}): JSX.Element {
  const update = (patch: Partial<typeof props.value>): void =>
    props.onChange({ ...props.value, ...patch });
  const selectedRepositoryKey = props.repositoryElements.some(
    (item) => item.element_key === props.value.element_key,
  )
    ? props.value.element_key
    : "";
  const selectedRepositoryElement =
    props.repositoryElements.find((item) => item.element_key === selectedRepositoryKey) ?? null;
  const selectRepositoryElement = (elementKey: string): void => {
    const item = props.repositoryElements.find(
      (candidate) => candidate.element_key === elementKey,
    );
    if (item === undefined) {
      update({ element_key: "" });
      return;
    }
    update({
      element_key: item.element_key,
      selector: item.selector,
      label: item.label,
    });
  };
  return (
    <div className="browser-recorder-event-form">
      <label>
        <span>녹화 동작</span>
        <select
          disabled={props.disabled}
          value={props.value.event_type}
          onChange={(event) =>
            update({
              event_type: event.target.value as BrowserRecordingEventType,
            })
          }
        >
          {EVENT_TYPES.map((type) => (
            <option key={type} value={type}>
              {EVENT_LABEL[type]}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>저장된 화면 설명</span>
        <select
          disabled={
            props.disabled ||
            props.value.event_type === "navigate" ||
            props.repositoryElements.length === 0
          }
          value={selectedRepositoryKey}
          onChange={(event) => selectRepositoryElement(event.target.value)}
        >
          <option value="">{props.repositoryElements.length === 0 ? "저장된 화면 설명 없음" : "화면 설명 직접 입력"}</option>
          {props.repositoryElements.map((item) => (
            <option key={item.element_id} value={item.element_key}>
              {repositoryOptionLabel(item)}
            </option>
          ))}
        </select>
        {selectedRepositoryElement !== null ? (
          <small className="subtle">
            저장소에서 찾기 조건을 가져왔습니다. {repositoryMetaLabel(selectedRepositoryElement)}
          </small>
        ) : (
          <small className="subtle">저장소를 선택하면 화면에서 찾는 조건과 표시 이름을 자동으로 채웁니다.</small>
        )}
      </label>
      <label className="field-wide">
        <span>화면에서 찾는 조건</span>
        <input
          disabled={props.disabled || props.value.event_type === "navigate"}
          value={props.value.selector}
          onChange={(event) => update({ selector: event.target.value })}
          placeholder="예: 제출 버튼, 승인 확인 영역"
        />
      </label>
      <label>
        <span>표시 이름</span>
        <input
          disabled={props.disabled}
          value={props.value.label}
          onChange={(event) => update({ label: event.target.value })}
          placeholder="제출 버튼"
        />
      </label>
      <label>
        <span>이동 주소</span>
        <input
          disabled={props.disabled || props.value.event_type !== "navigate"}
          value={props.value.url}
          onChange={(event) => update({ url: event.target.value })}
          placeholder={props.startUrl || "https://portal.example.com"}
        />
      </label>
      <label className="field-wide">
        <span>입력값 일부 표시</span>
        <input
          disabled={props.disabled || props.value.event_type !== "input"}
          value={props.value.value_preview}
          onChange={(event) => update({ value_preview: event.target.value })}
          placeholder="마스킹된 예시만 입력하세요"
        />
      </label>
    </div>
  );
}

function EventList(props: {
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

function QueuedEventList(props: {
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

function recordedEventDetail(event: BrowserRecordingEvent): string {
  if (event.label !== null && event.label.trim() !== "") return event.label;
  if (event.url !== null && event.url.trim() !== "") return "페이지 이동 주소 사용";
  if (event.element_key !== null && event.element_key.trim() !== "") return "저장된 화면 설명 사용";
  return "화면에서 찾는 조건 사용";
}

function queuedEventDetail(event: BrowserRecordingAppendEvent): string {
  if (event.label !== undefined && event.label.trim() !== "") return event.label;
  if (event.url !== undefined && event.url.trim() !== "") return "페이지 이동 주소 사용";
  if (event.element_key !== undefined && event.element_key.trim() !== "") return "저장된 화면 설명 사용";
  if (event.value_preview !== undefined && event.value_preview.trim() !== "") return "입력값 미리보기 사용";
  return "화면에서 찾는 조건 사용";
}

function moveQueuedEvent(
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

function cleanEvent(value: {
  event_type: BrowserRecordingEventType;
  selector: string;
  element_key: string;
  label: string;
  url: string;
  value_preview: string;
}, startUrlFallback = ""): BrowserRecordingAppendEvent {
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

function defaultStartUrlFromPattern(pattern: string | undefined): string {
  if (pattern === undefined || pattern.trim() === "") return "";
  try {
    return new URL(pattern).toString();
  } catch {
    return pattern;
  }
}

function repositoryOptionLabel(item: SiteElementItem): string {
  return `${item.label} · ${repositoryMetaLabel(item)}`;
}

function repositoryMetaLabel(item: SiteElementItem): string {
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

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("ko-KR", { dateStyle: "short", timeStyle: "short" }).format(date);
}

function agentApiBase(): string {
  const configured = import.meta.env.VITE_API_BASE_URL;
  if (typeof configured === "string" && /^https?:\/\//i.test(configured))
    return configured.replace(/\/+$/, "");
  return "http://127.0.0.1:3000";
}

function psQuote(value: string): string {
  return `"${value.replace(/`/g, "``").replace(/"/g, '`"')}"`;
}
