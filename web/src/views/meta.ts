import type { ViewKey } from "../router";

// viewMeta — rpa_enterprise_console.html(2199~)에서 이식. [title, subtitle] + nav 아이콘(lucide-react).
export const VIEW_META: Record<ViewKey, { title: string; subtitle: string; icon: string }> = {
  scenarioStudio: { title: "자동화 만들기", subtitle: "업무를 한 번 보여주고 반복 실행할 자동화 시나리오로 정리", icon: "Video" },
  playground: { title: "테스트 실행", subtitle: "만든 자동화를 안전하게 시험 실행하고 실제 실행 전 결과를 확인", icon: "PlaySquare" },
  dashboard: { title: "RPA 운영 대시보드", subtitle: "실행 상태, 사람 확인, AI 비용, 보안 상태를 통합 모니터링", icon: "LayoutDashboard" },
  openGate: { title: "Product-open 점검", subtitle: "계약 기준으로 화면, 액션, 보안 gate가 검증 가능한지 확인", icon: "ClipboardCheck" },
  workitems: { title: "작업 목록", subtitle: "대기, 재시도, 실패, 외부 전달 상태를 추적", icon: "ListChecks" },
  humanTasks: { title: "사람 확인", subtitle: "보안문자, 추가 인증, 승인, 검증 업무를 담당자 기준으로 처리", icon: "Inbox" },
  runTrace: { title: "실행 기록", subtitle: "자동화가 어떤 순서로 판단하고 실행했는지 조회", icon: "Route" },
  irValidation: { title: "시나리오 검사", subtitle: "자동화 시나리오의 문법, 연결, 성공 기준을 배포 전에 검사", icon: "FileCode2" },
  llmGateway: { title: "AI 모델 설정", subtitle: "AI 실행기, 실시간 응답, 예산, 결과 형식 정책", icon: "Bot" },
  security: { title: "보안/개인정보", subtitle: "비밀번호, 개인정보 마스킹, 사이트 접근 정책, 감사 이벤트", icon: "ShieldCheck" },
  idempotency: { title: "중복 방지", subtitle: "같은 데이터를 반복 저장하거나 전송하지 않도록 보장", icon: "DatabaseZap" },
};
