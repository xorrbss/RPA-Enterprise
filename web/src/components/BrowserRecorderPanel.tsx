import { useEffect, useMemo, useState } from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

import { useApiClient } from "../api/context";
import { useCan } from "../api/permissions";
import type {
  BrowserRecordingSession,
  ScenarioMutationResult,
  SiteItem,
} from "../api/types";
import { errorLabel } from "./badges";
import { ErrorState, Loading } from "./states";
import { RecordingDraftPreview } from "./browser-recorder/RecordingDraftPreview";
import { RecordingWorkbench } from "./browser-recorder/RecordingWorkbench";
import {
  STATUS_LABEL,
  appendUniqueBy,
  defaultStartUrlFromPattern,
  formatDateTime,
  idempotencyKey,
  statusTone,
} from "./browser-recorder/helpers";

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

  const sitesQuery = useQuery({
    queryKey: ["sites", "browser-recorder", browserSiteCursor],
    queryFn: () => api.listSites({ limit: 100, ...(browserSiteCursor !== null ? { cursor: browserSiteCursor } : {}) }),
  });
  const sites = loadedBrowserSites;
  const hasMoreBrowserSites = nextBrowserSiteCursor !== null;

  useEffect(() => {
    if (sitesQuery.data === undefined) return;
    setLoadedBrowserSites((prev) => browserSiteCursor === null ? [...sitesQuery.data.items] : appendUniqueBy(prev, sitesQuery.data.items, (i) => i.site_profile_id));
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
    setLoadedRecordings((prev) => recordingCursor === null ? [...recordingsQuery.data.items] : appendUniqueBy(prev, recordingsQuery.data.items, (i) => i.recording_session_id));
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

            <RecordingWorkbench
              siteId={siteId}
              selectedRecordingId={selectedRecordingId}
              selectedSession={selectedSession}
              startUrl={startUrl}
              canRecord={canRecord}
              setLocalSession={setLocalSession}
              onMessage={setMessage}
              onCompleted={(session) => {
                setCompletedDraft(session);
                setSavedScenario(null);
              }}
            />
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
