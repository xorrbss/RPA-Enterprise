/**
 * BrowserSessionStore — 재사용 인증 세션(쿠키 번들)의 영속 포트 + PostgreSQL 구현 (세션 재사용 방식 A).
 *
 * 저장소는 `browser_sessions`(db/migration_concurrency_idempotency.sql) — tenant-scoped, RLS(FORCE) 강제, PK=
 * (tenant_id, site_profile_id, browser_identity_id, identity_key). 쿠키 번들은 **봉투암호화**해 `ciphertext`(bytea)+
 * `enc_kid`로만 영속한다. 평문 쿠키는 인증 자료 = PlainSecret 급 — load→decrypt→setCookies / getAllCookies→encrypt→save
 * 의 **단명 지역변수**로만 존재하고 로그/직렬화/이벤트/artifact/LLM/audit 에 절대 흐르지 않는다.
 *
 * 보안 fail-closed: PgBrowserSessionStore 는 **실 암호화기(KMS)** 없이는 생성 거부(생성자 throw — 첫 save 아님).
 *   prod 는 KmsEnvelopeSessionEncryptor(per-message DEK 봉투암호화, buildKmsSessionEncryptor 로 KEK 1회 해소)를 주입한다.
 *   KEK SecretRef(rpa/<env>/<identity>/browser_session/active) 가 미프로비저닝이면 빌드 실패 → 세션 미등록(안전한 성능저하,
 *   누출 아님). dev-plaintext 암호화기는 명시적 allowDevPlaintext 옵트인에서만 허용(prod 차단).
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import type { Pool, PoolClient } from "pg";

import { withTenantTx } from "../db/pool";
import type { RawCookie } from "../executor/raw-cdp";
import type { PlainSecret, SecretRef, SecretStore } from "../../../ts/core-types";

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

/**
 * PROD 봉투암호화 암호화기 — 세션 쿠키(인증 자료)의 at-rest 평문을 막는다(kind:'kms' → PgBrowserSessionStore fail-closed
 * 게이트 통과). **per-message 데이터키(DEK) 봉투암호화**: 메시지마다 임의 DEK 로 평문을 AES-256-GCM, DEK 자체는 KEK
 * (SecretStore 가 보유, kid 로 식별·회전)로 다시 AES-256-GCM 래핑한다. ciphertext 는 자기완결 버퍼(version|wrappedDEK|
 * encMsg), enc_kid=KEK kid(회전 추적). 키는 DB 가 아닌 SecretStore(resume-token kid 회전 패턴 미러). GCM authTag 가 위변조를
 * 탐지(복호화 시 throw = 조용한 잘못된 세션 금지). 동기 인터페이스라 KEK 는 buildKmsSessionEncryptor 가 1회 해소(빌드시)한다.
 */
const KMS_VERSION = 0x01;
const DEK_BYTES = 32; // AES-256
const IV_BYTES = 12; // GCM 표준 nonce
const TAG_BYTES = 16; // GCM auth tag

export interface KmsKeyring {
  /** 신규 암호화에 쓸 활성 KEK kid. */
  readonly activeKid: string;
  /** kid → 32바이트 KEK. 회전 시 폐기 kid 를 함께 담아 grace 복호화 지원(활성 외 kid 는 복호화만). */
  readonly keys: ReadonlyMap<string, Buffer>;
}

export class KmsEnvelopeSessionEncryptor implements SessionEncryptor {
  readonly kind = "kms" as const;
  private readonly activeKid: string;
  private readonly keys: ReadonlyMap<string, Buffer>;

  constructor(keyring: KmsKeyring) {
    const active = keyring.keys.get(keyring.activeKid);
    if (active === undefined || active.length !== DEK_BYTES) {
      throw new Error("KmsEnvelopeSessionEncryptor: activeKid 가 keyring 에 없거나 KEK 가 32바이트가 아님");
    }
    this.activeKid = keyring.activeKid;
    this.keys = keyring.keys;
  }

