# RPA Console UI/UX 분석

Date: 2026-07-09
Scope: 현재 React 콘솔 화면, 2026-07-09 쉬운 시작/Workato-inspired 설계안, PC 콘솔 우선 흐름
Evidence: `screenshots/*.png`, `screen-summaries.json`, `mobile-summary.json`

## 감사 단계

| Step | 화면 | 상태 |
| ---: | --- | --- |
| 1 | 기본/전체 권한 `#myWork` | 정상. 업무 확인과 자동화 목록은 잘 보이나 첫 자동화 여정의 시작점은 약함 |
| 2 | 운영자 `#myWork` | 정상. 반복 업무자 홈으로는 좋지만 신규 사용자에게는 내비 항목이 많음 |
| 3 | 운영자 `#scenarioStudio` | 양호. 자연어 입력과 녹화 경로가 이미 첫 화면에 있음 |
| 4 | 운영자 `#playground` | 보통. 실행 전 테스트가 별도 화면이라 생성 흐름과 끊김 |
| 5 | 운영자 `#runTrace` | 보통. 운영 로그로는 좋지만 테스트 성공 후 다음 행동이 약함 |
| 6 | 운영자 `#dashboard` | 양호. readiness/증빙 철학은 강함. 첫 화면 정보량은 높음 |
| 7 | 관리자 `#security?section=sites` | 좋음. 보안 허브/섹션화는 설계 방향과 잘 맞음 |
| 8 | 관리자 `#connectorCatalog` | 보통. 템플릿 검토는 가능하나 "무엇이 만들어지는지" 미리보기 부족 |
| 9 | 모바일 운영자 `#myWork` | 위험. 표/행 버튼이 오른쪽으로 잘려 보임 |
| 10 | 운영자 실행 상세 | 보통. 완료 상태는 명확하나 증빙/다음 행동 CTA가 약함 |
| 11 | 자동화 만들기 하단/녹화 | 양호. 녹화 흐름은 노출되지만 생성/테스트/증빙의 단일 여정은 아님 |

## 점수

| 평가 항목 | 현재 구현 | Claude 설계 방향 구현 후 기대 | 코멘트 |
| --- | ---: | ---: | --- |
| 첫 행동 명확성 | 84 | 91 | `자동화 만들기` 화면은 좋아졌지만 기본 홈은 아직 업무 처리 중심 |
| 첫 자동화 완주 자신감 | 80 | 92 | 생성, 준비, 테스트, 증빙이 아직 화면별로 분리됨 |
| 정보 구조/내비 | 82 | 88 | 운영자도 메뉴 모드와 여러 route를 봄. 과감한 통합 여지 있음 |
| 보안/증빙 신뢰 | 90 | 93 | no silent green, SecretRef, readiness 철학은 강점 |
| 운영자 일상 사용성 | 86 | 89 | `myWork`는 유용하므로 완전 제거보다 역할/상황별 landing 권장 |
| 템플릿/커넥터 시작성 | 78 | 88 | catalog는 풍부하지만 템플릿 상세/생성 연결이 약함 |
| 테스트 실행 UX | 76 | 90 | 별도 `playground`보다 생성 화면 안 `TestProgress`가 더 좋음 |
| 접근성/반응형 리스크 | 74 | 82 | PC 우선이면 허용 가능. 모바일은 버튼 clipping 확인됨 |
| 구현 착수 준비도 | 86 | 90 | 방향은 좋지만 일부 문서 한글 깨짐과 route 제거 결정은 정리 필요 |

종합: 현재 구현은 84/100, 설계 방향은 90/100, 설계 정리 후 구현 기대치는 91-93/100.

## 강점

