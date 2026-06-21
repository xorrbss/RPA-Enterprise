/**
 * Fail-closed env 스칼라 파서 + https-URL 검증 + Vault AppRole identity 로더 (leaf — process.env 외 의존 없음).
 * env.ts / env-artifact-lifecycle.ts 가 공유한다. "조용한 false/unknown 금지": 필수값 부재 시 throw, secret 무-기본값.
 */

export function req(name: string): string {
  const v = process.env[name];
  if (v === undefined || v.trim() === "") {
    throw new Error(`missing required env ${name} (fail-closed config ??refusing to start)`);
  }
  return v.trim();
}

export function opt(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v.trim() === "" ? undefined : v.trim();
}

export function num(name: string, dflt: number): number {
  const v = opt(name);
  if (v === undefined) return dflt;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`env ${name} must be a finite number, got ${JSON.stringify(v)}`);
  return n;
}

export function positiveInt(name: string, dflt: number): number {
  const value = num(name, dflt);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`env ${name} must be a positive integer, got ${value}`);
  }
  return value;
}

export function bool(name: string, dflt: boolean): boolean {
  const v = opt(name);
  if (v === undefined) return dflt;
  return v.toLowerCase() !== "false";
}

export function strictBool(name: string, dflt: boolean): boolean {
  const v = opt(name);
  if (v === undefined) return dflt;
  const normalized = v.toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  throw new Error(`env ${name} must be true|false, got ${JSON.stringify(v)}`);
}

/** Validate a given value is an absolute https URL (no localhost exception) ??cleartext refused for
 *  credentialed/key-bearing endpoints (S3/Vault store discipline; Codex Bearer key; JWKS key fetch). */
export function assertHttpsUrl(name: string, v: string): string {
  let parsed: URL;
  try {
    parsed = new URL(v);
  } catch {
    throw new Error(`env ${name} must be an absolute URL, got ${JSON.stringify(v)}`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`env ${name} must be an https URL (no plaintext), got protocol ${JSON.stringify(parsed.protocol)}`);
  }
  return v;
}

export function reqHttpsUrl(name: string): string {
  return assertHttpsUrl(name, req(name));
}

export interface VaultIdentityConfig {
  readonly addr: string;
  readonly mount: string;
  readonly roleId: string;
  readonly secretId: string;
}

export function loadVaultIdentity(prefix: string): VaultIdentityConfig {
  return {
    addr: req("VAULT_ADDR"),
    mount: opt("VAULT_MOUNT") ?? "secret",
    roleId: req(`VAULT_${prefix}_ROLE_ID`),
    secretId: req(`VAULT_${prefix}_SECRET_ID`),
  };
}