  encrypt(plaintext: Buffer): { ciphertext: Buffer; kid: string } {
    const kek = this.keys.get(this.activeKid) as Buffer;
    const dek = randomBytes(DEK_BYTES);
    try {
      const ivK = randomBytes(IV_BYTES);
      const cK = createCipheriv("aes-256-gcm", kek, ivK);
      const wrappedDek = Buffer.concat([cK.update(dek), cK.final()]);
      const tagK = cK.getAuthTag();
      const ivM = randomBytes(IV_BYTES);
      const cM = createCipheriv("aes-256-gcm", dek, ivM);
      const encMsg = Buffer.concat([cM.update(plaintext), cM.final()]);
      const tagM = cM.getAuthTag();
      const ciphertext = Buffer.concat([Buffer.from([KMS_VERSION]), ivK, tagK, wrappedDek, ivM, tagM, encMsg]);
      return { ciphertext, kid: this.activeKid };
    } finally {
      dek.fill(0); // 평문 DEK 단명 — 즉시 폐기.
    }
  }

  decrypt(ciphertext: Buffer, kid: string): Buffer {
    const kek = this.keys.get(kid);
    if (kek === undefined) {
      throw new Error(`KmsEnvelopeSessionEncryptor: 알 수 없는 enc_kid '${kid}'(회전/폐기 키 — 복호화 불가)`); // 조용한 false 금지
    }
    let off = 0;
    if (ciphertext.length < 1 + IV_BYTES + TAG_BYTES + DEK_BYTES + IV_BYTES + TAG_BYTES || ciphertext[off] !== KMS_VERSION) {
      throw new Error("KmsEnvelopeSessionEncryptor: ciphertext 포맷/버전 불일치");
    }
    off += 1;
    const ivK = ciphertext.subarray(off, (off += IV_BYTES));
    const tagK = ciphertext.subarray(off, (off += TAG_BYTES));
    const wrappedDek = ciphertext.subarray(off, (off += DEK_BYTES));
    const ivM = ciphertext.subarray(off, (off += IV_BYTES));
    const tagM = ciphertext.subarray(off, (off += TAG_BYTES));
    const encMsg = ciphertext.subarray(off);
    const dK = createDecipheriv("aes-256-gcm", kek, ivK);
    dK.setAuthTag(tagK);
    const dek = Buffer.concat([dK.update(wrappedDek), dK.final()]); // authTag 불일치 → throw(위변조 탐지)
    try {
      const dM = createDecipheriv("aes-256-gcm", dek, ivM);
      dM.setAuthTag(tagM);
      return Buffer.concat([dM.update(encMsg), dM.final()]);
    } finally {
      dek.fill(0);
    }
  }
}

interface ParsedKek {
  kid: string;
  key: string; // base64 32바이트
}
function isParsedKek(v: unknown): v is ParsedKek {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as { kid?: unknown }).kid === "string" &&
    (v as { kid: string }).kid.length > 0 &&
    typeof (v as { key?: unknown }).key === "string"
  );
}

/**
 * KEK 를 SecretStore 에서 1회 해소해 KmsEnvelopeSessionEncryptor 를 만든다(동기 인터페이스라 빌드시 해소). 페이로드 모델은
 * resume-token 과 동일: SecretStore.resolve(ref) → `{kid, key}` JSON(활성 KEK, well-known SecretRef). key=base64 32바이트.
 * 회전 grace(폐기 kid 복호화)는 후속 — 현재 활성 {kid,key} 단일(미러: HmacResumeTokenCodec).
 */
export async function buildKmsSessionEncryptor(store: SecretStore, kekRef: SecretRef): Promise<KmsEnvelopeSessionEncryptor> {
  const raw: PlainSecret = await store.resolve(kekRef);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw as string);
  } catch {
    throw new Error("buildKmsSessionEncryptor: KEK SecretRef 페이로드가 유효한 JSON 이 아님(기대: {kid,key})");
  }
  if (!isParsedKek(parsed)) {
    throw new Error("buildKmsSessionEncryptor: KEK SecretRef 페이로드는 {kid, key} 여야 함");
  }
  const key = Buffer.from(parsed.key, "base64");
  if (key.length !== DEK_BYTES) {
    throw new Error(`buildKmsSessionEncryptor: KEK 는 base64 인코딩된 32바이트여야 함(받은 길이 ${key.length})`);
  }
  return new KmsEnvelopeSessionEncryptor({ activeKid: parsed.kid, keys: new Map([[parsed.kid, key]]) });
}

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
