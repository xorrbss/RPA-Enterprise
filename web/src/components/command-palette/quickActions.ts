import type { ViewKey } from "../../router";

export interface QuickActionSpec {
  readonly id: string;
  readonly label: string;
  readonly hint: string;
  readonly view: ViewKey;
  readonly params?: Record<string, string>;
  readonly keywords: readonly string[];
}

export const QUICK_ACTIONS: readonly QuickActionSpec[] = [
  {
    id: "failed-system-runs",
    label: "시스템 실패 실행 보기",
    hint: "실행 기록을 시스템 실패 상태로 필터",
    view: "runTrace",
    params: { status: "failed_system" },
    keywords: ["failed", "failure", "error", "system failure", "failed runs", "실패", "장애", "시스템", "실행", "run"],
  },
  {
    id: "failed-business-runs",
    label: "업무 실패 실행 보기",
    hint: "실행 기록을 업무 실패 상태로 필터",
    view: "runTrace",
    params: { status: "failed_business" },
    keywords: ["failed", "failure", "business failure", "failed runs", "실패", "업무", "실행", "run"],
  },
  {
    id: "queued-runs",
    label: "대기 실행 보기",
    hint: "실행 기록을 대기 상태로 필터",
    view: "runTrace",
    params: { status: "queued" },
    keywords: ["queued", "queue", "waiting", "pending", "대기", "큐", "실행", "run"],
  },
  {
    id: "automation-test",
    label: "테스트 실행",
    hint: "만들기 콘솔에서 계획 확인 후 시험 실행",
    view: "create",
    params: { focus: "test" },
    keywords: ["test", "testing", "playground", "run test", "테스트", "시험", "실행", "계획", "자동화"],
  },
  {
    id: "human-task-inbox",
    label: "사람확인 인박스 열기",
    hint: "사람 확인 업무 목록으로 이동",
    view: "humanTasks",
    keywords: ["human task", "human tasks", "inbox", "review", "approval", "사람확인", "사람 확인", "인박스", "검토", "승인"],
  },
  {
    id: "credential-management",
    label: "Credential 관리 열기",
    hint: "보안 화면의 Credential 관리 영역으로 이동",
    view: "security",
    params: { section: "secrets", focus: "credentials" },
    keywords: ["credential", "credentials", "secret", "secrets", "password", "자격증명", "비밀", "시크릿", "계정", "보안"],
  },
  {
    id: "worker-pool-management",
    label: "Worker Pool 관리 열기",
    hint: "보안 화면의 Worker Pool 관리 영역으로 이동",
    view: "security",
    params: { section: "infra", focus: "worker-pools" },
    keywords: ["worker pool", "worker pools", "pool", "workers", "bot pool", "워커", "풀", "작업자", "봇풀", "보안"],
  },
  {
    id: "automation-report",
    label: "Automation report 열기",
    hint: "대시보드의 자동화 성과 리포트로 이동",
    view: "dashboard",
    params: { focus: "automation-report" },
    keywords: ["automation report", "performance report", "report", "metrics", "성과", "리포트", "보고서", "자동화"],
  },
  {
    id: "adoption-evidence",
    label: "도입 증빙 열기",
    hint: "파일럿 준비도와 감사·보안 증빙 패킷 확인",
    view: "adoptionEvidence",
    keywords: ["adoption", "evidence", "readiness", "audit packet", "pilot", "도입", "증빙", "준비", "심사", "파일럿"],
  },
];
