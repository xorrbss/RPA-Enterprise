# RPA 도입 평가 90점+ 설계 보강안

Date: 2026-06-29
Status: 설계 v0.4 후보. 외부 설계 검토 반영 완료. 개발 승인 전 도입 평가 기준 문서.

Purpose:
- 첨부 리포트의 57.6/100 평가를 "기업 솔루션 도입 담당자 관점에서 설계만으로 90점 이상"이 가능한 상태로 끌어올린다.
- 이 문서는 구현 완료 증거가 아니다. 현재 worktree의 구현 초안은 설계 점수 산정에 포함하지 않는다.
- 90점은 "범용 RPA 대체"가 아니라 "고보안 웹 자동화 + 거버넌스 + 기존 RPA 공존 전략"으로 달성한다.

Related documents:

Implementation evidence update (2026-06-29):
- MD-1, MD-2, MIG-1, DEP-01, K8S-1, and HB-1 now have repo-local implementation evidence in contracts, runtime code, DB/Compose/Kubernetes packaging, and focused tests.
- MD-1 now also covers due cron run-trigger tenant discovery: `maintenance.run_trigger_tenant_discovery` uses the same dedicated lifecycle BYPASSRLS pool boundary as due maintenance work when `MAINTENANCE_TENANT_IDS` is empty.
- Credential lease enforcement now has runtime evidence: run claim/resume acquire scenario credential slots before browser drive can resolve executor secrets, credential slot contention returns `SESSION_LOCKED` without executor bind, newly reserved browser leases are deleted on credential contention, and terminal/resume/abort paths release active credential leases by run.
- Browser egress enforcement now has runtime evidence: browser session bind requires a CDP `Fetch`/`Network` guard before executor/resolver access, production composition injects `PgDurableSecurityAuditDecisionWriter`, and focused tests cover audit-before-continue, audit-failure fail-closed behavior, off-allowlist subresource/fetch, iframe/document, WebSocket, download, wildcard, `blob:`, and child-session/OOPIF handling.
- Pilot restore evidence now includes `npm --prefix codegen run db:restore-drill:temp`; production PITR/managed-backup restore evidence is still a promotion requirement.
- Reporting/ROI evidence now includes daily trends, model-cost attribution, decision signals, ROI source/stage lineage, export evidence, and compact dashboard visualizations for source mix, stage mix, and model-cost trend. Advanced BI drilldowns remain future analytics work rather than a Product Open v1 blocker.
- Automation Idea Pilot Readiness Evidence v1 is now a contract surface: `GET/POST /v1/automation-ideas/{idea_id}/adoption-evidence` records metadata-only pilot charter, RACI, training completion, and support model sign-off status (`valid|failed|deferred`) under existing `automation_idea.read/manage` RBAC. The ledger stores opaque `evidence_ref` values only; raw URLs, tokens, passwords, webhook secrets, resolved SecretRef material, long raw documents, and raw training rosters remain forbidden.
- Local staging release rehearsal evidence now validates packet shape/redaction safety without claiming row 43 closure, and inbound webhook trigger UX no longer implies that owner-side external producer registration is complete.
- IDP/OCR extensibility is no longer a blank scope-out: `POST /v1/document-jobs/{job_id}/external-extractions` opens a metadata-only external adapter intake for provider-normalized field values, provider receipts, opaque evidence refs, confidence, and non-secret metadata. It does not provide an OCR engine, image/PDF OCR, provider selection, raw OCR text storage, raw endpoint URLs, tokens, signed URLs, provider response bodies, or resolved SecretRef material.
- Sink delivery now has a repo-local `real_sink` egress boundary rather than a port-only future scope: the runtime capability is SecretRef-backed, HTTPS-only, `allowed_hosts`-checked, and uses `sink_idempotency_key` as the downstream `Idempotency-Key`. Production/customer delivery claims still require owner evidence for endpoint ownership, allowed-host approval, and SecretRef provisioning; Authorization headers and raw payloads must not be logged, and retry/dead-letter behavior remains unchanged.
- Controlled-prod readiness is now explicit rather than implicit: `GET /v1/ops/production-readiness` and the Orchestration console compute runtime blockers from tenant evidence; external alert delivery can use a fresh metadata-only provider receipt ledger entry, while owner-controlled PITR/restore drill evidence, SLO/on-call sign-off, support/training completion, and observability telemetry wiring stay `deferred` or `blocked` until owner evidence exists. Valid external alert evidence must carry a non-empty reference plus `channel`, `provider_alias`, `receipt_id`, `receipt_at`, and `delivery_status=delivered`; valid SLO/on-call evidence must carry a non-empty reference plus dashboard, severity-model, on-call rota, RACI, and support-hours metadata; valid support/training evidence must carry a non-empty reference plus `support_model_ref`, `training_completion_ref`, `trained_role_count`, `trained_user_count`, `coverage_percent`, and `completed_at`; valid managed backup/PITR evidence must carry backup policy, restore scope, restore completion time, RTO <= 120 minutes, and RPO <= 15 minutes; valid observability evidence must carry `exporter=prometheus|otlp`, collector, dashboard, alert-route, and sample timestamp metadata. Free-form owner text alone is rejected. Prod scenario release approve/deploy now fail closed unless `summary.controlled_prod_ready=true`; rollback remains a recovery path and is not blocked by readiness. The staging release packet validator now requires `controlled-prod readiness snapshot`, `external alert delivery evidence`, and `ops webhook sender evidence` fields so release evidence cannot omit delivered-only external alert metadata, SecretRef-only webhook sender aliases, or `external_alert_delivery`/`support_training_completion`/`observability_telemetry_wiring` deferred/valid state.
- Controlled-prod production-open evidence is now separated from staging governance evidence: `prod-readiness-packet:fixtures` / `prod-readiness-packet:validate` define the owner packet shape for `summary.controlled_prod_ready=true`, `external_alert_delivery=pass`, `managed_backup_restore_drill=pass`, `slo_oncall_signoff=pass`, `support_training_completion=pass`, `observability_telemetry_wiring=pass`, delivered alert metadata, PITR/restore RTO/RPO evidence, SLO/on-call metadata, support/training metadata, observability telemetry metadata, and negative proof against endpoint URLs, webhook URLs, dashboard URLs, raw rosters/user lists/training documents, tokens, fake/test evidence, and resolved SecretRef material.
- The PR0 pilot design gate can be treated as 90+ design-ready after the recorded local gates pass; production readiness still excludes HA/DR/failover, platform namespace/ingress approval, actual owner evidence for PITR/SLO/on-call/support training, and external deployment approval.
- Do not present this as full enterprise RPA replacement readiness. The approved positioning remains governed AI-native web automation plus federation with existing RPA/IDP/integration tools.
- `docs/rpa-adoption-full-design-2026-06-29.md`: P0 구현 분해 기준
- `docs/rpa-adoption-pr0-draft-audit-2026-06-29.md`: 미승인 구현 초안 감사
- `docs/current-readiness-report.md`: 현재 준비도
- `docs/rpa-gap-remediation-plan-2026-06-27.md`: 갭 해소 초안
- 첨부 검토 리포트: 종합 73/100, 설계 문서 약 80, 초안 구현 약 63

