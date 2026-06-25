import { beforeEach, describe, expect, test } from "vitest";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { App } from "../src/App";
import { ApiClientProvider } from "../src/api/context";
import type { ApiClient } from "../src/api/client";
import { ApiError } from "../src/api/types";
import { NAV_GROUPS, VIEW_KEYS } from "../src/router";
import { fakeClient } from "./fake-client";

function renderApp(client: ApiClient = fakeClient()): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ApiClientProvider client={client}>
        <App />
      </ApiClientProvider>
    </QueryClientProvider>,
  );
}

function jwt(roles: readonly string[]): string {
  const payload = btoa(JSON.stringify({ sub: "u", tenant_id: "t", roles }))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `e30.${payload}.sig`;
}
const ALL_ROLES = ["viewer", "operator", "reviewer", "approver", "admin"];

function installObjectUrlMock(): void {
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: () => "blob:test-preview",
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: () => undefined,
  });
}

describe("UX quick-wins (A)", () => {
  beforeEach(() => {
    location.hash = "";
    localStorage.setItem("rpa.token", jwt(ALL_ROLES));
  });

  // A1 — 거짓 지표 수정: '실행 중'은 클라 필터가 아니라 서버 status 필터로 집계해야 한다.
  test("A1: '실행 중' 지표는 서버 status='running' 필터로 집계", async () => {
    const calls: Array<Record<string, unknown>> = [];
    renderApp(
      fakeClient({
        listRuns: async (p) => {
          calls.push(p ?? {});
          return {
            items: [
              {
                run_id: "r1",
                status: "running",
                current_node: null,
                as_of: null,
              },
            ],
            next_cursor: null,
          };
        },
      }),
    );
    await waitFor(() =>
      expect(screen.getByText("최근 실행")).toBeInTheDocument(),
    );
    // 두 호출 중 정확히 하나가 status='running'(지표), 하나는 무필터(최근 실행 표).
    await waitFor(() =>
      expect(calls.some((c) => c.status === "running")).toBe(true),
    );
    expect(calls.some((c) => c.status === undefined)).toBe(true);
  });

  // A1 — 절단 정직성: 여전히 근사(최신 50건)인 카드(사람 확인·재처리 대기)는 next_cursor 있으면 'N+'(하한), 없으면 정확한 N.
  // (run-status 카드는 getRunSummary 서버 집계로 전환돼 절단이 없다 — 정직성 가드는 근사 카드로 검증.)
  test("A1: 더 있으면 'N+', 없으면 정확한 수(조용한 false 금지)", async () => {
    renderApp(
      fakeClient({
        listHumanTasks: async () => ({
          items: [1, 2, 3].map((n) => ({
            human_task_id: `h${n}`,
            state: "open",
            kind: "approval",
            assignee: null,
            timeout: null,
            on_timeout: null,
            run_id: null,
          })),
          next_cursor: "more",
        }),
        listDlq: async () => ({
          items: [
            {
              dead_letter_id: "d1",
              kind: "workitem",
              status: "DEAD_LETTER",
              source_id: null,
            },
          ],
          next_cursor: null,
        }),
      }),
    );
    const human = await screen.findByRole("button", { name: /사람 확인 대기/ });
    await waitFor(() => expect(human).toHaveTextContent("3+")); // 3건 + 더 있음 → 하한 표기
    const dlq = screen.getByRole("button", { name: /작업 항목 재처리 대기/ });
    expect(dlq).toHaveTextContent("1"); // next_cursor 없음 → 정확한 수
    expect(dlq).not.toHaveTextContent("1+");
  });

  // A2 — 죽은 대시보드 → 진입점: 4개 카드 각각의 드릴다운 대상 검증(손수 적은 to/hash 오타 가드).
  const NAV_CASES = [
    { name: /실행 중/, hash: "#runTrace?status=running" }, // 카운트(running)와 모집단 일치 딥링크
    { name: /사람 확인 대기/, hash: "#humanTasks" },
    { name: /작업 항목 재처리 대기/, hash: "#workitems" },
    { name: /외부 전달 재처리 대기/, hash: "#workitems" },
  ];
  for (const c of NAV_CASES) {
    test(`A2: 카드 ${c.name.source} → ${c.hash}`, async () => {
      renderApp();
      (await screen.findByRole("button", { name: c.name })).click();
      await waitFor(() => expect(location.hash).toBe(c.hash));
    });
  }

  // 회귀(break-it): status 딥링크가 상세 드릴다운/증빙 조회 후에도 보존돼야 한다(hashWith 병합 — 주소창이 필터와 어긋나지 않게).
  test("A2: status 딥링크가 상세·증빙 조회에서 보존(hashWith)", async () => {
    renderApp();
    location.hash = "#runTrace?status=running";
    (await screen.findByRole("button", { name: "실행 추적 상세 보기" })).click(); // run 추가, status 보존
    await waitFor(() => expect(location.hash).toContain("status=running"));
    expect(location.hash).toContain("run=");
    const uuid = "72000000-0000-0000-0000-000000000001";
    fireEvent.change(screen.getByLabelText("증빙 번호"), {
      target: { value: uuid },
    });
    screen.getByRole("button", { name: "조회" }).click(); // artifact 추가, status·run 보존
    await waitFor(() => expect(location.hash).toContain("artifact="));
    expect(location.hash).toContain("status=running");
    expect(location.hash).toContain("run=");
  });

  // A1/A2 일관성: '실행 중' 딥링크(#runTrace?status=running)가 RunTrace 목록 필터를 시드 → 카운트와 목록 모집단 일치.
  test("A2: '실행 중' 딥링크가 RunTrace 상태 필터를 시드", async () => {
    const calls: Array<Record<string, unknown>> = [];
    renderApp(
      fakeClient({
        listRuns: async (p) => {
          calls.push(p ?? {});
          return { items: [], next_cursor: null };
        },
      }),
    );
    location.hash = "#runTrace?status=running";
    await waitFor(() =>
      expect(calls.some((c) => c.status === "running")).toBe(true),
    );
  });

  // A2 — '최근 실행' 행 클릭 → run 드릴다운 딥링크.
  test("A2: 최근 실행 행 클릭 → #runTrace?run=<id>", async () => {
    renderApp();
    const idBtn = await screen.findByRole("button", { name: /상세 보기/ });
    idBtn.click();
    await waitFor(() =>
      expect(location.hash).toContain(
        "#runTrace?run=11111111-aaaa-bbbb-cccc-000000000001",
      ),
    );
  });

  // A3 — 증빙 UUID 복붙 제거: 단계 트레이스의 artifact_id 클릭 → 증빙 조회 자동 입력·조회(전체 uuid).
  test("A3: artifact_id 클릭 → ArtifactLookup 자동 조회(전체 uuid)", async () => {
    const fetched: string[] = [];
    renderApp(
      fakeClient({
        getArtifact: async (id) => {
          fetched.push(id);
          return {
            artifact_id: id,
            type: "extract_result_json",
            sha256: "abc",
            redaction_status: "redacted",
            retention_until: null,
            content: JSON.stringify({ rows: [{ title: "masked" }] }),
          };
        },
      }),
    );
    location.hash = "#runTrace";
    (await screen.findByRole("button", { name: "실행 추적 상세 보기" })).click(); // 실행 상세 열기
    // 같은 artifact가 단계 트레이스와 증빙 목록 양쪽에 ref로 나타날 수 있어 첫 번째를 클릭.
    const ref = (
      await screen.findAllByRole("button", {
        name: "증빙 72000000-0000-0000-0000-000000000001 조회",
      })
    )[0]!;
    ref.click();
    await waitFor(() =>
      expect(fetched).toContain("72000000-0000-0000-0000-000000000001"),
    ); // 8자리 축약 아닌 전체 uuid
    const lookup = screen.getByRole("region", { name: "증빙 조회" });
    expect(await within(lookup).findByText("추출 결과")).toBeInTheDocument();
    expect(within(lookup).getByText("조회 가능")).toBeInTheDocument();
    expect(within(lookup).getByText("보호 처리 상태")).toBeInTheDocument();
    expect(within(lookup).getByLabelText("결과 요약")).toHaveTextContent(
      "구조화 결과",
    );
    expect(within(lookup).getByLabelText("결과 요약")).toHaveTextContent(
      "자료 행 1건",
    );
    const details = within(lookup)
      .getByText("감사 세부 정보 보기")
      .closest("details") as HTMLDetailsElement | null;
    expect(details).not.toBeNull();
    expect(details?.open).toBe(false);
    fireEvent.click(within(lookup).getByText("감사 세부 정보 보기"));
    expect(details?.open).toBe(true);
    expect(
      within(details as HTMLDetailsElement).getByText("무결성 해시"),
    ).toBeInTheDocument();
    expect(
      within(details as HTMLDetailsElement).getByText("extract_result_json"),
    ).toBeInTheDocument();
    expect(
      within(details as HTMLDetailsElement).getByText("abc"),
    ).toBeInTheDocument();
  });

  // A4 — 빈 상태 진입 CTA: 권한 있으면 빈 목록 안에서 첫 자동화 만들기 유도, 클릭 시 작성 폼 오픈.
  test("A4: 빈 시나리오 목록의 CTA → 작성 폼 오픈(권한 있을 때)", async () => {
    renderApp(); // 기본 fake listScenarios = 빈 목록
    location.hash = "#scenarioStudio";
    const cta = await screen.findByRole("button", {
      name: "+ 첫 자동화 만들기",
    });
    cta.click();
    await waitFor(() =>
      expect(
        screen.getByRole("region", { name: "자동화 작성" }),
      ).toBeInTheDocument(),
    ); // ScenarioForm 작성 폼 오픈
  });

  test("A4: viewer는 빈 상태 CTA 미노출(RBAC)", async () => {
    localStorage.setItem("rpa.token", jwt(["viewer"]));
    renderApp();
    location.hash = "#scenarioStudio";
    await waitFor(() =>
      expect(
        screen.getByText(/저장된 자동화가 없습니다/),
      ).toBeInTheDocument(),
    );
    expect(
      screen.queryByRole("button", { name: "+ 첫 자동화 만들기" }),
    ).toBeNull();
  });

  test("A4: 자동화 저장 오류 details는 JSON 대신 업무용 요약으로 표시", async () => {
    renderApp(
      fakeClient({
        createScenario: async () => {
          throw new ApiError(422, "IR_SCHEMA_INVALID", {
            code: "IR_SCHEMA_INVALID",
            details: {
              field: "nodes.n1.what.0.action",
              reason: "unsupported_operation",
              detail: "api_call not enabled",
            },
          });
        },
      }),
    );
    location.hash = "#scenarioStudio";
    (await screen.findByRole("button", { name: "+ 첫 자동화 만들기" })).click();
    const form = await screen.findByRole("region", { name: "자동화 작성" });
    within(form).getByRole("button", { name: "저장" }).click();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("자동화 정의 오류.");
    expect(alert).toHaveTextContent("항목: nodes.n1.what.0.action");
    expect(alert).toHaveTextContent("사유: 지원하지 않는 동작입니다.");
    expect(alert).not.toHaveTextContent("{");
    expect(alert).not.toHaveTextContent("unsupported_operation");
  });

  test("A4: 자동화 검증 실패 리포트는 요약을 먼저 보여주고 원문 JSON은 접는다", async () => {
    renderApp(
      fakeClient({
        listScenarios: async () => ({
          items: [
            {
              scenario_id: "scn-validation",
              name: "검증 대상",
              version: 2,
              latest_version_id: "ver-validation",
              promotion_status: "draft",
            },
          ],
          next_cursor: null,
        }),
        getScenario: async (id) => ({
          scenario_id: id,
          name: "검증 대상",
          version: 2,
          promotion_status: "draft",
          ir: {
            meta: { name: "검증 대상", version: 2, studio_mode: "ir" },
            start: "n1",
            nodes: { n1: { terminal: "success" } },
          },
        }),
        validateScenario: async () => ({
          valid: false,
          report: {
            errors: [
              {
                instancePath: "/nodes/n1/what/0/action",
                message: "허용된 동작이 아닙니다.",
                schemaPath: "#/properties/nodes",
              },
            ],
            warnings: [],
          },
        }),
      }),
    );
    location.hash = "#scenarioStudio";
    (await screen.findByRole("button", { name: "편집" })).click();
    await screen.findByLabelText("자동화 정의 원문");
    screen.getByRole("button", { name: "검증" }).click();

    const summary = await screen.findByLabelText("검증 실패 요약");
    expect(summary).toHaveTextContent("오류 1건");
    expect(summary).toHaveTextContent(
      "지원하지 않는 자동화 동작입니다. 단계 편집에서 동작 유형을 다시 선택하세요.",
    );
    const details = within(summary)
      .getByText("원본 검증 결과 보기")
      .closest("details") as HTMLDetailsElement | null;
    expect(details).not.toBeNull();
    expect(details?.open).toBe(false);
  });

  // A6 — 셸 신뢰감: 역할 칩 + 사이드바 3그룹.
  test("A6: 탑바 역할 칩 표시(한국어 라벨)", async () => {
    renderApp();
    expect(await screen.findByText("관리자")).toBeInTheDocument(); // admin ∈ ALL_ROLES
    expect(screen.getByText("운영자")).toBeInTheDocument(); // operator
  });

  test("A6: 사이드바 3그룹 헤딩 + 18 nav item 유지", async () => {
    renderApp();
    const nav = screen.getByRole("navigation", { name: "주 메뉴" });
    expect(within(nav).getByText("제작")).toBeInTheDocument();
    expect(within(nav).getByText("운영")).toBeInTheDocument();
    expect(within(nav).getByText("고급 설정")).toBeInTheDocument();
    expect(within(nav).getAllByRole("button")).toHaveLength(18); // 그룹화 후에도 전 뷰 유지
  });

  // A6 회귀 가드: 그룹이 모든 뷰를 정확히 한 번씩 덮어야 한다(누락/중복 시 nav에서 사라짐).
  test("A6: NAV_GROUPS가 VIEW_KEYS를 정확히 분할", () => {
    const grouped = NAV_GROUPS.flatMap((g) => g.keys);
    expect([...grouped].sort()).toEqual([...VIEW_KEYS].sort());
    expect(grouped.length).toBe(VIEW_KEYS.length); // 중복 없음
  });

  test("A6: roles 없는 토큰 → '권한 미확인'(빈 폴백)", async () => {
    localStorage.setItem("rpa.token", "no-dot-token"); // decodeRoles → []
    renderApp();
    expect(
      await screen.findByText("권한 미확인 · 읽기 전용"),
    ).toBeInTheDocument();
    expect(screen.queryByText("관리자")).toBeNull();
  });

  // A5 — 사람 확인 종류 한국어 라벨(kindLabel 배선, raw 영문 enum 제거).
  test("A5: 사람 확인 '종류'가 한국어 라벨", async () => {
    renderApp(
      fakeClient({
        listHumanTasks: async () => ({
          items: [
            {
              human_task_id: "h",
              state: "open",
              kind: "captcha",
              assignee: null,
              timeout: null,
              on_timeout: null,
              run_id: null,
            },
          ],
          next_cursor: null,
        }),
      }),
    );
    location.hash = "#humanTasks";
    await waitFor(() =>
      expect(screen.getByText("보안문자")).toBeInTheDocument(),
    ); // captcha → 보안문자 (필터 드롭다운 option의 raw enum은 별개)
  });

  // A3 — 수동 입력 조회(전체 uuid, 원래 1차 기능).
  test("A3: 수동 입력 조회 → getArtifact(전체 uuid)", async () => {
    const fetched: string[] = [];
    const uuid = "72000000-0000-0000-0000-000000000001";
    renderApp(
      fakeClient({
        getArtifact: async (id) => {
          fetched.push(id);
          return {
            artifact_id: id,
            type: "screenshot",
            sha256: id,
            redaction_status: "redacted",
            retention_until: null,
            content: `본문-${id}`,
          };
        },
      }),
    );
    location.hash = "#runTrace";
    fireEvent.change(await screen.findByLabelText("증빙 번호"), {
      target: { value: uuid },
    });
    screen.getByRole("button", { name: "조회" }).click();
    await waitFor(() => expect(fetched).toContain(uuid));
  });

  // A3 — 무효 uuid artifact 해시는 자동 조회하지 않음(가드).
  test("A3: 무효 uuid artifact 해시는 입력을 시드하지 않음", async () => {
    renderApp();
    location.hash = "#runTrace?artifact=not-a-uuid";
    const input = await screen.findByLabelText("증빙 번호");
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { level: 1, name: "실행 기록" }),
      ).toBeInTheDocument(),
    );
    expect(input).toHaveValue(""); // 무효 → 시드 안 됨
  });

  // A3 — 리뷰 회귀: 수동으로 다른 산출물을 본 뒤 ref를 재클릭하면 원래 산출물로 복귀(과거 해시 동일 → 무반응 버그 수정).
  test("A3: 수동 조회 후 ref 재클릭 → 원래 산출물로 복귀", async () => {
    const Y = "72000000-0000-0000-0000-000000000001";
    const Z = "99999999-0000-0000-0000-000000000009";
    const fetched: string[] = [];
    renderApp(
      fakeClient({
        getArtifact: async (id) => {
          fetched.push(id);
          return {
            artifact_id: id,
            type: "extract_result_json",
            sha256: id,
            redaction_status: "redacted",
            retention_until: null,
            content: `본문-${id}`,
          };
        },
      }),
    );
    location.hash = "#runTrace";
    (await screen.findByRole("button", { name: "실행 추적 상세 보기" })).click();
    (
      await screen.findAllByRole("button", { name: `증빙 ${Y} 조회` })
    )[0]!.click();
    await waitFor(() => expect(fetched).toContain(Y));
    fireEvent.change(screen.getByLabelText("증빙 번호"), {
      target: { value: Z },
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "조회" })).toBeEnabled(),
    );
    screen.getByRole("button", { name: "조회" }).click();
    await waitFor(() => expect(fetched).toContain(Z));
    (
      await screen.findAllByRole("button", { name: `증빙 ${Y} 조회` })
    )[0]!.click();
    await waitFor(() =>
      expect(fetched.filter((id) => id === Y)).toHaveLength(2),
    ); // 무반응 아님(해시 동일-회귀 수정)
  });
  test("A3: media artifact lookup previews video when media_type is missing", async () => {
    installObjectUrlMock();
    const fetchedBlobs: string[] = [];
    const uuid = "72000000-0000-0000-0000-000000000001";
    renderApp(
      fakeClient({
        getArtifact: async (id) => ({
          artifact_id: id,
          type: "video_masked",
          media_type: null,
          filename: "run.webm",
          sha256: id,
          redaction_status: "redacted",
          retention_until: null,
          content: "TEXT_SHOULD_NOT_RENDER_FOR_MEDIA",
        }),
        getArtifactBlob: async (id) => {
          fetchedBlobs.push(id);
          return new Blob([new Uint8Array([1, 2, 3])], { type: "video/webm" });
        },
      }),
    );
    location.hash = `#runTrace?artifact=${uuid}`;
    const video = await screen.findByLabelText("run.webm");
    expect(video).toHaveAttribute("src", "blob:test-preview");
    expect(fetchedBlobs).toContain(uuid);
    expect(screen.queryByText("TEXT_SHOULD_NOT_RENDER_FOR_MEDIA")).toBeNull();
  });
});

