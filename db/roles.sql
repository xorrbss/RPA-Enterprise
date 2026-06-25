-- ============================================================
-- DB 역할 분리(최소권한, DG1 — governance).
--   배포 시 1회 적용한다(마이그레이션과 별개; docs/staging-deploy-runbook.md 참조).
--   두 역할로 DDL 권한과 런타임 데이터 접근을 분리한다:
--     rpa_migrator — 스키마/객체 소유 + DDL/마이그레이션 전용. 런타임 연결에 쓰지 않는다.
--     rpa_app      — 런타임(제어평면 API + 워커) DML 전용. SUPERUSER·BYPASSRLS·DDL 없음 → RLS 적용,
--                    스키마 변경 불가. 제어평면 API 와 워커는 같은 런타임 데이터평면을 공유하므로 이 역할을
--                    함께 쓴다(연결 단위 분리가 필요하면 rpa_app 의 동일 권한 복제 역할을 배포에서 추가; 테이블별
--                    app/worker 권한 세분은 두 경로의 런타임 테이블 중첩이 커 실익이 작다 — runbook 참조).
--   ⚠ 비밀번호·LOGIN 은 배포 환경 비밀로 주입한다(여기선 속성/권한만 정의; runbook 의 ALTER ROLE 단계).
--   ⚠ 마이그레이션은 rpa_migrator 로 실행해야 ALTER DEFAULT PRIVILEGES 가 신규 객체에 자동 적용된다.
-- ============================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rpa_migrator') THEN
    -- 스키마/객체 소유 + DDL. superuser/bypassrls/createrole/createdb 아님(소유권으로만 DDL).
    CREATE ROLE rpa_migrator NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rpa_app') THEN
    -- 런타임. 최소권한: DML 만. DDL·SUPERUSER·BYPASSRLS·CREATEROLE·CREATEDB 없음.
    CREATE ROLE rpa_app NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END $$;

-- 런타임 역할: 스키마 USAGE(CREATE 미부여 = DDL 불가) + 기존 객체 DML/시퀀스/함수 권한.
GRANT USAGE ON SCHEMA public TO rpa_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO rpa_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO rpa_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO rpa_app;

-- 이후 rpa_migrator 가 만드는 객체에도 같은 권한 자동 부여(마이그레이션마다 재GRANT 불필요).
ALTER DEFAULT PRIVILEGES FOR ROLE rpa_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO rpa_app;
ALTER DEFAULT PRIVILEGES FOR ROLE rpa_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO rpa_app;
ALTER DEFAULT PRIVILEGES FOR ROLE rpa_migrator IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO rpa_app;