## 0. 외부 검토 반영 요약

첨부 검토 리포트의 결론을 수용한다. 현재 상태는 "설계 방향은 승인 가능하지만, 초안 구현은 채택 불가"다.

| 검토 지적 | 설계 반영 |
|---|---|
| 종합 73/100, 설계 약 80, 초안 구현 약 63 | 본 문서는 90점+ 목표 설계이며, 현재 구현 준비도 점수로 주장하지 않는다 |
| MD-1 maintenance 자동발견의 무가드 BYPASSRLS 의존 | tenant별 non-bypass 실행 또는 전용 BYPASSRLS role + `bypassrls.use` audit 없이는 금지 |
| MD-2 integrity/orphan sweeper가 기본 배포에서 휴면 가능 | daily sweeper는 빈 `MAINTENANCE_TENANT_IDS`에 의존하지 않도록 설계 |
| MIG-1 baseline 검증이 계약보다 얕음 | baseline은 정책 본문, 제약, FK, trigger, strict tenant RLS까지 검증해야 함 |
| DEP-01 compose superuser 사용이 RLS 검증을 가림 | local/pilot도 app-role은 non-`SUPERUSER`/non-`BYPASSRLS`로 분리해야 함 |
| HB-1 heartbeat가 worker dependency 초기화보다 먼저 시작 | heartbeat는 의존성 준비 후 시작하거나 startup 실패 시 반드시 stop |
| DC-3 ROI payback이 적자 자동화를 유한 payback으로 합성 | `monthly_value <= 0`이면 `payback_months = null`, `viability = not_viable` |
| CC-2 worker stale 2분 임계가 SSoT에 없음 | `ops-defaults.md`에 `worker.stale_threshold`를 등록 |

따라서 v0.4의 92점은 "위 설계 보강 조건이 계약 문서에 반영되고, 구현 초안이 그 조건을 통과할 때의 목표 점수"다. 조건 미충족 상태에서는 첨부 검토 리포트의 73/100 판단을 현재 준비도 기준으로 유지한다.

## 1. 결론

현재 설계 v0.2는 개발 가능한 P0 분해에는 충분하지만, 기업 도입 담당자에게 90점 이상으로 보이기에는 "운영/지원/도입 패키지"가 부족하다. 특히 다음 네 가지가 점수를 막는다.

| 감점 영역 | 현재 v0.2 상태 | 90점+ 보강 방향 |
|---|---|---|
| 시장 포지셔닝 | web-only 파일럿으로 정직하지만, 기존 RPA와의 공존 가치가 약함 | "보안형 웹 자동화 엔진 + 기존 RPA federation layer"로 명확화 |
| 운영 신뢰성 | Docker/Compose, migration, heartbeat, sweeper, observability가 P0로 분해됨 | 파일럿/운영 승격 gate, RPO/RTO, restore drill, SLO, incident pack을 설계에 포함 |
| 도입 체계 | 기술 설계 중심 | CoE, 지원 RACI, 교육, 운영권한, 변경승인, ROI/TCO pack 추가 |
| 생태계 격차 | Desktop/SAP/Citrix/OCR/IDP/connector 부족을 제외로 처리 | 직접 구현 대신 connector/federation/adaptor 전략으로 대응하고, OCR/IDP는 metadata-only external adapter intake로 확장성 공백을 줄임 |

90점+의 핵심 문장은 다음이다.

> 이 솔루션은 전사 범용 RPA를 즉시 대체하는 제품이 아니라, 보안과 감사가 중요한 웹 업무 자동화를 중앙 통제하고 기존 RPA/IDP/업무시스템과 연계하는 enterprise governance automation layer다.

이 문장을 벗어나 "UiPath/Automation Anywhere/Power Automate/Blue Prism을 전면 대체한다"고 말하면 90점 설계가 아니라 과장 설계가 된다.

## 2. 시장 기준 재정의

기업 도입 담당자는 경쟁 솔루션을 기능 목록만으로 보지 않는다. 보통 다음 묶음을 함께 본다.

| 기준 | 시장 기대 | 우리 설계의 90점 대응 |
|---|---|---|
| 오케스트레이션 | 로봇/러너, 작업, 큐, 자산, 스케줄, 실패 재처리 | Bot Pool/Worker Pool, queue/DLQ, state machine, heartbeat, lease를 P0로 증명 |
| 보안/거버넌스 | RBAC, credential vault, 감사, 테넌시, 정책 | SecretRef/SecretStore, RLS, RBAC, audit chain, redaction은 강점으로 유지 |
| 문서/IDP | OCR, classification, extraction, validation, human review | P0 OCR 엔진 직접 구현 금지. metadata-only external IDP/OCR normalized result intake와 human validation 연계로 대응 |
| 프로세스 발굴/ROI | process mining/task mining, discovery, savings evidence | P1 discovery import와 ROI evidence ledger를 설계에 추가 |
| 통합/생태계 | SaaS connector, API, event, marketplace, 기존 RPA 연계 | outbound event, webhook/provider abstraction, existing RPA handoff connector 설계 |
| 운영/지원 | HA/DR, monitoring, alerts, runbooks, SLA, training | production promotion gate, SLO, severity, RACI, support pack 추가 |
| CoE 운영 | maker-checker, template, certification, change control | scenario certification과 change approval workflow를 P1 설계로 승격 |

