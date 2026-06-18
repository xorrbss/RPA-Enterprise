import { useQuery } from "@tanstack/react-query";
import type { ComponentProps } from "react";

import { useApiClient } from "../api/context";
import { useCan } from "../api/permissions";
import { OnboardingBanner } from "../components/OnboardingBanner";
import { QueryPanel } from "../components/QueryPanel";
import { StatusBadge } from "../components/badges";
import { navigate, type ViewKey } from "../router";
import type { RunItem } from "../api/types";

// 첫-실행 안내 배너 — 권한별(RBAC) 안내문/CTA. cta 없으면 viewer 안내문만(없는 권한 동선 창작 금지).
// 입력은 부모가 실 응답으로 판정한 '진짜 빈 테넌트' 여부 + useCan뿐(데이터 미창작).
// 분기는 2가지뿐: 현 RBAC 매트릭스(permissions.ts)상 scenario.create 보유 역할은 예외 없이 run.create도
// 보유하므로(viewer만 둘 다 없음), run.create 유무가 곧 '명령 권한자 vs 뷰어' 경계다.
// 문구는 시나리오 존재를 단정하지 않는다 — 부모는 listScenarios를 조회하지 않아 '준비된 자동화'가 있는지
// 관찰한 적이 없다(데이터 미창작). CTA 라벨('자동화 화면으로 가기')은 동작 그대로의 안내문이고, 이동 대상은
// scenarioStudio(meta.ts title='자동화 만들기')다 — 라벨은 대상 title을 그대로 쓰지 않는다.
function onboardingProps(can: (a: string) => boolean): ComponentProps<typeof OnboardingBanner> {
  if (can("run.create")) return { message: "첫 실행을 시작해 보세요.", cta: { label: "자동화 화면으로 가기", view: "scenarioStudio" } };
  return { message: "아직 등록된 실행이 없습니다. 권한이 있는 담당자가 첫 실행을 시작할 수 있습니다." };
}

// 지표 카드 — 클릭 시 해당 목록 화면으로 드릴다운(죽은 대시보드 → 진입점). 카드 자체가 버튼이라 키보드 포커스/Enter 동작.
// 라우트는 타입드 {view, params}로 navigate에 위임(원시 해시 리터럴 제거·라우트 의도 가시화) — '실행 중'은
// runTrace?status=running으로 카운트와 목록 모집단을 일치. params는 RunState enum 등 기존 실 필드 그대로.
function Metric({ label, value, view, params, hint }: { label: string; value: string; view: ViewKey; params?: Record<string, string>; hint: string }): JSX.Element {
  return (
    <button type="button" className="metric metric-link" onClick={() => navigate(view, params)}>
      <span className="label">{label}</span>
      <span className="value">{value}</span>
      <span className="metric-hint subtle">{hint} <span aria-hidden="true">→</span></span>
    </button>
  );
}

type Page = { items: readonly unknown[]; next_cursor: string | null };

// 카운트 표기(조용한 false 금지): 서버 집계 엔드포인트가 없어 카운트는 '최신 50건' 페이지 기준이다.
// next_cursor가 있으면(=더 있음) `N+`(≥N 하한)로, 없으면 정확한 N으로 표기 — 페이지 길이를 총계처럼 보이지 않게 한다.
function pageCount(d: Page | undefined): string {
  if (d === undefined) return "—";
  return d.next_cursor !== null ? `${d.items.length}+` : String(d.items.length);
}

