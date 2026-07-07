import { useQuery } from "@tanstack/react-query";

import { useApiClient } from "../api/context";
import { useCan } from "../api/permissions";
import { ApiError } from "../api/types";
import { COLLECT_SCENARIO_NAME, APPROVAL_ARTIFACT_TYPE, parseApprovalRows } from "../api/approval-inbox";
import { EmptyState, ErrorState, Loading } from "../components/states";
import { RunScenarioButton } from "../components/RunScenarioButton";
import type { ApprovalRow, RunArtifactItem, ScenarioItem } from "../api/types";
import { formatDateTime } from "../util/time";
import { FanOutButton } from "./approval-inbox/FanOutButton";
import { Inbox } from "./approval-inbox/Inbox";

const POLL_MS = 10_000;

async function findCollectScenario(
  api: ReturnType<typeof useApiClient>,
): Promise<ScenarioItem | null> {
  let cursor: string | undefined;
  for (let page = 0; page < 20; page += 1) {
    const res = await api.listScenarios({
      limit: 50,
      ...(cursor !== undefined ? { cursor } : {}),
    });
    const found = res.items.find((s) => s.name === COLLECT_SCENARIO_NAME);
    if (found !== undefined) return found;
    if (res.next_cursor === null) return null;
    cursor = res.next_cursor;
  }
  return null;
}

async function findApprovalArtifact(
  api: ReturnType<typeof useApiClient>,
  runId: string,
): Promise<RunArtifactItem | null> {
  let cursor: string | undefined;
  for (let page = 0; page < 20; page += 1) {
    const res = await api.listRunArtifacts(runId, {
      limit: 50,
      ...(cursor !== undefined ? { cursor } : {}),
    });
    const found = res.items.find((a) => a.type === APPROVAL_ARTIFACT_TYPE);
    if (found !== undefined) return found;
    if (res.next_cursor === null) return null;
    cursor = res.next_cursor;
  }
  return null;
}

// 결재 인박스 — '하이웍스 결재 수집' 자동화 실행이 남긴 아티팩트(결재 목록)를 읽어 구조화 요약 + 목록 표시(읽기 전용).
// 발견 경로: listScenarios(이름 매칭) → listRuns(scenario_version_id, completed) 최신 → listRunArtifacts → getArtifact.
// Phase 2c 부터 approval.decide 권한 시 행별 [결재]/[반려] 버튼 노출(DecideButtons) — 되돌릴 수 없는 결재 처리를 위한 자동화 실행 생성(휴먼게이트). 백엔드가 최종 강제.
export function ApprovalInboxView(): JSX.Element {
  const api = useApiClient();
  const can = useCan();

  const collect = useQuery({
    queryKey: ["scenarios", "approval-inbox-collector"],
    queryFn: () => findCollectScenario(api),
  });
  const collectScenario = collect.data ?? undefined;

  const runs = useQuery({
    queryKey: ["runs", "collect", collectScenario?.latest_version_id ?? ""],
    queryFn: () => api.listRuns({ scenario_version_id: collectScenario!.latest_version_id, status: "completed", limit: 1 }),
    enabled: collectScenario !== undefined,
    refetchInterval: POLL_MS,
  });
  const latestRun = runs.data?.items[0];

  const arts = useQuery({
    queryKey: ["run-artifacts", "approval-inbox", latestRun?.run_id ?? ""],
    queryFn: () => findApprovalArtifact(api, latestRun!.run_id),
    enabled: latestRun !== undefined,
  });
  const inboxArt = arts.data ?? undefined;

  const detail = useQuery({
    queryKey: ["artifact", inboxArt?.artifact_id ?? ""],
    queryFn: () => api.getArtifact(inboxArt!.artifact_id),
    enabled: inboxArt !== undefined,
    retry: false,
  });

  const recollect = collectScenario !== undefined ? <RunScenarioButton scenario={collectScenario} /> : null;

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, marginBottom: 12, flexWrap: "wrap" }}>
        <p className="subtle" style={{ margin: 0 }}>
          최근 수집된 하이웍스 결재 목록입니다{latestRun?.as_of ? ` · 기준 ${formatDateTime(latestRun.as_of)}` : ""}. 결재 권한이 있으면 행별로 승인/반려하거나, 전체를 검토 인박스로 보낼 수 있습니다.
        </p>
        <span style={{ display: "inline-flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          {can("approval.decide") && latestRun !== undefined && <FanOutButton sourceRunId={latestRun.run_id} />}
          {recollect}
        </span>
      </div>
      <Body
        scenarios={collect}
        collect={collectScenario}
        runs={runs}
        latestRun={latestRun}
        arts={arts}
        inboxArt={inboxArt}
        detail={detail}
      />
    </div>
  );
}

type Q = { isLoading: boolean; isError: boolean; refetch: () => unknown };

function Body(props: {
  scenarios: Q;
  collect: { scenario_id: string } | undefined;
  runs: Q;
  latestRun: { run_id: string } | undefined;
  arts: Q;
  inboxArt: { artifact_id: string } | undefined;
  detail: Q & { data?: { content: string } };
}): JSX.Element {
  const { scenarios, collect, runs, latestRun, arts, inboxArt, detail } = props;

  if (scenarios.isLoading) return <Loading />;
  if (scenarios.isError) return <ErrorState message="자동화 목록을 불러오지 못했습니다." onRetry={() => void scenarios.refetch()} />;
  if (collect === undefined) {
    return <EmptyState message={`'${COLLECT_SCENARIO_NAME}' 자동화가 아직 없습니다. 자동화 만들기에서 등록하세요.`} />;
  }
  if (runs.isLoading) return <Loading />;
  if (runs.isError) return <ErrorState message="수집 실행 기록을 불러오지 못했습니다." onRetry={() => void runs.refetch()} />;
  if (latestRun === undefined) {
    return <EmptyState message="아직 수집된 결재가 없습니다. 위 ‘실행’으로 결재 수집을 시작하세요." />;
  }
  if (arts.isLoading || detail.isLoading) return <Loading />;
  if (arts.isError) return <ErrorState message="수집 산출물 목록을 불러오지 못했습니다." onRetry={() => void arts.refetch()} />;
  if (inboxArt === undefined) {
    return <EmptyState message="수집 실행은 끝났지만 결재 목록 산출물이 없습니다." />;
  }
  if (detail.isError) {
    const e = (detail as { error?: unknown }).error;
    const msg = e instanceof ApiError && e.code === "RESOURCE_NOT_FOUND"
      ? "결재 목록 조회 준비가 끝나지 않았거나 조회 권한이 없습니다."
      : "결재 목록 본문을 불러오지 못했습니다.";
    return <ErrorState message={msg} onRetry={() => void detail.refetch()} />;
  }
  if (detail.data === undefined) return <Loading />;

  let rows: ApprovalRow[];
  try {
    rows = parseApprovalRows(detail.data.content);
  } catch (e) {
    return <ErrorState message={e instanceof Error ? e.message : "결재 목록을 해석하지 못했습니다."} />;
  }
  if (rows.length === 0) return <EmptyState message="수집된 결재 항목이 없습니다." />;
  // latestRun 은 위 가드(latestRun===undefined → EmptyState)에서 이미 좁혀져 여기선 항상 정의됨.
  return <Inbox rows={rows} sourceRunId={latestRun.run_id} />;
}
