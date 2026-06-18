/**
 * BrowserSessionStore — 재사용 인증 세션(쿠키 번들)의 영속 포트 + PostgreSQL 구현 (세션 재사용 방식 A).
 *
 * 저장소는 `browser_sessions`(db/migration_concurrency_idempotency.sql) — tenant-scoped, RLS(FORCE) 강제, PK=
 * (tenant_id, site_profile_id, browser_identity_id, identity_key). 쿠키 번들은 **봉투암호화**해 `ciphertext`(bytea)+
 * `enc_kid`로만 영속한다. 평문 쿠키는 인증 자료 = PlainSecret 급 — load→decrypt→setCookies / getAllCookies→encrypt→save
 * 의 **단명 지역변수**로만 존재하고 로그/직렬화/이벤트/artifact/LLM/audit 에 절대 흐르지 않는다.
 *
 * 보안 fail-closed: PgBrowserSessionStore 는 **실 암호화기(KMS/SecretStore 데이터키)** 없이는 생성 거부
 * (생성자 throw — 첫 save 아님). dev-plaintext 암호화기는 명시적 allowDevPlaintext 옵트인에서만 허용(prod 차단).
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

/** SecretStore/KMS에서 해소한 256-bit 데이터키로 세션 쿠키 번들을 AES-256-GCM 암호화한다. */
export class AesGcmSessionEncryptor implements SessionEncryptor {
  readonly kind = "kms" as const;
  private static readonly IV_BYTES = 12;
  private static readonly TAG_BYTES = 16;

  constructor(private readonly key: Buffer, private readonly kid: string) {
    if (key.length !== 32) {
      throw new Error("AesGcmSessionEncryptor: key must be exactly 32 bytes for AES-256-GCM");
    }
    if (kid.length === 0) {
      throw new Error("AesGcmSessionEncryptor: kid is required");
    }
  }

  encrypt(plaintext: Buffer): { ciphertext: Buffer; kid: string } {
    const iv = randomBytes(AesGcmSessionEncryptor.IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return { ciphertext: Buffer.concat([iv, cipher.getAuthTag(), body]), kid: this.kid };
  }

  decrypt(ciphertext: Buffer, kid: string): Buffer {
    if (kid !== this.kid) {
      throw new Error("AesGcmSessionEncryptor: enc_kid does not match configured key");
    }
    if (ciphertext.length < AesGcmSessionEncryptor.IV_BYTES + AesGcmSessionEncryptor.TAG_BYTES) {
      throw new Error("AesGcmSessionEncryptor: ciphertext too short");
    }
    const iv = ciphertext.subarray(0, AesGcmSessionEncryptor.IV_BYTES);
    const tag = ciphertext.subarray(AesGcmSessionEncryptor.IV_BYTES, AesGcmSessionEncryptor.IV_BYTES + AesGcmSessionEncryptor.TAG_BYTES);
    const body = ciphertext.subarray(AesGcmSessionEncryptor.IV_BYTES + AesGcmSessionEncryptor.TAG_BYTES);
    const decipher = createDecipheriv("aes-256-gcm", this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]);
  }
}

export interface KmsKeyring {
  readonly activeKid: string;
  readonly keys: ReadonlyMap<string, Buffer>;
}

/**
 * per-message DEK 봉투암호화 세션 암호화기. 각 encrypt마다 256-bit DEK를 새로 만들고,
 * active KEK(kid)로 DEK를 AES-GCM wrapping 한 뒤 본문을 DEK로 AES-GCM 암호화한다.
 */
export class KmsEnvelopeSessionEncryptor implements SessionEncryptor {
  readonly kind = "kms" as const;
  private static readonly VERSION = 1;
  private static readonly IV_BYTES = 12;
  private static readonly TAG_BYTES = 16;
  private static readonly KEY_BYTES = 32;

  constructor(private readonly keyring: KmsKeyring) {
    if (keyring.activeKid.length === 0 || keyring.keys.has(keyring.activeKid) !== true) {
      throw new Error("KmsEnvelopeSessionEncryptor: activeKid must exist in keyring");
    }
    for (const [kid, key] of keyring.keys.entries()) {
      if (kid.length === 0) {
        throw new Error("KmsEnvelopeSessionEncryptor: keyring kid is required");
      }
      if (key.length !== KmsEnvelopeSessionEncryptor.KEY_BYTES) {
        throw new Error(`KmsEnvelopeSessionEncryptor: KEK '${kid}' must be exactly 32 bytes`);
      }
    }
  }

  encrypt(plaintext: Buffer): { ciphertext: Buffer; kid: string } {
    const kek = this.requireKey(this.keyring.activeKid);
    const dek = randomBytes(KmsEnvelopeSessionEncryptor.KEY_BYTES);
    const wrappedDek = this.encryptAesGcm(kek, dek);
    const body = this.encryptAesGcm(dek, plaintext);
    return {
      ciphertext: Buffer.concat([Buffer.from([KmsEnvelopeSessionEncryptor.VERSION]), wrappedDek, body]),
      kid: this.keyring.activeKid,
    };
  }