export function DashboardView(): JSX.Element {
  const api = useApiClient();
  const can = useCan();
  // '실행 중'은 서버 status 필터로 정확히 집계(이전: 전체 50건을 클라에서 status==='running' 필터 → 50건 초과 시 구조적 오집계).
  const running = useQuery({ queryKey: ["runs", "running"], queryFn: () => api.listRuns({ status: "running", limit: 50 }), refetchInterval: 5_000 });
  const recent = useQuery({ queryKey: ["runs"], queryFn: () => api.listRuns({ limit: 50 }), refetchInterval: 5_000 });
  const human = useQuery({ queryKey: ["human-tasks"], queryFn: () => api.listHumanTasks({ limit: 50 }), refetchInterval: 5_000 });
  const wiDlq = useQuery({ queryKey: ["dlq", "workitem"], queryFn: () => api.listDlq("workitem", { limit: 50 }), refetchInterval: 5_000 });
  const sinkDlq = useQuery({ queryKey: ["dlq", "sink"], queryFn: () => api.listDlq("sink", { limit: 50 }), refetchInterval: 5_000 });
  // 실패 터미널(failed_business/failed_system)을 서버 status 필터로 각각 정확 집계(클라 필터 아님).
  // 카드를 status별로 분리한다: 합산 단일 카드는 카운트(business+system)와 드릴다운 해시(단일 status)의 모집단이
  // 어긋나(RunTrace는 단일 status만 시드) 실패 총량을 오표상했다. 카드별 단일-status 카운트↔단일-status 해시로
  // '실행 중' 카드와 동일하게 카운트·목록 모집단 정합을 정확히 만족시킨다(조용한 false 인접 오표상 제거).
  const failedBiz = useQuery({ queryKey: ["runs", "failed_business"], queryFn: () => api.listRuns({ status: "failed_business", limit: 50 }), refetchInterval: 5_000 });
  const failedSys = useQuery({ queryKey: ["runs", "failed_system"], queryFn: () => api.listRuns({ status: "failed_system", limit: 50 }), refetchInterval: 5_000 });

  // 첫-실행 안내 배너: '진짜 빈 테넌트'(실행 0건)일 때만. recent(무필터 listRuns)의 실 필드로만 판정.
  // length===0 && next_cursor===null → 절단된 0(더 있을 수 있음)이 아닌 진짜 0(조용한 false 금지).
  // isLoading/isError 중에는 미표시(데이터 도착 전 단정 금지). 실행이 1건이라도 생기면 자동 소멸.
  const isEmptyTenant = recent.isSuccess && recent.data.items.length === 0 && recent.data.next_cursor === null;

  return (
    <>
      {isEmptyTenant && <OnboardingBanner {...onboardingProps(can)} />}
      <div className="metrics">
        <Metric label="실행 중" value={pageCount(running.data)} view="runTrace" params={{ status: "running" }} hint="실행 기록" />
        <Metric label="사람 확인 대기" value={pageCount(human.data)} view="humanTasks" hint="사람 확인" />
        <Metric label="업무 실패" value={pageCount(failedBiz.data)} view="runTrace" params={{ status: "failed_business" }} hint="실행 기록" />
        <Metric label="시스템 실패" value={pageCount(failedSys.data)} view="runTrace" params={{ status: "failed_system" }} hint="실행 기록" />
        <Metric label="작업항목 DLQ" value={pageCount(wiDlq.data)} view="workitems" hint="작업 목록" />
        <Metric label="외부 전달 DLQ" value={pageCount(sinkDlq.data)} view="workitems" hint="작업 목록" />
      </div>
      <p className="subtle" style={{ margin: "0 2px" }}>
        각 지표는 최신 50건 기준입니다. <strong>+</strong>는 표시 한도를 넘겨 더 있음을 뜻합니다(예: <code>50+</code> = 50건 이상).
      </p>
      {/* 빈 테넌트(실행 0건)일 때는 위 OnboardingBanner 가 '실행 없음' + CTA 로 그 상태를 온전히 안내하므로,
          같은 사실을 반복하는 패널 EmptyState('아직 실행이 없습니다.')는 숨긴다(중복 메시지·중복 role='status' 제거).
          실행이 1건이라도 생기면 isEmptyTenant=false 가 되어 패널이 즉시 복귀한다(기능 손실 없음). */}
      {!isEmptyTenant && (
      <QueryPanel<RunItem>
        title="최근 실행"
        query={recent}
        rowKey={(r) => r.run_id}
        emptyMessage="아직 실행이 없습니다."
        columns={[
          {
            header: "실행 ID",
            render: (r) => (
              <button
                type="button"
                className="linklike"
                aria-label={`실행 ${r.run_id.slice(0, 8)} 상세 보기`}
                title="실행 상세 보기"
                onClick={() => navigate("runTrace", { run: r.run_id })}
              >
                <code>{r.run_id.slice(0, 8)}</code>
              </button>
            ),
          },
          { header: "상태", render: (r) => <StatusBadge status={r.status} /> },
        ]}
      />
      )}
    </>
  );
}