- 현재 `자동화 만들기`는 자연어 입력, 시작 주소, 사이트 선택, AI 모델, 새 사이트 온보딩, 브라우저 녹화까지 한 화면에 있어 첫 생성 표면으로 충분히 발전해 있다.
- 보안/개인정보 화면은 이미 허브와 섹션 구조를 갖고 있어 "사이트·브라우저 세션"부터 시작하는 adoption corridor에 적합하다.
- dashboard readiness는 `확인 필요`, `준비됨`, `차단`을 구분하려는 철학이 좋다. 이 제품의 핵심 신뢰 포인트다.
- `myWork`는 운영자 일상 화면으로 가치가 있다. 사람이 확인할 일과 자동화 실행이 함께 있어 실제 운영에는 자연스럽다.

## 주요 리스크

1. `myWork`를 무조건 제거하거나 `create`를 전 사용자 기본값으로 바꾸는 것은 위험하다. 신규 도입/첫 자동화에는 create가 맞지만, 운영 중인 operator는 `myWork`가 더 맞다.
2. `playground`가 별도 route로 남아 있으면 "만들고 바로 테스트" 흐름이 끊긴다. 설계안처럼 테스트 진행 패널을 생성/실행 상세 안으로 흡수하는 쪽이 낫다.
3. 실행 상세는 완료/실패 상태를 보여주지만 성공 후 `증빙 확인`, `운영 예약`, `계속 고치기` 같은 후속 CTA가 약하다.
4. 커넥터/템플릿은 목록은 좋지만 사용자가 템플릿을 누르기 전에 어떤 자동화가 만들어질지 확신하기 어렵다.
5. 모바일은 PC 우선 범위라고 해도 현재 표 action 버튼이 잘린다. 최소한 horizontal overflow나 버튼 wrapping은 방어해야 한다.
6. 최신 설계 문서 일부에서 한글 깨짐이 보여 구현자 handoff 리스크가 있다. 실제 파일 인코딩/원문을 개발 착수 전에 정리해야 한다.

## 추천 방향

1. 첫 화면은 역할/상태별로 분기한다: 첫 자동화가 없거나 onboarding 중이면 `자동화 만들기`, 확인 업무가 있으면 `내 할 일`, 관리자는 readiness dashboard.
2. `playground`는 유지보다 흡수/redirect가 낫다. `자동화 만들기` 안에서 초안 생성 후 바로 `TestProgress`로 이어지게 만든다.
3. 실행 상세 상단에 `TestRunStatusPanel`을 둔다. 완료: `증빙 확인` primary, `운영 예약` secondary. 실패: 복구 CTA primary.
4. `GlobalCreateMenu`는 도입 가치가 크다. 단, 메뉴는 생성/설정/증빙 시작점만 담고 일반 navigation을 중복하지 않는다.
5. 템플릿 상세 패널을 먼저 만든다. P0에서는 metadata 기반 미리보기만 보여주고 ordered step은 API 계약 전까지 만들지 않는다.
6. 보안 허브는 현재 방향을 유지하되, `사이트·브라우저 세션`이 adoption 첫 단계임을 더 강하게 노출한다.
7. 모바일은 제품 핵심이 아니어도 clipping은 수정한다. 표 행 action을 카드형/세로형으로 접거나 action column을 줄인다.

## 구현 우선순위

P0:
- `TestProgress`/`TestRunStatusPanel`로 생성-테스트-증빙 연결
- 실행 상세 성공/실패 CTA 강화
- 템플릿 상세 패널
- 모바일 action clipping 방어

P1:
- 역할/상태 기반 기본 landing
- `GlobalCreateMenu`
- `playground` route 흡수/redirect
- evidence continuation 강화

P2:
- focused studio mode
- activity timeline summary
- dedicated adoption/evidence route 여부 결정

## 검증 한계

- 스크린샷 기반 감사라 실제 키보드 포커스 순서, 스크린리더 발화, 모든 컬러 대비는 완전 검증하지 않았다.
- 실행 루프는 `DEV_DISABLE_RUN_LOOP=1` 상태라 실제 run progress animation은 확인하지 않았다.
- 모바일은 한 화면만 spot check했다. PC 콘솔 우선 범위라 전체 모바일 UX 점수는 별도 감사가 필요하다.
