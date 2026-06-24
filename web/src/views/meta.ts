import type { ViewKey } from "../router";

// viewMeta — rpa_enterprise_console.html(2199~)에서 이식. [title, subtitle] + nav 아이콘(lucide-react).
// helpText — 도입 담당자용 '?' 맥락 도움말. 각 화면이 '언제·무엇을 위해' 쓰는지 운영자 문장으로 설명한다.
//            (각 view 컴포넌트 주석의 화면 의도를 옮긴 것 — 없는 기능은 만들지 않는다. 없으면 subtitle 폴백)
export const VIEW_META: Record<ViewKey, { title: string; subtitle: string; icon: string; helpText?: string }> = {
  coePipeline: { title: "업무 발굴/ROI", subtitle: "자동화 후보, 승인 단계, 예상 절감효과를 CoE 관점에서 관리", icon: "Lightbulb", helpText: "자동화로 만들 업무를 발굴하고, 승인 단계를 거쳐 예상 절감효과(ROI)를 비교·관리하는 화면입니다." },
  connectorCatalog: { title: "커넥터/템플릿", subtitle: "브라우저 RPA 중심 재사용 커넥터와 업무 템플릿 후보를 검토", icon: "Plug", helpText: "이미 만들어 둔 재사용 커넥터와 업무 템플릿을 둘러보고, 새 자동화의 출발점으로 고를 때 사용합니다." },
  objectRepository: { title: "화면 요소 저장소", subtitle: "사이트별 버튼, 필드, 테이블 조건을 재사용 가능한 업무 요소로 관리", icon: "MousePointerClick", helpText: "사이트마다 반복해서 쓰는 버튼·입력칸·표 같은 화면 요소를 등록해 여러 자동화에서 재사용합니다." },
  scenarioStudio: { title: "자동화 만들기", subtitle: "업무를 한 번 보여주고 반복 실행할 자동화로 정리", icon: "Video", helpText: "업무 절차를 정리해 반복 실행할 자동화로 만드는 화면입니다. 말로 설명하거나 쉬운 양식으로 만들 수 있습니다." },
  playground: { title: "테스트 실행", subtitle: "만든 자동화를 안전하게 시험 실행하고 실제 실행 전 결과를 확인", icon: "PlaySquare", helpText: "만든 자동화를 실제 운영에 올리기 전에, 안전한 시험 실행으로 결과를 미리 확인합니다." },
  dashboard: { title: "RPA 운영 대시보드", subtitle: "실행 상태, 사람 확인, 실패, 작업 항목·외부 전달 재처리 대기를 통합 모니터링", icon: "LayoutDashboard", helpText: "지금 실행 중인 자동화, 사람 확인 대기, 실패, 재처리 대기를 한눈에 모아 보는 운영 시작 화면입니다." },
  automationOps: { title: "오케스트레이션", subtitle: "실행 예약, 트리거, 큐, 알림 운영을 한 곳에서 점검", icon: "CalendarClock", helpText: "자동화의 실행 예약·트리거·대기 큐·알림 같은 운영 설정을 한 곳에서 점검합니다." },
  documentIdp: { title: "문서 자동화", subtitle: "브라우저 산출물의 필드 추출, 검증 큐, 증빙 연결을 관리", icon: "FileSearch", helpText: "자동화가 만들어 낸 문서에서 필요한 값을 뽑아내고, 검증 대기 건과 증빙 연결을 관리합니다." },
  openGate: { title: "Product-open 점검", subtitle: "계약 기준으로 화면, 액션, 보안 gate가 검증 가능한지 확인", icon: "ClipboardCheck", helpText: "정식 오픈 전, 계약 문서 기준으로 화면·액션·보안 통제가 검증 가능한 상태인지 점검하는 문서형 화면입니다." },
  workitems: { title: "작업 목록", subtitle: "대기, 재시도, 실패, 외부 전달 상태를 추적", icon: "ListChecks", helpText: "자동화가 처리하는 개별 작업이 대기·재시도·실패·외부 전달 중 어디에 있는지 추적합니다." },
  humanTasks: { title: "사람 확인", subtitle: "보안문자, 추가 인증, 승인, 검증 업무를 담당자 기준으로 처리", icon: "Inbox", helpText: "보안문자·추가 인증·승인·검증처럼 사람이 직접 처리해야 하는 작업을 담당자별로 모아 처리합니다." },
  approvalInbox: { title: "결재 인박스", subtitle: "하이웍스 결재 목록을 수집·요약하고 건별로 승인/반려", icon: "Stamp", helpText: "하이웍스 결재 목록을 모아 요약하고, 한 건씩 검토해 승인하거나 반려합니다." },
  runTrace: { title: "실행 기록", subtitle: "자동화가 어떤 순서로 판단하고 실행했는지 조회", icon: "Route", helpText: "특정 실행이 어떤 순서로 판단하고 무엇을 실행했는지 단계별로 되짚어 보는 화면입니다." },
  auditExplorer: { title: "감사 이력", subtitle: "보안 판단, 처리자, 결과, 추적 번호를 조회", icon: "ScrollText", helpText: "누가·언제·무엇을 했고 보안 판단 결과가 어땠는지, 추적 번호로 조회하는 감사 기록 화면입니다." },
  irValidation: { title: "자동화 검사", subtitle: "자동화 정의의 문법, 연결, 성공 기준을 배포 전에 검사", icon: "FileCode2", helpText: "자동화 정의를 배포하기 전에 문법·연결·성공 기준이 올바른지 미리 검사합니다(저장은 하지 않습니다)." },
  llmGateway: { title: "AI 모델 설정", subtitle: "AI 실행기, 실시간 응답, 예산, 결과 형식 정책", icon: "Bot", helpText: "자동화가 사용하는 AI 모델과 실시간 응답·예산·결과 형식 정책을 설정합니다." },
  security: { title: "보안/개인정보", subtitle: "비밀번호, 개인정보 마스킹, 사이트 접근 정책, 감사 이벤트", icon: "ShieldCheck", helpText: "비밀번호 보관, 개인정보 마스킹, 사이트 접근 정책, 보안 이벤트 같은 보안·개인정보 설정을 관리합니다." },
  idempotency: { title: "중복 방지", subtitle: "같은 데이터를 반복 저장하거나 전송하지 않도록 보장", icon: "DatabaseZap", helpText: "같은 데이터를 중복 저장하거나 두 번 전송하지 않도록 막는 중복 방지 동작을 설명하는 화면입니다." },
};
