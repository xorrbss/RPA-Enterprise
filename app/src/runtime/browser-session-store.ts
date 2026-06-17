/**
 * BrowserSessionStore — 재사용 인증 세션(쿠키 번들)의 영속 포트 + PostgreSQL 구현 (세션 재사용 방식 A).
 *
 * 저장소는 `browser_sessions`(db/migration_concurrency_idempotency.sql) — tenant-scoped, RLS(FORCE) 강제, PK=
 * (tenant_id, site_profile_id, browser_identity_id, identity_key). 쿠키 번들은 **봉투암호화**해 `ciphertext`(bytea)+
 * `enc_kid`로만 영속한다. 평문 쿠키는 인증 자료 = PlainSecret 급 — load→decrypt→setCookies / getAllCookies→encrypt→save
 * 의 **단명 지역변수**로만 존재하고 로그/직렬화/이벤트/artifact/LLM/audit 에 절대 흐르지 않는다.
 *
 * 보안 fail-closed: PgBrowserSessionStore 는 **실 암호화기(KMS)** 없이는 생성 거부(생성자 throw — 첫 save 아님).
 *   prod 는 KmsEnvelopeSessionEncryptor(미구현, TODO:[BLOCKED])만 주입 가능하므로, 그것이 없으면 prod 는 세션을 재사용하지
 *   않는다(안전한 성능저하, 누출 아님). dev-plaintext 암호화기는 명시적 allowDevPlaintext 옵트인에서만 허용(prod 차단).
 */
import type { Pool, PoolClient } from "pg";

import { withTenantTx } from "../db/pool";
import type { RawCookie } from "../executor/raw-cdp";

/** 재사용 세션의 식별 스코프(= browser_sessions PK). identityKey 는 계정 판별자(기본 ''=단일 정체성 사이트). */
export interface SessionKey {
  readonly tenantId: string;
  readonly siteProfileId: string;
  readonly browserIdentityId: string;
  readonly identityKey: string;
}

/** 영속 단위(이 증분은 쿠키만; localStorage 는 origin-scoped 라 후속). */
export interface CookieBundle {
  readonly cookies: RawCookie[];
}

export function sessionKey(
  tenantId: string,
  siteProfileId: string,
  browserIdentityId: string,
  identityKey = "",
): SessionKey {
  return { tenantId, siteProfileId, browserIdentityId, identityKey };
}

/** 세션 영속 포트. load=없으면 null(cold start), save=UPSERT(세대 증가). */
export interface BrowserSessionStore {
  load(key: SessionKey): Promise<CookieBundle | null>;
  save(key: SessionKey, bundle: CookieBundle): Promise<void>;
}

/**
 * 봉투암호화 경계. `kind`로 실 KMS vs dev-plaintext 를 구분(PgBrowserSessionStore 가 fail-closed 게이트에 사용).
 * encrypt/decrypt 는 동기(데이터키 해소는 구현 내부에서 캐시/주입) — 평문 버퍼는 반환 즉시 소비·폐기 대상.
 */
export interface SessionEncryptor {
  readonly kind: "kms" | "dev-plaintext";
  encrypt(plaintext: Buffer): { ciphertext: Buffer; kid: string };
  decrypt(ciphertext: Buffer, kid: string): Buffer;
}

/**
 * dev-POC 전용 암호화기 — 암호화하지 않는다(identity 변환). prod 에서는 PgBrowserSessionStore 가 거부한다.
 * enc_kid='dev-plaintext'가 컬럼이 평문임을 명시(prod 데이터와 절대 혼동 금지).
 */
export class DevPlaintextSessionEncryptor implements SessionEncryptor {
  readonly kind = "dev-plaintext" as const;
  encrypt(plaintext: Buffer): { ciphertext: Buffer; kid: string } {
    return { ciphertext: plaintext, kid: "dev-plaintext" };
  }
  decrypt(ciphertext: Buffer, _kid: string): Buffer {
    return ciphertext;
  }
}

