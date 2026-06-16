/**
 * 단위 테스트 — VaultSecretStore (mock HttpTransport, 라이브 네트워크 없음).
 *
 * 증명:
 *  - AppRole 로그인 흐름(POST auth/approle/login → auth.client_token 캐시).
 *  - KV v2 읽기(GET ${mount}/data/${ref})가 data.data.value 를 PlainSecret 으로 반환(값 정확).
 *  - 토큰이 X-Vault-Token 헤더로 전달.
 *  - 비-200 / 값 누락 → VaultSecretStoreError, 메시지에 토큰/시크릿 미누설.
 *  - 어떤 thrown error 에도 토큰/시크릿이 등장하지 않음.
 *
 * 실행: tsx test/vault-secret-store.unit.ts
 */
import type { SecretRef } from "../../ts/core-types";
import {
  VaultSecretStore,
  VaultSecretStoreError,
  type HttpTransport,
  type HttpTransportResponse,
} from "../src/secrets/vault-secret-store";

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const TOKEN = "s.SUPER-SECRET-VAULT-TOKEN-xyz";
const SECRET_VALUE = "p@ssw0rd-RESOLVED-PLAINTEXT";
const ROLE_ID = "role-id-do-not-leak";
const SECRET_ID = "secret-id-do-not-leak";
const BASE = "https://vault.test:8200";
const REF = "rpa/staging/runtime-worker/resume_token_hmac/active" as SecretRef;

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

function jsonResponse(status: number, body: unknown): HttpTransportResponse {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

/** 정상 경로 transport: login → token, read → data.data.value. 호출 기록. */
function happyTransport(calls: Call[]): HttpTransport {
  return async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body });
    if (url.endsWith("/v1/auth/approle/login")) {
      return jsonResponse(200, { auth: { client_token: TOKEN, lease_duration: 3600 } });
    }
    if (url.includes("/data/")) {
      return jsonResponse(200, { data: { data: { value: SECRET_VALUE }, metadata: { version: 1 } } });
    }
    return jsonResponse(404, {});
  };
}

function makeStore(transport: HttpTransport): VaultSecretStore {
  return new VaultSecretStore({
    baseUrl: BASE,
    mount: "secret",
    kvApiVersion: 2,
    transport,
    appRole: { roleId: ROLE_ID, secretId: SECRET_ID },
    now: () => 1_000_000,
  });
}

/** 토큰/시크릿/자격이 문자열 어디에도 없는지(심층 누설 점검). */
function assertNoLeak(label: string, text: string): void {
  const leaks = [TOKEN, SECRET_VALUE, ROLE_ID, SECRET_ID].filter((s) => text.includes(s));
  check(`${label}: 토큰/시크릿 미누설`, leaks.length === 0, leaks.length ? `leaked=${leaks.length} item(s)` : undefined);
}