  decrypt(ciphertext: Buffer, kid: string): Buffer {
    const kek = this.requireKey(kid);
    const headerBytes = 1;
    const sealedDekBytes =
      KmsEnvelopeSessionEncryptor.IV_BYTES +
      KmsEnvelopeSessionEncryptor.TAG_BYTES +
      KmsEnvelopeSessionEncryptor.KEY_BYTES;
    const minBytes = headerBytes + sealedDekBytes + KmsEnvelopeSessionEncryptor.IV_BYTES + KmsEnvelopeSessionEncryptor.TAG_BYTES;
    if (ciphertext.length < minBytes) {
      throw new Error("KmsEnvelopeSessionEncryptor: ciphertext too short");
    }
    if (ciphertext[0] !== KmsEnvelopeSessionEncryptor.VERSION) {
      throw new Error("KmsEnvelopeSessionEncryptor: unsupported ciphertext version");
    }
    const wrappedDek = ciphertext.subarray(headerBytes, headerBytes + sealedDekBytes);
    const body = ciphertext.subarray(headerBytes + sealedDekBytes);
    const dek = this.decryptAesGcm(kek, wrappedDek);
    if (dek.length !== KmsEnvelopeSessionEncryptor.KEY_BYTES) {
      throw new Error("KmsEnvelopeSessionEncryptor: unwrapped DEK length invalid");
    }
    return this.decryptAesGcm(dek, body);
  }

  private requireKey(kid: string): Buffer {
    const key = this.keyring.keys.get(kid);
    if (key === undefined) {
      throw new Error(`KmsEnvelopeSessionEncryptor: unknown enc_kid '${kid}'`);
    }
    return key;
  }

  private encryptAesGcm(key: Buffer, plaintext: Buffer): Buffer {
    const iv = randomBytes(KmsEnvelopeSessionEncryptor.IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]);
  }

  private decryptAesGcm(key: Buffer, sealed: Buffer): Buffer {
    if (sealed.length < KmsEnvelopeSessionEncryptor.IV_BYTES + KmsEnvelopeSessionEncryptor.TAG_BYTES) {
      throw new Error("KmsEnvelopeSessionEncryptor: sealed payload too short");
    }
    const iv = sealed.subarray(0, KmsEnvelopeSessionEncryptor.IV_BYTES);
    const tag = sealed.subarray(
      KmsEnvelopeSessionEncryptor.IV_BYTES,
      KmsEnvelopeSessionEncryptor.IV_BYTES + KmsEnvelopeSessionEncryptor.TAG_BYTES,
    );
    const body = sealed.subarray(KmsEnvelopeSessionEncryptor.IV_BYTES + KmsEnvelopeSessionEncryptor.TAG_BYTES);
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]);
  }
}

/** base64/base64url(접두 "base64:" 허용) 인코딩 32바이트 → AES-256 데이터키. 그 외 길이는 throw. */
export function decodeBrowserSessionDataKey(secret: string): Buffer {
  const raw = secret.trim();
  const encoded = raw.startsWith("base64:") ? raw.slice("base64:".length) : raw;
  const normalized = encoded.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.length % 4 === 0 ? normalized : normalized + "=".repeat(4 - (normalized.length % 4));
  const key = Buffer.from(padded, "base64");
  if (key.length !== 32) {
    throw new Error("browser_session key must be base64/base64url encoded 32 bytes for AES-256-GCM");
  }
  return key;
}

interface ParsedSessionKek {
  kid: string;
  key: string;
}
function isParsedSessionKek(v: unknown): v is ParsedSessionKek {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as { kid?: unknown }).kid === "string" &&
    (v as { kid: string }).kid.length > 0 &&
    typeof (v as { key?: unknown }).key === "string"
  );
}

/**
 * SecretStore 의 KEK SecretRef 를 1회 해소해 AesGcmSessionEncryptor 를 만든다(동기 인터페이스라 빌드시 해소).
 * 페이로드 = `{kid, key}` JSON(key=base64/base64url 32바이트). **kid 는 페이로드에서** 오므로, api(capture/complete
 * 암호화)·runtime-worker(세션 복원 복호화)가 동일 {kid,key} 를 각자 namespace 에 seed 하면 **cross-identity round-trip**
 * 이 성립한다(enc_kid 일치). resume-token kid 회전 패턴 미러.
 */
export async function buildAesGcmSessionEncryptor(store: SecretStore, kekRef: SecretRef): Promise<AesGcmSessionEncryptor> {
  const raw: PlainSecret = await store.resolve(kekRef);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw as string);
  } catch {
    throw new Error("buildAesGcmSessionEncryptor: KEK SecretRef 페이로드가 유효한 JSON 이 아님(기대: {kid,key})");
  }
  if (!isParsedSessionKek(parsed)) {
    throw new Error("buildAesGcmSessionEncryptor: KEK SecretRef 페이로드는 {kid, key} 여야 함");
  }
  return new AesGcmSessionEncryptor(decodeBrowserSessionDataKey(parsed.key), parsed.kid);
}

export async function buildKmsSessionEncryptor(store: SecretStore, kekRef: SecretRef): Promise<KmsEnvelopeSessionEncryptor> {
  const raw: PlainSecret = await store.resolve(kekRef);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw as string);
  } catch {
    throw new Error("buildKmsSessionEncryptor: KEK SecretRef 페이로드가 유효한 JSON 이 아님(기대: {kid,key})");
  }
  if (!isParsedSessionKek(parsed)) {
    throw new Error("buildKmsSessionEncryptor: KEK SecretRef 페이로드는 {kid, key} 여야 함");
  }
  const kid = parsed.kid;
  return new KmsEnvelopeSessionEncryptor({ activeKid: kid, keys: new Map([[kid, decodeBrowserSessionDataKey(parsed.key)]]) });
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