// PROD 전제(이번 증분 미구현 — dev 만 동작. 릴리스 블로커 아님: 아래 생성자 fail-closed 가 prod 평문 at-rest 를
//   구조적으로 차단하므로, prod 는 두 전제가 충족되기 전까지 세션을 재사용하지 않는다 = 안전한 성능저하, 누출 아님):
//   ① KmsEnvelopeSessionEncryptor(kind:'kms', 데이터키 봉투암호화) — 레포에 at-rest 암호화 원시함수가 없다(HMAC sign +
//      SHA-256 hash-chain 뿐, security-contracts.md §5). 세션 쿠키는 인증 자료라 평문 at-rest 금지. ciphertext+enc_kid 는
//      DB, 키는 KMS/SecretStore(resume-token kid 회전 패턴).
//   ② SecretAccessRequest.purpose(ts/security-middleware-contract.ts) 닫힌 union 에 'browser_session' 추가 +
//      VaultSecretStoreBoundary RESOLVE_MATRIX(runtime-worker/browser-worker) 매핑('executor' 재사용 금지 — 자격증명/세션
//      분리) + README 패치로그. ①②가 함께 land 해야 prod 세션 재사용 가능.
export interface PgBrowserSessionStoreDeps {
  pool: Pool;
  encryptor: SessionEncryptor;
}

export interface PgBrowserSessionStoreOptions {
  /** dev-plaintext 암호화기를 허용(비프로덕션 한정). 기본 false → dev-plaintext 주입 시 생성자 throw(prod fail-closed). */
  allowDevPlaintext?: boolean;
}

export class PgBrowserSessionStore implements BrowserSessionStore {
  private readonly pool: Pool;
  private readonly encryptor: SessionEncryptor;

  constructor(deps: PgBrowserSessionStoreDeps, opts: PgBrowserSessionStoreOptions = {}) {
    // fail-closed: 평문 세션이 at-rest 로 새는 것을 구조적으로 막는다. 실 KMS 암호화기 없이는 생성 불가.
    if (deps.encryptor.kind === "dev-plaintext" && opts.allowDevPlaintext !== true) {
      throw new Error(
        "PgBrowserSessionStore: dev-plaintext encryptor requires explicit allowDevPlaintext=true (prod fail-closed — no plaintext session at rest)",
      );
    }
    this.pool = deps.pool;
    this.encryptor = deps.encryptor;
  }

  async load(key: SessionKey): Promise<CookieBundle | null> {
    const row = await withTenantTx(this.pool, key.tenantId, async (c: PoolClient) => {
      const r = await c.query<{ ciphertext: Buffer; enc_kid: string }>(
        `SELECT ciphertext, enc_kid FROM browser_sessions
          WHERE tenant_id=$1::uuid AND site_profile_id=$2::uuid AND browser_identity_id=$3::uuid AND identity_key=$4`,
        [key.tenantId, key.siteProfileId, key.browserIdentityId, key.identityKey],
      );
      return r.rows[0] ?? null;
    });
    if (row === null) return null;
    // decrypt → 단명 평문 버퍼 → JSON.parse. 평문은 여기서만, 반환 객체로만 흐른다(호출측이 즉시 소비).
    const plaintext = this.encryptor.decrypt(row.ciphertext, row.enc_kid);
    const parsed = JSON.parse(plaintext.toString("utf8")) as { cookies?: unknown };
    if (!Array.isArray(parsed.cookies)) return null; // 손상 → cold start(조용한 잘못된 세션 금지)
    return { cookies: parsed.cookies as RawCookie[] };
  }

  async save(key: SessionKey, bundle: CookieBundle): Promise<void> {
    // 평문 직렬화 → 즉시 암호화. 평문 버퍼는 이 메서드 지역으로만 존재(로그/반환 없음).
    const { ciphertext, kid } = this.encryptor.encrypt(Buffer.from(JSON.stringify(bundle), "utf8"));
    await withTenantTx(this.pool, key.tenantId, (c: PoolClient) =>
      c.query(
        `INSERT INTO browser_sessions
           (tenant_id, site_profile_id, browser_identity_id, identity_key, ciphertext, enc_kid, session_generation, updated_at, created_at)
         VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,1,now(),now())
         ON CONFLICT (tenant_id, site_profile_id, browser_identity_id, identity_key)
         DO UPDATE SET ciphertext = EXCLUDED.ciphertext,
                       enc_kid = EXCLUDED.enc_kid,
                       session_generation = browser_sessions.session_generation + 1,
                       updated_at = now()`,
        [key.tenantId, key.siteProfileId, key.browserIdentityId, key.identityKey, ciphertext, kid],
      ),
    );
  }
}