async function main(): Promise<void> {
  // 1) AppRole 로그인 + KV v2 읽기 + 값 정확 + X-Vault-Token.
  {
    const calls: Call[] = [];
    const store = makeStore(happyTransport(calls));
    const secret = await store.resolve(REF);
    check("resolve 값 정확(data.data.value)", String(secret) === SECRET_VALUE, JSON.stringify(String(secret)));

    const login = calls.find((c) => c.url.endsWith("/v1/auth/approle/login"));
    check("AppRole login POST 발생", login?.method === "POST", login?.method);
    const loginBody = login?.body !== undefined ? (JSON.parse(login.body) as Record<string, unknown>) : {};
    check("login body 에 role_id/secret_id 전달", loginBody.role_id === ROLE_ID && loginBody.secret_id === SECRET_ID);

    const read = calls.find((c) => c.url.includes("/data/"));
    check("KV v2 read 경로", read?.url === `${BASE}/v1/secret/data/${REF}`, read?.url);
    check("read 가 X-Vault-Token 헤더로 토큰 전달", read?.headers["X-Vault-Token"] === TOKEN);
    check("read 는 GET", read?.method === "GET", read?.method);
  }

  // 2) 토큰 캐시 — 두 번째 resolve 는 재로그인하지 않음.
  {
    const calls: Call[] = [];
    const store = makeStore(happyTransport(calls));
    await store.resolve(REF);
    await store.resolve(REF);
    const logins = calls.filter((c) => c.url.endsWith("/v1/auth/approle/login")).length;
    check("토큰 캐시: 로그인 1회만", logins === 1, `logins=${logins}`);
  }

  // 3) 읽기 비-200 → VaultSecretStoreError, 토큰/시크릿 미누설.
  {
    const transport: HttpTransport = async (url, init) => {
      if (url.endsWith("/v1/auth/approle/login")) return jsonResponse(200, { auth: { client_token: TOKEN, lease_duration: 3600 } });
      return jsonResponse(403, { errors: ["permission denied"] });
    };
    const store = makeStore(transport);
    let threw: unknown;
    try {
      await store.resolve(REF);
    } catch (e) {
      threw = e;
    }
    check("read 403 → VaultSecretStoreError", threw instanceof VaultSecretStoreError, String(threw));
    check("read 403 → status 보존", threw instanceof VaultSecretStoreError && threw.status === 403);
    assertNoLeak("read 403 error", errorText(threw));
  }

  // 4) 값 누락(data.data.value 없음) → VaultSecretStoreError(fail-closed), 미누설.
  {
    const transport: HttpTransport = async (url) => {
      if (url.endsWith("/v1/auth/approle/login")) return jsonResponse(200, { auth: { client_token: TOKEN, lease_duration: 3600 } });
      return jsonResponse(200, { data: { data: { other: "no value here" } } });
    };
    const store = makeStore(transport);
    let threw: unknown;
    try {
      await store.resolve(REF);
    } catch (e) {
      threw = e;
    }
    check("값 누락 → VaultSecretStoreError", threw instanceof VaultSecretStoreError, String(threw));
    assertNoLeak("값 누락 error", errorText(threw));
  }

  // 5) 로그인 비-200 → VaultSecretStoreError(login stage), 자격 미누설.
  {
    const transport: HttpTransport = async () => jsonResponse(400, { errors: ["invalid role"] });
    const store = makeStore(transport);
    let threw: unknown;
    try {
      await store.resolve(REF);
    } catch (e) {
      threw = e;
    }
    check("login 400 → VaultSecretStoreError(login)", threw instanceof VaultSecretStoreError && threw.stage === "login", String(threw));
    assertNoLeak("login 400 error", errorText(threw));
  }

  // 6) 네트워크 오류 → VaultSecretStoreError, 원인 메시지(토큰/URL) 미누설.
  {
    const transport: HttpTransport = async (url) => {
      if (url.endsWith("/v1/auth/approle/login")) return jsonResponse(200, { auth: { client_token: TOKEN, lease_duration: 3600 } });
      throw new Error(`ECONNREFUSED ${url} X-Vault-Token=${TOKEN}`);
    };
    const store = makeStore(transport);
    let threw: unknown;
    try {
      await store.resolve(REF);
    } catch (e) {
      threw = e;
    }
    check("네트워크 오류 → VaultSecretStoreError", threw instanceof VaultSecretStoreError, String(threw));
    assertNoLeak("네트워크 오류 error", errorText(threw));
  }

  // 7) config 검증 — http base / appRole·tokenProvider 누락 거부.
  {
    let threwHttp: unknown;
    try {
      new VaultSecretStore({ baseUrl: "http://insecure", appRole: { roleId: "r", secretId: "s" } });
    } catch (e) {
      threwHttp = e;
    }
    check("http base 거부", threwHttp instanceof VaultSecretStoreError && threwHttp.stage === "config");

    let threwAuth: unknown;
    try {
      new VaultSecretStore({ baseUrl: BASE });
    } catch (e) {
      threwAuth = e;
    }
    check("appRole/tokenProvider 누락 거부", threwAuth instanceof VaultSecretStoreError && threwAuth.stage === "config");
  }

  console.log(`\nvault-secret-store.unit: ${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

/** thrown error 의 모든 직렬화 가능한 텍스트(message + name + JSON)를 모아 누설 점검. */
function errorText(error: unknown): string {
  if (error instanceof Error) {
    const own = JSON.stringify(error, Object.getOwnPropertyNames(error));
    return `${error.name}: ${error.message} ${error.stack ?? ""} ${own}`;
  }
  return String(error);
}

void main();