// Phase 2 온보딩 — 빈 첫 화면(실행 0건)에 첫-실행 단일 CTA 배너.
// 판정 키 = recent(무필터 listRuns).items.length===0 && next_cursor===null(진짜 0). RBAC로 CTA 분기.
describe("Phase 2 온보딩", () => {
  beforeEach(() => {
    location.hash = "";
    localStorage.setItem("rpa.token", jwt(ALL_ROLES));
  });

  const ONBOARD_CTA = "자동화 화면으로 가기";

  // (1) 빈 대시보드 + run.create 보유 → CTA 노출, 클릭 시 scenarioStudio로 이동.
  test("빈 대시보드 + run.create → CTA 노출·클릭 시 #scenarioStudio", async () => {
    renderApp(
      fakeClient({ listRuns: async () => ({ items: [], next_cursor: null }) }),
    );
    const cta = await screen.findByRole("button", { name: ONBOARD_CTA });
    cta.click();
    await waitFor(() => expect(location.hash).toBe("#scenarioStudio"));
  });

  // (2) 실행 ≥1건이면 배너 미노출(회귀 가드): 기본 fakeClient(listRuns 1건) → 배너 텍스트 없음, 지표·'최근 실행' 유지.
  test("실행 ≥1건이면 배너 미노출(지표·최근 실행 유지)", async () => {
    renderApp(); // 기본 fakeClient: listRuns 1건(running), next_cursor null
    await waitFor(() =>
      expect(screen.getByText("최근 실행")).toBeInTheDocument(),
    );
    expect(screen.queryByRole("button", { name: ONBOARD_CTA })).toBeNull();
    expect(screen.getByRole("button", { name: /실행 중/ })).toBeInTheDocument(); // 지표 카드 유지
  });

  // (3) 절단된 0 가드(조용한 false 금지): next_cursor 있으면 '더 있음' → 진짜 0 아님 → 배너 미노출.
  test("절단된 0(next_cursor 있음)은 빈 테넌트로 오판하지 않음", async () => {
    renderApp(
      fakeClient({ listRuns: async () => ({ items: [], next_cursor: "x" }) }),
    );
    await waitFor(() =>
      expect(screen.getByText("최근 실행")).toBeInTheDocument(),
    );
    expect(screen.queryByRole("button", { name: ONBOARD_CTA })).toBeNull();
  });

  // (4) viewer(권한 없음): 안내 문구는 보이되 CTA 버튼은 미생성(없는 권한 동선 창작 금지).
  test("viewer는 안내 문구만, CTA 버튼 미노출(RBAC)", async () => {
    localStorage.setItem("rpa.token", jwt(["viewer"]));
    renderApp(
      fakeClient({ listRuns: async () => ({ items: [], next_cursor: null }) }),
    );
    await waitFor(() =>
      expect(
        screen.getByText(/아직 등록된 실행이 없습니다/),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByRole("button", { name: ONBOARD_CTA })).toBeNull();
    expect(screen.queryByRole("button", { name: /가기/ })).toBeNull();
  });

  // (5) 역할 미확인(roles 없음): '데이터 없음'이 아니라 '권한/설정 문제'로 안내 — 무데이터(viewer)와 구분.
  test("역할 미확인 사용자는 권한 요청 안내(무데이터 문구와 구분)", async () => {
    localStorage.setItem("rpa.token", jwt([]));
    renderApp(
      fakeClient({ listRuns: async () => ({ items: [], next_cursor: null }) }),
    );
    await waitFor(() =>
      expect(screen.getByText(/IT 담당자에게 접근 권한을 요청하세요/)).toBeInTheDocument(),
    );
    // viewer용 '아직 등록된 실행이 없습니다' 문구와 다르고, CTA도 없다.
    expect(screen.queryByText(/아직 등록된 실행이 없습니다/)).toBeNull();
    expect(screen.queryByRole("button", { name: ONBOARD_CTA })).toBeNull();
  });
});
