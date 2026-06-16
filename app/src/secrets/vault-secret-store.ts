/**
 * HashiCorp Vault SecretStore 어댑터 (D8-A14 — staging-decision-proposals.md §[EXTERNAL-FACT] 2).
 *
 * 계약: ts/core-types.ts `SecretStore { resolve(ref): Promise<PlainSecret> }`.
 *   - Vault KV v2, mount `secret`, 경로 `${mount}/data/${ref}` (ref = `rpa/<env>/<runtime>/<purpose>/<name>`).
 *   - 인증은 AppRole(`auth/approle/login`) — role_id/secret_id 는 **CONFIG(호출자가 env 로 주입)** 에서만
 *     오고 코드/로그에 절대 남지 않는다(security-contracts §1·§5, 하드코딩 금지).
 *   - 토큰은 lease 만료 직전까지 캐시 후 재로그인. **fail-closed**: 비-200/토큰 누락/값 누락/네트워크 오류는
 *     `VaultSecretStoreError` 로 throw 하며 메시지에 토큰/시크릿 값이 절대 포함되지 않는다(상태코드·ref 만).
 *
 * HTTP 계층은 주입 가능(`HttpTransport`) — 기본은 Node 24 global `fetch`. 테스트는 mock transport 를 주입해
 * 라이브 네트워크 없이 검증한다(app/src/gateway 의 fetchImpl 주입 패턴과 동일).
 *
 * PlainSecret brand 의 유일한 정당 생성 지점은 Vault 읽기 경계의 `asPlainSecret` 단일 캐스트다.
 */
import type { PlainSecret, SecretRef, SecretStore } from "../../../ts/core-types";
import { markPlainSecretFromStore } from "../../../security/compliance-scaffold";

/** 주입 가능한 최소 HTTP 표면(테스트 mock 경계). global `fetch` 의 부분집합. */
export type HttpTransport = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
  },
) => Promise<HttpTransportResponse>;

export interface HttpTransportResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}

/** 호출자가 env 로 주입하는 AppRole 자격(코드/로그에 절대 미포함). */
export interface VaultAppRoleConfig {
  roleId: string;
  secretId: string;
}

export interface VaultSecretStoreConfig {
  /** 절대 https base, 예: "https://vault.internal:8200" (끝 슬래시 없음). */
  baseUrl: string;
  /** KV v2 mount. 기본 "secret". */
  mount?: string;
  /** KV API 버전 — v1 계약상 2 고정. */
  kvApiVersion?: 2;
  /** 테스트/대체용 HTTP 주입(기본 global fetch). */
  transport?: HttpTransport;
  /** AppRole 자격(env 주입) 또는 직접 토큰 공급자(둘 중 하나 필수). */
  appRole?: VaultAppRoleConfig;
  tokenProvider?: () => Promise<string>;
  /**
   * lease 만료까지 남은 시간이 이 값(초) 이하면 재로그인. 기본 30s.
   * 시계는 주입 가능(테스트 결정성).
   */
  renewSkewSeconds?: number;
  now?: () => number;
}

/**
 * fail-closed 오류 — 메시지에 토큰/시크릿 값을 절대 싣지 않는다(상태코드/ref 경로만).
 * `ref` 는 시크릿 값이 아니라 논리 경로이므로 노출 안전(security-contracts §4).
 */
export class VaultSecretStoreError extends Error {
  constructor(
    readonly stage: "login" | "read" | "config",
    message: string,
    readonly ref?: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "VaultSecretStoreError";
  }
}

interface CachedToken {
  token: string;
  /** epoch ms 만료 시각(0 = 무기한 — tokenProvider 경로). */
  expiresAtMs: number;
}

export class VaultSecretStore implements SecretStore {
  private readonly baseUrl: string;
  private readonly mount: string;
  private readonly transport: HttpTransport;
  private readonly renewSkewMs: number;
  private readonly now: () => number;
  private cached?: CachedToken;
  private loginInFlight?: Promise<CachedToken>;

  constructor(private readonly config: VaultSecretStoreConfig) {
    const base = config.baseUrl.trim();
    if (!/^https:\/\//i.test(base)) {
      throw new VaultSecretStoreError("config", "VaultSecretStore baseUrl must be an absolute https URL");
    }
    if ((config.kvApiVersion ?? 2) !== 2) {
      throw new VaultSecretStoreError("config", "VaultSecretStore only supports KV API version 2");
    }
    if (config.appRole === undefined && config.tokenProvider === undefined) {
      throw new VaultSecretStoreError("config", "VaultSecretStore requires appRole or tokenProvider");
    }
    this.baseUrl = base.replace(/\/+$/, "");
    this.mount = (config.mount ?? "secret").replace(/^\/+|\/+$/g, "");
    this.transport = config.transport ?? defaultFetchTransport;
    this.renewSkewMs = Math.max(0, config.renewSkewSeconds ?? 30) * 1000;
    this.now = config.now ?? Date.now;
  }

