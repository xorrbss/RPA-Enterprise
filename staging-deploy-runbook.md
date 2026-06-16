# Staging Deploy Runbook — closing deploy blocker row 43 (the last one)

오너 실행용 런북. `release-open-checklist.md` 의 **마지막 미해결 deploy-time 행 row 43**
(concrete staging platform repo + GitHub Environment `staging` + deploy target +
release-approval/rollback + SecretRef/SecretStore provisioning path) 을 닫기 위한 단계별 안내.

이 작업은 **이 contract 레포 밖**(별도 플랫폼/배포 레포)에서 일어난다 — 이 레포의
"Deploy-Time Provisioning Blockers" 게이트가 deploy/Environment 바인딩을 금지하기 때문이다
(release-decisions D8-A14 #13). 따라서 row 43 은 코드로 닫히지 않고, 오너가 실제 플랫폼을
프로비저닝하고 **redacted 릴리스 패킷**(아래 §6)을 제출할 때 닫힌다.

> ⚠ **평문 금지.** 패킷·로그·이 레포 어디에도 실 시크릿/토큰/role_id/secret_id/AKID 를 적지 않는다.
> SecretRef **경로**·redacted alias·repo/Environment **이름**·deploy target **식별자**는 노출 안전(값이 아님).

---

## 1. 이미 결정/종료된 것 (다시 정하지 말 것)

row 43 외 deploy-time 행은 모두 종료됨. 아래는 row 43 이 **참조만** 하면 되는 기결정 사실:

| 영역 | 결정/증거 | 출처 |
|---|---|---|
| 배포 거버넌스 | GitHub Environment `staging`; 승인·롤백 = 단일 프로젝트 오너(외부 팀 없음) | D8-A14 #13 |
| 배포 형태 | managed-container 타깃 + GitHub Environment `staging`(오너=approver) | D8-A14 |
| SecretStore | HashiCorp Vault, KV v2, mount `secret/`, base `secret/data/rpa/staging/<runtime>/<purpose>/<name>` | D8-A14, row 44 |
| SecretRef 네임스페이스 + identity map(최소권한) | `<runtime>`→`<purpose>` access matrix | D8-A12, rows 45/46 |
| 로테이션/break-glass | cadence + 오너 = #13 | D8-A13, row 47 |
| Vault AppRole resolution | authorized ALLOW / unauthorized DENY + `secret.resolve` audit 실증 | row 48 (`secretstore:smoke`) |
| object-store I/O(redaction/retention) | 오너-운영 실 S3-프로토콜 store + SecretRef-backed | rows 51/52 (`objectstore:smoke`), D8-A15 |
| producer retention | per-producer 정책 + staging PG 증거 | row 49, D8-A11/A14 |
| D5 라이브 capability | redacted 라이브 PASS | row 50 |
| runtime 실행 게이트(원격 CI) | 비-bypass PG 15 `test:int` 등 | row 53 |

→ row 43 이 새로 만들 것은 **플랫폼 repo + Environment + deploy target + 승인/롤백 절차**, 그리고
위 SecretStore 경로를 **실제 배포에 배선**하는 것뿐이다.

---

## 2. 플랫폼 repo + 배포 타깃

1. **별도 플랫폼/배포 repo** 를 만들거나 지정한다(배포 자동화·IaC·매니페스트 위치 — 이 contract 레포 아님).
2. **구체 deploy target 식별자**를 정한다: managed-container 런타임의 `namespace/service`(또는 동등물).
3. 배포 단위(어떤 컨테이너/이미지가 어떤 런타임 identity 로 도는지)를 명시한다 — 런타임 identity 는
   §1 의 SecretRef identity map(D8-A12)과 1:1 이어야 한다(예: `runtime-worker`, `browser-worker`,
   `artifact-lifecycle`, `llm-gateway`).

기록(패킷 §6): 플랫폼 repo 이름 + deploy target 식별자(값 아님 — 식별자).

---

## 3. GitHub Environment `staging` 설정

플랫폼 repo 의 **Settings → Environments → `staging`** 에서:

1. **Required reviewers** = 단일 프로젝트 오너(#13). (외부 승인자 팀 없음 — 오너 1인.)
2. **Deployment branch policy** = 배포 가능한 브랜치 제한(예: protected `main`/release 태그).
3. (선택) **Wait timer** — 필요 시.
4. **Environment secrets** 로 런타임별 **Vault AppRole 자격**만 주입(평문 시크릿 아님):
   - 각 런타임 identity 의 `VAULT_<RUNTIME>_ROLE_ID` / `VAULT_<RUNTIME>_SECRET_ID` (+ `VAULT_ADDR`, `VAULT_MOUNT`).
   - 런타임은 부팅 시 자기 AppRole 로만 로그인해 **자기 namespace 의 SecretRef 만** resolve 한다(최소권한 D8-A12).
   - ⚠ S3 secretAccessKey·DB 비밀번호 등 **개별 시크릿은 Environment 에 평문으로 넣지 않는다** — Vault SecretRef
     경유로만 resolve(rows 48/51/52 에서 실증한 경로).

기록(패킷 §6): Environment 보호/승인자 설정의 redacted 참조(스크린샷/설정 export 의 redacted 형태), 주입한
SecretRef **경로/식별자** 목록(값 없음).

---

## 4. SecretStore 프로비저닝 경로 배선

1. 실 Vault 에 §1 의 base path(`secret/data/rpa/staging/<runtime>/<purpose>/<name>`)로 staging 시크릿을 seed.
2. 런타임별 AppRole + **최소권한 정책**(자기 `<runtime>/*` 만 read; D8-A12 매트릭스) 생성 —
   row 48 `secretstore:smoke` 가 검증한 ALLOW/DENY 구조와 동일.
3. 배포 시 Environment secret 의 role_id/secret_id 로 런타임이 Vault 로그인 → SecretRef resolve.
4. `secret.resolve` 감사가 staging `audit_log`(hash-chain, 비-bypass 역할)에 남는지 확인(row 48 패턴).

기록(패킷 §6): Vault mount/path **alias**(평문 값 없음) + identity map(D8-A12) 참조 + `secret.resolve` 감사
샘플(seq/hash, material 없음).

---

## 5. 릴리스 승인 + 롤백 + staging 배포

1. **릴리스 승인**: GitHub Environment `staging` 의 required reviewer(오너)가 각 배포를 승인 — 이 승인
   기록이 release-approval 증거다(외부 승인자 팀 없음).
2. **롤백**: 마이그레이션은 forward-only + 트랜잭션 롤백(D7-4) — 롤백 = 직전 컨테이너 이미지로 redeploy +
   마이그레이션 러너/원장이 재적용 방지. 오너가 롤백 주체(외부 oncall 없음).
3. **staging 배포 1회 실행** 후, 배포된 런타임에서:
   - SecretRef resolution 동작(row 48 경로) + object-store I/O(rows 51/52 경로) + 비-bypass DB 게이트(row 53)
     가 staging 에서 실제로 통과하는지 확인.

기록(패킷 §6): 배포 실행 참조(redacted run/deployment URL) + 승인/롤백 절차 확인.

---

## 6. Redacted 릴리스 패킷 (row 43 종료 증거)

아래를 모두 채운 **redacted 패킷**을 `product-open-candidate-report.md` 의 row 43 마커 자리에 붙이면
row 43 이 닫힌다(closure-boundary "Deploy-time provisioning" may-close 컬럼과 1:1):

```
[STAGING RELEASE PACKET — redacted]
- staging platform repo            : <org/repo 이름>
- concrete deploy target           : <namespace/service 식별자>
- GitHub Environment `staging`      : protection=<on>, required reviewer=<owner>, branch policy=<...>
- release approval reference        : <approved deployment URL/ID, redacted>
- rollback confirmation             : forward-only(D7-4) + prior-image redeploy; owner=#13
- SecretStore alias/path            : Vault KV v2 mount `secret/`, base secret/data/rpa/staging/<runtime>/<purpose>/<name>  (값 없음)
- namespace / identity map          : D8-A12 (staging-decision-proposals §3) 참조
- SecretRef inventory               : D8-A12 (staging-decision-proposals §4) 참조 (식별자만)
- retention policy                  : D8-A11/A14 / ops-defaults §6.1 참조
- live D5 evidence                  : row 50 packet 참조 ([codex-staging-1]/[model-a])
- secret.resolve audit sample       : seq#/hash (material 없음)
[금지: 실 시크릿/토큰/role_id/secret_id/AKID/평문 자격 — 하나라도 있으면 패킷 무효]
```

---

## 7. 종료 절차 (패킷 확보 후)

`release-open-checklist.md` 게이트 패턴대로(전용 워크트리에서):

1. `release-open-checklist.md` row 43 `[ ]`→`[x]` + 위 패킷 요약.
2. `product-open-candidate-report.md` 의 row 43 blocked-decision 마커를 `Resolved` 로 전환 + 패킷 첨부.
3. 카운트 동기화(3곳: checklist + report ×2): **20→19 markers, 1→0 actionable, 1→0 active deploy-time**.
4. `scripts/blocked-decisions-audit.mjs` `expectedActiveBlockerSectionCounts["## Deploy-Time Provisioning Blockers"]` **1→0**.
5. 로컬 `node scripts/blocked-decisions-audit.mjs` exit 0 + `contract-lint` + secret-scan → PR → CI green → merge.

→ 완료 시 **deploy-time 블로커 0**. 모든 deploy 게이트 종료.