공식 벤더 문서 기준으로 보면 UiPath, Automation Anywhere, Microsoft Power Automate, SS&C Blue Prism은 이미 오케스트레이션/러너 운영/문서 처리/프로세스 발굴/통합 생태계를 제품군으로 제공한다. 따라서 우리 설계가 90점 이상을 받으려면 "기능 폭을 허위로 맞추는 방식"이 아니라 "보안형 웹 자동화와 공존 전략을 선명하게 하는 방식"이어야 한다.

Reference sources checked:
- [UiPath Orchestrator documentation](https://docs.uipath.com/orchestrator/)
- [UiPath Document Understanding documentation](https://docs.uipath.com/document-understanding/)
- [Automation Anywhere documentation](https://docs.automationanywhere.com/)
- [Microsoft Learn: Power Automate](https://learn.microsoft.com/power-automate/)
- [SS&C Blue Prism documentation](https://docs.blueprism.com/)

## 3. 90점+ 점수 모델

점수는 현재 구현이 아니라 "도입 담당자가 설계 리뷰에서 승인 가능한가"를 본다. 설계 문서가 해당 항목을 명시하고, 거짓 과장 없이 수용/제외/연계 전략을 닫아야 점수를 준다.

| 영역 | 배점 | 검토 후 현재 준비도 | v0.4 설계 목표 | 90점 조건 |
|---|---:|---:|---:|---|
| 제품 포지셔닝/범위 정직성 | 10 | 9 | 10 | web-only 한계를 숨기지 않고 기존 RPA 공존 포지션을 명확히 함 |
| 보안/컴플라이언스/거버넌스 | 12 | 11 | 12 | SecretRef, RLS, RBAC, audit, redaction, egress, AI policy가 계약으로 닫힘 |
| 런타임 제어/상태/테넌시 | 10 | 6 | 9 | heartbeat startup 순서, sweeper 휴면 방지, tenant discovery RLS 경계가 닫힘 |
| 배포/migration/HA/DR | 12 | 7 | 11 | non-bypass app-role, baseline deep verification, restore drill, rollback 원칙이 닫힘 |
| 관찰성/알림/Incident | 10 | 8 | 10 | OTLP/Prometheus, dashboard, external notification, severity runbook 포함 |
| 통합/federation/생태계 | 10 | 6 | 8 | 기존 RPA/IDP/SaaS와 handoff/event/adapter 계약을 설계 |
| Authoring/CoE/change governance | 8 | 5 | 8 | scenario 인증, maker-checker, template, change approval 포함 |
| 문서/OCR/AI governance | 8 | 6 | 7 | 직접 완성 주장 없이 IDP adapter, eval, cost, prompt-injection governance 포함 |
| 지원/SLA/교육/운영 RACI | 10 | 7 | 9 | L1/L2/L3, severity, training, support hours, owner matrix 포함 |
| ROI/TCO/증거 gate | 10 | 3 | 8 | 적자 자동화 payback 합성 금지, 실제/추정 evidence 분리 |
| 합계 | 100 | 73 | 92 | 설계 승인 가능. 구현 완료 점수와 분리 |

중요한 해석:
- v0.4 목표 92점은 "설계 문서 기준"의 목표 점수다.
- 현재 worktree의 초안 구현 채택 준비도는 첨부 검토 리포트의 63점 수준으로 별도 관리한다.
- 구현 증거가 없는 상태에서 "제품 준비도 92점"이라고 말하면 안 된다.
- Docker, migration, heartbeat, credential lease, browser egress guard, audit verifier evidence, external alert provider receipt capture, generic SecretRef-backed webhook sender, OTLP/Prometheus exporter support, and computed controlled-prod readiness gates now have repo-local implementation/test evidence. Slack/Teams/email/PagerDuty/ServiceNow-specific auth, recipient-group resolution, provider-specific delivery receipts, PITR/restore, SLO/on-call coverage, approved collector/dashboard/alert wiring, and production observability evidence still require owner-controlled environment evidence before the actual deployment-readiness score can claim production open.

## 4. 90점 Lock Gate

아래 gate 중 하나라도 실패하면 설계 점수 상한을 적용한다.

| Gate | 실패 시 상한 | 이유 |
|---|---:|---|
| G0. 범위 정직성 | 75 | Desktop/SAP/Citrix/OCR/IDP를 지원한다고 과장하면 신뢰 손상 |
| G1. Security non-regression | 80 | Secret/RBAC/audit/redaction 약화는 기업 도입 불가 |
| G2. 운영 승격 기준 부재 | 84 | HA/DR/SLO/알림/복구가 없으면 파일럿 이후 막힘 |
| G3. 지원 체계 부재 | 86 | 도입 담당자는 장애 대응과 책임 경계를 요구 |
| G4. ROI/TCO 근거 부재 | 88 | 구매 승인과 예산 심사를 통과하기 어려움 |
| G5. 기존 RPA 공존 전략 부재 | 89 | 시장 선도 제품 대비 기능 폭 부족이 그대로 노출 |
| G6. RLS/BYPASSRLS 운영 경계 부재 | 82 | high-security 멀티테넌시 판매 포인트가 무너짐 |
| G7. baseline deep verification 부재 | 84 | 깨진 기존 DB를 정상 schema로 각인할 수 있음 |
| G8. maintenance/integrity/orphan sweeper 휴면 가능 | 85 | 변조증거·retention·orphan cleanup이 조용히 멈춤 |
| G9. worker heartbeat fake-live 가능 | 87 | 실패한 worker가 live capacity로 보일 수 있음 |

90점 이상을 주장하려면 G0-G9가 모두 통과되어야 한다.

## 5. Target Product Definition

### 5.1 채택해야 할 제품 문장

> A governed AI-native web automation platform for secure enterprise workflows, designed to operate alongside existing RPA, IDP, and system-integration tools.

한국어 제품 문장:

> 보안, 감사, RBAC, HITL, AI 정책 통제가 필요한 웹 업무 자동화를 기존 RPA/IDP/업무시스템과 함께 운영하는 엔터프라이즈 자동화 거버넌스 플랫폼.

### 5.2 금지해야 할 제품 문장

| 금지 문장 | 이유 | 대체 문장 |
|---|---|---|
| 전사 범용 RPA 완전 대체 | Desktop/SAP/Citrix/Office runner가 없음 | 보안형 웹 자동화와 기존 RPA 공존 |
| OCR/IDP 완성 제품 | 현재 deterministic extractor 중심 | 외부 IDP adapter와 human validation 연계 |
| CAPTCHA/MFA 자동 해결 | 법무/보안 승인 없이는 위험 | human-first suspend와 승인 흐름 |
| 모든 SaaS connector 내장 | 생태계 폭 부족 | API/webhook/outbox 기반 연계와 우선 connector catalog |
| 외부 알림 delivered 보장 | provider receipt/callback 없이는 불가 | sent/accepted/delivered 상태를 증거 수준별로 분리 |

## 6. Enterprise Adoption Pack

90점 이상 설계를 위해 개발 전에 다음 산출물을 설계 범위에 포함한다.

| 산출물 | 목적 | 필수 내용 |
|---|---|---|
| Buyer one-pager | 임원/구매 담당자용 가치 설명 | 대상 업무, 제외 업무, 보안 강점, 기존 RPA 공존, 예상 ROI |
| Pilot charter | 파일럿 범위 고정 | 업무 2-3개, 성공 기준, 실패 기준, 데이터 범위, 담당자 |
| Production promotion checklist | 파일럿에서 운영 전환 기준 | HA/DR, SLO, restore drill, alert, on-call, security sign-off |
| Security evidence pack | 보안 심사 대응 | RBAC, SecretRef, RLS, audit, redaction, egress, retention |
| Runbook and incident pack | 장애 대응 | severity, escalation, rollback, restore, DLQ 처리, audit mismatch |
| ROI/TCO worksheet | 예산 승인 | 시간 절감, 오류 감소, 운영비, LLM/API 비용, 기존 라이선스 영향 |
| Training pack | 운영 내재화 | admin, developer, reviewer, approver 역할별 교육 |
| Architecture decision record set | 추후 논쟁 방지 | web-only, external IDP, existing RPA federation, no CAPTCHA solver |

이 산출물이 없으면 기술 설계가 좋아도 도입 담당자 관점 점수는 90점에 도달하기 어렵다.

## 7. 운영 승격 설계

### 7.1 환경 profile

| Profile | 목적 | 허용 기준 |
|---|---|---|
| `local-review` | 개발/리뷰 | Docker/Compose, local artifact store, console telemetry 허용 |
| `pilot` | 제한된 업무 파일럿 | Compose 또는 단일 k8s namespace, external DB backup, webhook alert, restore runbook |
| `controlled-prod` | 제한 운영 | k8s/Helm 또는 GitOps, managed PostgreSQL, object storage, OTLP/Prometheus, on-call |
| `enterprise-scale` | 전사 확장 | multi-region/DR decision, SSO/SCIM, WORM audit option, connector catalog, CoE 운영 |

P0 개발 source of truth는 여전히 Docker/Compose다. 다만 90점 설계에서는 "Compose만 있다"가 아니라 "운영 승격 시 무엇이 추가되어야 하는가"까지 닫는다.

### 7.2 기본 RPO/RTO 제안

| 단계 | RPO | RTO | 증거 |
|---|---:|---:|---|
| pilot | 24시간 이하 | 8시간 이하 | backup 존재, restore runbook, smoke 결과 |
| controlled-prod | 15분 이하 | 2시간 이하 | PITR, 정기 restore drill, incident rehearsal |
| enterprise-scale | 조직 SLA에 따름 | 조직 SLA에 따름 | DR architecture decision과 운영팀 sign-off |

RPO/RTO는 계약 기본값이 아니라 도입 담당자와 운영팀의 승인값이다. 값이 미정이면 `BLOCKED(reason=rpo_rto_owner_decision)`로 남기고 성공으로 합성하지 않는다.

### 7.3 배포/복구 원칙

| 항목 | 90점 설계 결정 |
|---|---|
| migration | forward-only, checksum ledger, existing DB baseline, out-of-order fail closed |
| rollback | down migration 성공 흉내 금지. release rollback은 app image rollback + DB backup/PITR 기준 |
| config | Secret은 SecretRef/SecretStore. `.env`에는 placeholder만 허용 |
| DB roles | API/worker app-role은 non-`SUPERUSER`/non-`BYPASSRLS`. migration/maintenance BYPASSRLS는 전용 role + audit 필요 |
| baseline | 기존 DB baseline은 table 존재만으로 통과 불가. columns, constraints, FK, trigger, RLS policy body, strict tenant binding을 검증 |
| artifact storage | local은 local-review/pilot 후보. controlled-prod는 object storage profile 필요 |
| rollout | controlled-prod부터 rolling/blue-green 중 하나를 운영팀 결정으로 고정 |
| maintenance | tenant discovery는 tenant별 non-bypass 또는 audited BYPASSRLS. integrity/orphan daily sweeper는 tenant 목록 공백 때문에 휴면하면 안 됨 |

## 8. 관찰성, 알림, Incident

### 8.1 Telemetry contract

| Signal | 필수 필드 | Backend |
|---|---|---|
| metric | tenant_id, scenario_id, run_id, worker_id, state, error_kind | Prometheus 또는 OTLP collector |
| trace | run_id, job_id, lease_id, secret_ref, policy_decision_id | OTLP |
| log | redacted message, correlation_id, severity | structured log sink |
| audit | actor, action, before/after hash, chain status | append-only audit store |

Secret 값, raw credential, unredacted artifact, LLM raw prompt 중 민감 필드는 telemetry로 나가면 안 된다.

### 8.2 Alert provider abstraction

P0-adoption의 first sender는 webhook이어도 된다. 그러나 90점 설계에서는 provider abstraction을 먼저 정의한다.

| Provider | 상태 | 증거 수준 |
|---|---|---|
| Console | Product Open v1 기본 | displayed |
| Generic HTTPS webhook | implemented first sender | `sent` from HTTP response; `delivered` only from receipt/callback |
| Slack/Teams | candidate | owner/provider evidence required for app/auth, channel ownership, recipient mapping, and receipt semantics |
| Email | candidate | owner/provider evidence required for SMTP/OAuth/auth, recipient-group expansion, bounce/delivery semantics |
| PagerDuty/ServiceNow | controlled-prod candidate | owner/provider evidence required for incident ownership, routing, accepted/resolved receipt semantics |

상태 명명 원칙:
- `sent`: 우리 시스템이 전송을 시도했고 HTTP/API 응답을 받음
- `accepted`: provider가 접수 id를 반환함
- `delivered`: provider delivery receipt/callback이 있음
- receipt가 없으면 delivered로 표시하지 않는다.

Current implementation records metadata-only provider receipts in `ops_notification_deliveries` and performs SecretRef-backed runtime webhook sending as the first active sender slice. The connector catalog must expose this as the implemented generic `ops-webhook-sender`, not as a blocked future adapter. HTTP 2xx webhook responses are `sent`; `delivered` still requires provider receipt/callback evidence. Slack/Teams/email/PagerDuty/ServiceNow-specific catalog entries remain candidates until owner/provider evidence approves auth, route ownership, recipient resolution, and provider-specific receipt semantics.

### 8.3 Severity model

| Severity | 예시 | 응답 목표 | Escalation |
|---|---|---:|---|
| SEV1 | Secret 노출, audit chain mismatch, tenant isolation 의심 | 30분 | L3 + 보안 담당 |
| SEV2 | 대량 run 실패, worker pool 전체 중단, migration 실패 | 2시간 | L2 + runtime owner |
| SEV3 | 단일 scenario 실패, connector 오류, 지연 증가 | 1영업일 | L2 |
| SEV4 | UX/문서/설정 문의 | 3영업일 | L1 |

지원 시간은 조직 정책 입력값이다. 미정이면 SLA를 확정했다고 표시하지 않는다.

## 9. Integration and Federation

경쟁 제품 대비 생태계 격차를 줄이는 가장 현실적인 방법은 직접 전체 connector를 만드는 것이 아니라 federation contract를 설계하는 것이다.

| 통합 유형 | 설계 | 90점 효과 |
|---|---|---|
| Existing RPA handoff | UiPath/AA/Power Automate/Blue Prism 작업을 외부 job으로 호출하거나 callback 수신 | desktop/SAP/Citrix 부족을 솔직하게 보완 |
| IDP adapter | 외부 OCR/IDP 공급자가 산출한 normalized document extraction field values를 metadata-only로 수신 | OCR 엔진을 직접 제공하지 않고 문서 자동화 확장성 gap을 외부 전문 엔진 연계로 보완 |
| SaaS/API connector | HTTP API action, OAuth/SecretRef, allowlist, retry, rate limit | connector 폭을 단계적으로 확대 |
| Event outbox | run_started, run_completed, exception_created, approval_required 발행 | SIEM/ITSM/BI 연계 |
| Human workflow | HITL task, approval, exception queue, evidence capture | 규제 업무와 MFA/CAPTCHA 회피 |

Current slice: `integration_handoffs`, `integration_handoff_dispatch_attempts`, and `integration_handoff_receipts` are implemented as metadata-only ledgers, with `GET/POST /v1/integration-handoffs`, explicit `POST /v1/integration-handoffs/{handoff_id}/dispatch`, JWT/RBAC control-plane receipt recording, provider-signed public callback ingress at `/v1/webhooks/integration-handoffs/{tenant_id}/{handoff_id}`, `integration.handoff` RBAC, OpenAPI/operation registry/codegen fixtures/web client/UI coverage, and signed callback/dispatch integration tests. Dispatch resolves only `endpoint_secret_ref` through SecretStore with `purpose=connector`, enforces `allowed_hosts`, timeout, retry/backoff, and `dead_letter`. Worker-level evidence now proves `PgRuntimeWorker` fails closed when the dispatch port is missing or a `test_fake` port is injected without explicit opt-in. This improves federation design evidence while keeping create side-effect free; a provider 2xx may mark `accepted`, but `completed` still requires provider receipt/callback evidence.

Connector catalog slice: `existing-rpa-handoff` is a metadata-only federation surface, and UiPath, Automation Anywhere, Power Automate, and Blue Prism appear only as provider profile/templates. These entries are not direct completed vendor connectors. Real vendor API shape, OAuth/client registration, queue or flow mapping, endpoint ownership, and callback signing policy remain owner/provider decisions; the repo surface stores only provider aliases, SecretRef names, allowed-host metadata, dispatch attempts, and receipts.

Current IDP/OCR slice: `POST /v1/document-jobs/{job_id}/external-extractions` is open as a metadata-only intake for external provider normalized results. It accepts provider receipt, opaque evidence ref, normalized schema ref, confidence, non-secret metadata, and field values under tenant isolation, RBAC, and idempotency. It rejects raw document bytes, raw OCR text or long OCR text blocks, raw endpoint URLs, signed URLs, tokens/secrets, provider response bodies, and resolved SecretRef material. Actual OCR provider/engine selection and image/PDF OCR remain future provider/productization work.

P1 connector catalog는 "지원", "candidate", "blocked" 상태를 가져야 한다. 미지원 connector를 성공처럼 노출하지 않는다.

## 10. Authoring, CoE, Change Governance

도입 담당자는 개발자 기능보다 운영 통제 가능성을 먼저 본다. 따라서 authoring 설계는 다음 체계를 포함해야 한다.

| 영역 | 설계 |
|---|---|
| Scenario intake | 업무명, owner, 시스템, 데이터 민감도, 빈도, 예외율, 예상 절감시간 입력 |
| Risk classification | low/medium/high, 개인정보/금융/계약/인사 데이터 tag |
| Maker-checker | 작성자와 승인자를 분리. high risk scenario는 보안/업무 owner 승인 필요 |
| Certification | dev -> review -> pilot -> certified -> deprecated lifecycle |
| Template library | 검증된 browser action, extraction, approval, notification template |
| Change approval | selector 변경, credential scope 변경, AI policy 변경은 변경 이력과 승인 필요 |
| Kill switch | tenant/scenario/worker level suspend |
| Exception review | failed run, HITL, DLQ, audit mismatch를 reviewer queue에서 처리 |

P0 certification gate는 `scenario_versions.certification_status`(`uncertified|certified|revoked`), `scenario.certify` RBAC, certify/revoke API, governance audit evidence, console badge/action, 그리고 prod release approve/deploy/rollback fail-closed gate로 구현한다. `review|pilot|deprecated` governance stage update contract is now explicit, while owner/RACI artifact checklist and rich evidence attachment remain P1 extensions. 인증 상태가 누락되면 운영 승인처럼 표시하지 않는다.

Scenario version governance stage addendum: `POST /v1/scenarios/{scenario_id}/versions/{version}/governance-stage` now contractually records metadata-only `review|pilot|deprecated` lifecycle state under `scenario.certify` with `Idempotency-Key`. The response extends the existing `certification` object with `governance_stage`, `governance_reason`, `governance_evidence_ref`, `governance_metadata`, `governance_updated_by`, and `governance_updated_at`. `review`, `pilot`, and `deprecated` are not prod certification; prod release gates may rely only on `certification.status='certified'`/`valid_for_prod=true`. Raw URLs, endpoint URLs, tokens/passwords/secrets, resolved SecretRef material, long approval packets, and raw rosters remain forbidden.

## 11. AI, OCR, IDP Governance

### 11.1 AI governance

| 항목 | 90점 설계 요구 |
|---|---|
| Model registry | provider, model, version, tenant allowlist, data retention policy |
| Prompt registry | approved prompt template, owner, eval set, rollback version |
| Eval set | 정상/악성/edge 업무 케이스, prompt injection, data leakage, hallucination |
| Cost control | tenant/scenario budget, per-run cap, anomaly alert |
| HITL fallback | confidence threshold 미달, policy block, MFA/CAPTCHA, ambiguous extraction 시 suspend |
| Evidence | model decision, policy decision, human override를 audit와 연결 |

Implementation update: `ai_governance_evidence` now provides the metadata-only registry for these controls. `GET /v1/ai-governance/evidence` is readable through `ai_governance.read`; `POST /v1/ai-governance/evidence` is admin-only through `ai_governance.manage` and `Idempotency-Key`. Valid evidence requires `evidence_ref`, `policy_decision_ref`, and an existing audit correlation id, so AI approval cannot be synthesized without audit linkage. The registry rejects raw prompts, raw model outputs, payload/body fields, raw endpoint URLs, tokens, passwords, provider credentials, and resolved SecretRef material.

Execution gating decision: the repo now records and validates AI governance evidence, but it does not hard-code which missing or expired evidence must block a run, model selection, or prompt template rollout. Required decision: tenant/customer AI policy must define the enforcement mode (`observe`, `warn`, or `block`), subject mapping (`model`, `prompt`, `scenario`, or `tenant`), grace period, and emergency override owner before runtime blocking is enabled. Until that decision exists, the product surface may show evidence gaps but must not synthesize either "AI approved" or "AI blocked" from partial evidence.

### 11.2 OCR/IDP 전략

P0는 OCR/IDP 완성 제품을 주장하지 않는다. 90점 설계는 다음 중 하나를 명시해야 한다. 현재 보강된 선택지는 metadata-only external adapter intake이며, 실제 OCR provider/engine 선정이나 이미지/PDF OCR 실행은 아직 범위 밖이다.

| 선택지 | 조건 |
|---|---|
| External IDP adapter | 조직이 이미 쓰는 IDP 또는 cloud document AI가 산출한 normalized field values를 metadata-only로 수신 |
| Manual evidence intake | 문서 자동화 범위를 제외하고 reviewer upload/evidence만 처리 |
| P1.5 IDP productization | classification/extraction/validation schema, confidence, HITL, benchmark dataset을 별도 개발 |

어떤 선택지도 없으면 문서 업무 도입은 scope-out 처리한다. external adapter intake를 선택한 경우에도 원문/OCR 전문 저장, raw endpoint URL, token/secret, provider response body 저장은 금지하며, SecretRef/SecretStore, RBAC, idempotency, tenant isolation을 유지한다.

## 12. ROI/TCO Model

설계 문서에 ROI/TCO worksheet를 포함해야 구매/도입 심사를 통과하기 쉽다.

| 입력 | 설명 |
|---|---|
| monthly_transactions | 월 업무 건수 |
| baseline_minutes_per_transaction | 현재 수작업 평균 시간 |
| automated_minutes_per_transaction | 자동화 후 평균 사람 개입 시간 |
| exception_rate | HITL/실패/재처리 비율 |
| hourly_loaded_cost | 인건비 포함 시간당 비용 |
| platform_monthly_cost | 인프라, LLM/API, 운영 인력, 라이선스 |
| implementation_cost | 최초 개발/검증/교육 비용 |
| avoided_license_cost | 기존 RPA 또는 외부 도구 비용 절감분 |

기본 공식:

```text
monthly_hours_saved =
  monthly_transactions
  * (baseline_minutes_per_transaction - automated_minutes_per_transaction)
  * (1 - exception_rate)
  / 60

monthly_value =
  monthly_hours_saved * hourly_loaded_cost + avoided_license_cost - platform_monthly_cost

payback_months =
  if monthly_value > 0 then implementation_cost / monthly_value
  else null

viability =
  if monthly_value > 0 then "viable"
  else "not_viable"
```

`monthly_value <= 0`인 자동화는 유한 payback으로 합성하지 않는다. ROI는 추정값과 실제값을 분리한다. 파일럿 종료 시 실제 처리 건수, 실패율, 사람 개입 시간, 재처리 시간을 evidence ledger에 기록한다.

구현 반영: `RoiEstimate` 계약은 기존 `estimated_monthly_value`를 gross 월 절감액으로 유지하고, optional `platform_monthly_cost`/`avoided_license_cost`, 계산 결과 `monthly_value`, `viability`를 추가한다. CoE 승인 판단은 `payback_months`와 `viability`를 함께 사용하며 `not_viable`은 승인 추천으로 전이하지 않는다. 파일럿 실제값은 `GET/POST /v1/automation-ideas/{idea_id}/roi-actuals`와 `roi_actual_evidence` 원장에 분리 저장하며, 실제 처리 건수, 실패율, 사람 개입 시간, 재처리 시간, metadata-only evidence reference를 기록한다. 월간 성과 리포트와 Dashboard는 월 범위 안에 완전히 포함된 이 원장을 `roi_actuals` 집계로 연결해 추정 transaction/failure assumption 대비 comparable actual을 비교한다. actual-only 파일럿은 전체 actual로 보이지만 attainment/delta에는 합성하지 않으며, `evidence_ref`/summary/metadata 원문이나 URL/Secret 계열 값은 노출하지 않는다.

Pilot readiness evidence 구현 반영: `GET/POST /v1/automation-ideas/{idea_id}/adoption-evidence`는 pilot charter sign-off, RACI sign-off, training completion, support model sign-off를 ROI와 분리된 adoption evidence ledger로 저장한다. `status=deferred`는 누락을 성공으로 합성하지 않기 위한 명시 상태이며, `status=failed`는 파일럿 운영 전환 blocker로 표면화할 수 있다. `evidence_ref`는 opaque ticket/artifact reference이고, summary/metadata에는 raw endpoint URL, signed URL, token, password, webhook secret, resolved SecretRef, 긴 원문 문서, training roster 원문을 넣을 수 없다.

## 13. Support and RACI

| Role | 책임 |
|---|---|
| Business owner | 업무 범위, 성공 기준, 예외 처리 승인 |
| Automation owner | scenario 설계, change request, run 품질 |
| Platform owner | runtime, worker, DB, migration, deployment |
| Security owner | Secret, RBAC, audit, egress, data retention 승인 |
| L1 support | 사용자 문의, run 상태 확인, known issue 안내 |
| L2 support | scenario 실패 분석, connector/config 문제 처리 |
| L3 engineering | runtime bug, data integrity, security incident, migration issue |
| CoE board | 우선순위, template, certification, 운영 표준 |

지원 체계가 미정이면 90점 설계로 주장하지 않는다. 최소 pilot 단계에서도 business owner, platform owner, security owner는 이름 또는 조직 단위로 지정되어야 한다.

## 14. Stage Gates

### Gate 0. Scope Fit

통과 조건:
- 대상 업무가 web automation 중심이다.
- Desktop/SAP/Citrix/Office automation이 핵심이면 existing RPA handoff 또는 scope-out이 정의되어 있다.
- OCR/IDP가 핵심이면 metadata-only external IDP adapter intake 또는 scope-out이 정의되어 있다.
- CAPTCHA/MFA 자동 해결을 성공 조건으로 두지 않는다.

### Gate 1. Pilot Readiness

통과 조건:
- Pilot charter 승인
- Docker/Compose 또는 pilot profile 기동 경로
- migration fresh install/baseline/re-run smoke 증거 요구사항
- baseline deep verification: RLS policy body, strict tenant binding, constraints, FK, audit append trigger
- credential lease, heartbeat, sweeper, DLQ 설계
- non-bypass app-role smoke와 superuser smoke 구분
- webhook 또는 console alert 기준
- security evidence pack 초안
- ROI/TCO baseline 입력
- automation adoption evidence ledger에 `pilot_charter_signoff`, `raci_signoff`, `training_completion`, `support_model_signoff`를 metadata-only로 기록하거나 `deferred/failed` blocker로 남김

### Gate 2. Controlled Production

통과 조건:
- 운영 profile 선택: k8s/Helm/GitOps 중 하나
- managed PostgreSQL 또는 운영 DB 정책 승인
- backup/PITR/restore drill evidence
- readiness evidence alerting: `readiness_evidence` ops alerts surface failed, expired, or 14-day due-soon `production_readiness_evidence` without leaking artifacts or secrets
- OTLP/Prometheus exporter evidence plus approved dashboard and alert evidence
- SEV model과 on-call/RACI
- audit verifier 결과 보존: `audit_verifier_runs`, `GET /v1/audit-log/verification-runs`, admin-only `POST /verify`, Audit Explorer panel, tamper fixture coverage
- support/training completion (`support_training_completion`) metadata-only evidence

### Gate 3. Enterprise Scale

통과 조건:
- CoE 운영
- connector catalog와 deprecation policy
- scenario certification lifecycle 운영
- SSO/SCIM 또는 조직 IAM 연계 결정
- WORM audit mirror 또는 보존 정책 결정
- quarterly ROI report

## 15. 계약 PR 반영 순서

구현 전에 아래 계약 변경을 먼저 승인해야 한다.

| 순서 | 문서 | 변경 |
|---:|---|---|
| 1 | `docs/rpa-adoption-full-design-2026-06-29.md` | v0.4 90점 기준 문서 링크와 외부 검토 P1 반영 |
| 2 | `ops-defaults.md` | environment profile, RPO/RTO, worker stale threshold, daily sweeper non-dormancy, support owner 기본값 |
| 3 | `db/README.md` | baseline deep verification과 non-bypass role smoke를 명시 |
| 4 | `security-contracts.md` | BYPASSRLS maintenance discovery/audit, AI governance, external IDP evidence boundary |
| 5 | `auth-rbac.md` | CoE 역할, maker-checker, approval scope, scenario certification 권한 |
| 6 | `api-surface.md` | alert provider 상태, event outbox, existing RPA handoff, IDP adapter API, worker stale threshold 참조 |
| 7 | `schema/` | ROI evidence, provider receipt, certification lifecycle, integration catalog schema |
| 8 | `db/` | ledger/receipt/certification/ROI 테이블 migration 설계 |
| 9 | `codegen/` | contract 변경 후 generated artifacts 갱신 |

이 순서를 지키면 "개발 먼저"가 아니라 "도입 가능한 설계 먼저"로 진행된다.

## 16. 90점 승인 체크리스트

아래 항목이 모두 `yes`이면 설계 기준 90점 이상으로 판단한다.

| Check | 설계 상태 |
|---|---|
| 제품 포지션이 범용 RPA 대체가 아니라 보안형 웹 자동화 + federation으로 명시됨 | yes - 본 문서 §5 |
| Desktop/SAP/Citrix/Office/OCR/CAPTCHA 제외 또는 연계 전략이 명확함 | yes - 본 문서 §5·§9, `security-contracts.md` §14 |
| pilot와 controlled-prod의 승격 기준이 분리됨 | yes - 본 문서 §7·§14, `ops-defaults.md` §10 |
| RPO/RTO가 기본 제안 또는 `BLOCKED(reason=...)`로 명시됨 | yes - 본 문서 §7, `ops-defaults.md` §10 |
| controlled-prod readiness blocker/deferred 증거가 API/콘솔/패킷/release gate에 노출됨 | yes - `GET /v1/ops/production-readiness`, Orchestration readiness panel, `release-packet:validate` readiness/external-alert/webhook evidence fields, `prod-readiness-packet:validate` production-open owner evidence shape, prod release approve/deploy fail-closed gate |
| external alert 상태가 sent/accepted/delivered로 분리됨 | yes - 본 문서 §8, `api-surface.md` §11.3 |
| OTLP/Prometheus/dashboard/SLO가 설계 범위에 포함됨 | yes - 본 문서 §8, `ops-defaults.md` §10 |
| CoE, maker-checker, certification, change approval이 설계됨 | yes - 본 문서 §10, `auth-rbac.md` §6. P0 certification gate는 API/DB/console/prod release gate로 구현됨 |
| AI governance evidence registry가 raw prompt/output 없이 audit linkage를 강제함 | yes - `GET/POST /v1/ai-governance/evidence`, `ai_governance.read/manage`, `ai_governance_evidence`, `security-contracts.md` §14.1 |
| support RACI와 SEV model이 포함됨 | yes - 본 문서 §8·§13, `ops-defaults.md` §10 |
| ROI/TCO worksheet와 evidence ledger가 포함됨 | yes - 본 문서 §12, `api-surface.md` §11.4 |
| 기존 RPA/IDP/SaaS integration 전략이 포함됨 | yes - 본 문서 §9, `api-surface.md` §11.1-11.2 |
| 구현 완료 점수와 설계 점수가 분리되어 설명됨 | yes - 본 문서 §3·§17 |
| maintenance 자동발견이 무가드 cross-tenant 쿼리로 설계되지 않음 | yes - 본 문서 §7.3, `security-contracts.md` §11 |
| integrity/orphan sweeper가 기본 배포에서 조용히 휴면하지 않음 | yes - 본 문서 §7.3, `ops-defaults.md` §6 |
| baseline이 table/RLS flag만으로 기존 DB를 신뢰하지 않음 | yes - 본 문서 §7.3, `db/README.md` |
| worker stale 2분 기준이 SSoT에 등록됨 | yes - `ops-defaults.md` §2 |
| ROI payback이 적자 자동화에 유한값을 합성하지 않음 | yes - 본 문서 §12 |

위 항목은 설계 기준 `yes`다. 구현/검증 증거는 별도 readiness 점수로 관리한다.

## 17. 최종 판단

90점 이상을 만들기 위해 가장 중요한 개선은 기능을 더 크게 말하는 것이 아니다. 오히려 반대다.

- web-only 범위를 더 정직하게 고정한다.
- Desktop/SAP/Citrix/OCR/IDP는 직접 완성 주장 대신 기존 솔루션과의 연계로 보완하고, OCR/IDP는 metadata-only normalized result intake 범위까지만 주장한다.
- 운영 승격, 지원, ROI, CoE, incident, evidence pack을 제품 설계의 일부로 승격한다.
- 구현 전 계약 PR로 이 결정을 먼저 고정한다.

이 보강안을 승인하면 설계 목표는 92/100으로 볼 수 있다. 단, 첨부 검토 리포트의 P1 군집(MD-1, MD-2, MIG-1, DEP-01, HB-1)을 구현과 검증에서 닫기 전까지 실제 제품 준비도는 73/100 전후로 유지해야 한다.

## Addendum: External Alert Receipt Evidence

The 90+ design now treats external alert evidence as two separate layers. `ops_notification_deliveries` and `POST /v1/ops-alerts/{alert_id}/deliveries` provide metadata-only provider receipt capture with `ops_alert.deliver`, SecretRef identifiers, optional `recipient_group_ref`, idempotency, and no raw endpoint/token material. Webhook runtime sending is now implemented as the first active sender slice: `POST /v1/ops-alerts/{alert_id}/deliveries/send-webhook` creates `ops_notification_attempts`, enqueues `ops_notification_send`, resolves `notification` SecretRefs with the `notification-sender` identity, validates `allowed_hosts` including redirects, preserves metadata-only `recipient_group_ref`, records HTTP 2xx as `sent`, and sends failures through retry/dead-letter attempt state. The Admin Web Orchestration alert center now consumes that sender through an admin-only SecretRef/route-policy/allowed-host/recipient-group-ref form and keeps provider evidence in the delivery receipt drilldown. The connector catalog exposes the generic sender as implemented/supported metadata-only and SecretRef-only; Slack/Teams/email/PagerDuty/ServiceNow-specific items remain candidates requiring owner/provider evidence for auth, recipient-group resolution, and provider-specific delivery receipt semantics.