  async resolve(ref: SecretRef): Promise<PlainSecret> {
    const path = normalizeRefPath(ref);
    const token = await this.getToken();
    const url = `${this.baseUrl}/v1/${this.mount}/data/${path}`;

    let res: HttpTransportResponse;
    try {
      res = await this.transport(url, {
        method: "GET",
        headers: { "X-Vault-Token": token },
      });
    } catch (cause) {
      // 네트워크 오류는 원인 메시지를 싣지 않는다(토큰/URL 누설 방지) — ref 경로만.
      throw new VaultSecretStoreError("read", `vault read failed (network) for ref ${path}`, path);
    }
    if (!res.ok) {
      throw new VaultSecretStoreError("read", `vault read returned HTTP ${res.status} for ref ${path}`, path, res.status);
    }

    const value = extractKvV2Value(await res.json().catch(() => undefined));
    if (value === undefined) {
      throw new VaultSecretStoreError("read", `vault read returned no data.data.value for ref ${path}`, path);
    }
    // 유일한 정당 brand 생성 지점. taint 추적 등록(safeSerialize 런타임 경계와 연동, 심층 방어).
    return asPlainSecret(value);
  }

  private async getToken(): Promise<string> {
    const cached = this.cached;
    if (cached !== undefined && !this.isNearExpiry(cached)) {
      return cached.token;
    }
    if (this.config.tokenProvider !== undefined) {
      const token = await this.config.tokenProvider();
      if (typeof token !== "string" || token.length === 0) {
        throw new VaultSecretStoreError("login", "tokenProvider returned an empty Vault token");
      }
      this.cached = { token, expiresAtMs: 0 };
      return token;
    }
    // AppRole 로그인 — 동시 호출은 단일 로그인으로 합류(과로그인 방지).
    if (this.loginInFlight === undefined) {
      this.loginInFlight = this.login().finally(() => {
        this.loginInFlight = undefined;
      });
    }
    this.cached = await this.loginInFlight;
    return this.cached.token;
  }

  private isNearExpiry(cached: CachedToken): boolean {
    if (cached.expiresAtMs === 0) return false; // 무기한(tokenProvider)
    return this.now() >= cached.expiresAtMs - this.renewSkewMs;
  }

  private async login(): Promise<CachedToken> {
    const appRole = this.config.appRole;
    if (appRole === undefined) {
      throw new VaultSecretStoreError("login", "AppRole config is missing");
    }
    const url = `${this.baseUrl}/v1/auth/approle/login`;

    let res: HttpTransportResponse;
    try {
      res = await this.transport(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        // role_id/secret_id 는 CONFIG(env) 에서만 온다 — 본문에만 실리고 로그/메시지엔 절대 안 나간다.
        body: JSON.stringify({ role_id: appRole.roleId, secret_id: appRole.secretId }),
      });
    } catch (cause) {
      throw new VaultSecretStoreError("login", "vault approle login failed (network)");
    }
    if (!res.ok) {
      throw new VaultSecretStoreError("login", `vault approle login returned HTTP ${res.status}`, undefined, res.status);
    }

    const auth = extractAuth(await res.json().catch(() => undefined));
    if (auth === undefined) {
      throw new VaultSecretStoreError("login", "vault approle login returned no auth.client_token");
    }
    const leaseMs = auth.leaseDurationSeconds > 0 ? auth.leaseDurationSeconds * 1000 : 0;
    return { token: auth.clientToken, expiresAtMs: leaseMs === 0 ? 0 : this.now() + leaseMs };
  }
}

/**
 * PlainSecret brand 의 단일 정당 생성 지점(Vault 읽기 경계). 동시에 런타임 taint 집합에 등록해
 * safeSerialize/no-secret-taint 경계가 누설을 잡도록 한다(core-types brand + security §4 심층 방어).
 */
function asPlainSecret(value: string): PlainSecret {
  return markPlainSecretFromStore(value);
}

/** ref 논리 경로 정규화(선행/후행 슬래시 제거). 시크릿 값 아님. */
function normalizeRefPath(ref: SecretRef): string {
  const path = String(ref).trim().replace(/^\/+|\/+$/g, "");
  if (path.length === 0) {
    throw new VaultSecretStoreError("read", "SecretRef path is empty");
  }
  return path;
}

interface ParsedAuth {
  clientToken: string;
  leaseDurationSeconds: number;
}

function extractAuth(body: unknown): ParsedAuth | undefined {
  if (body === null || typeof body !== "object") return undefined;
  const auth = (body as { auth?: unknown }).auth;
  if (auth === null || typeof auth !== "object") return undefined;
  const clientToken = (auth as { client_token?: unknown }).client_token;
  if (typeof clientToken !== "string" || clientToken.length === 0) return undefined;
  const lease = (auth as { lease_duration?: unknown }).lease_duration;
  const leaseDurationSeconds = typeof lease === "number" && Number.isFinite(lease) && lease > 0 ? Math.floor(lease) : 0;
  return { clientToken, leaseDurationSeconds };
}

/** KV v2 읽기 응답에서 `data.data.value` 추출. 구조 불일치면 undefined(fail-closed). */
function extractKvV2Value(body: unknown): string | undefined {
  if (body === null || typeof body !== "object") return undefined;
  const outer = (body as { data?: unknown }).data;
  if (outer === null || typeof outer !== "object") return undefined;
  const inner = (outer as { data?: unknown }).data;
  if (inner === null || typeof inner !== "object") return undefined;
  const value = (inner as { value?: unknown }).value;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** 기본 transport — Node 24 global fetch 어댑터(추가 의존 없음). */
const defaultFetchTransport: HttpTransport = async (url, init) => {
  const res = await fetch(url, { method: init.method, headers: init.headers, body: init.body });
  return {
    ok: res.ok,
    status: res.status,
    json: () => res.json(),
  };
};
