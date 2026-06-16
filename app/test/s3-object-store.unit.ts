/**
 * 단위 테스트 — S3ObjectStore (mock S3HttpTransport, 고정 시계; 라이브 네트워크 없음).
 *
 * 증명:
 *  - SigV4 정확성 — 공개된 AWS canonical example vector("GET Object", us-east-1, service s3)의
 *    서명 `f0e8bdb8...` 를 본 모듈이 쓰는 동일한 signing-key 체인 primitive 로 재현(알고리즘 정확).
 *  - 위 example 자격/날짜를 S3ObjectStore 에 주입했을 때(GET, 본 store 의 signed-header 집합)
 *    결정형 서명 `df548e2c...` 를 산출(store wiring 정확) + Authorization/x-amz-* 헤더 형태.
 *  - get/put/delete 요청 형태(method/host/path-style URI) + 404→get null / delete 멱등.
 *  - secretAccessKey/signing-key 가 thrown error 어디에도(name+message+stack+own props) 미등장.
 *
 * 실행: tsx test/s3-object-store.unit.ts
 */
import { createHash, createHmac } from "node:crypto";

import type { ObjectRef, PlainSecret } from "../../ts/core-types";
import {
  S3ObjectStore,
  S3ObjectStoreError,
  type S3HttpTransport,
  type S3HttpTransportResponse,
} from "../src/artifacts/s3-object-store";

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

// === AWS 공개 예제 자격/날짜(문서 vector; 실 자격 아님) ===
const ACCESS_KEY = "AKIAIOSFODNN7EXAMPLE";
const SECRET_KEY = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" as PlainSecret;
const FIXED_DATE = new Date("2013-05-24T00:00:00.000Z");
// AWS docs "GET Object" example(Range 헤더 포함)의 공개 서명 — 알고리즘 정확성의 기준.
const AWS_PUBLISHED_SIGNATURE = "f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41";
// 본 store 가 동일 자격/날짜로 GET(자체 signed-header 집합)을 서명할 때의 결정형 산출.
const STORE_GET_SIGNATURE = "df548e2ce037944d03f3e68682813b093763996d597cf890ca3d9037fd231eb4";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: Uint8Array;
}

function okBytes(status: number, bytes: Uint8Array): S3HttpTransportResponse {
  return { ok: status >= 200 && status < 300, status, bytes: async () => bytes };
}

/** 호출을 기록하고 status/바이트를 반환하는 mock transport. */
function recordingTransport(calls: Call[], reply: (c: Call) => S3HttpTransportResponse): S3HttpTransport {
  return async (url, init) => {
    const call: Call = { url, method: init.method, headers: init.headers, body: init.body };
    calls.push(call);
    return reply(call);
  };
}

function makeStore(transport: S3HttpTransport, forcePathStyle = true): S3ObjectStore {
  return new S3ObjectStore({
    endpoint: forcePathStyle ? "https://s3.us-east-1.amazonaws.com" : "https://s3.amazonaws.com",
    region: "us-east-1",
    bucket: "examplebucket",
    accessKeyId: ACCESS_KEY,
    secretAccessKey: SECRET_KEY,
    transport,
    clock: () => FIXED_DATE,
    forcePathStyle,
  });
}

function parseAuthSignature(auth: string | undefined): string | undefined {
  const m = auth?.match(/Signature=([0-9a-f]+)/);
  return m?.[1];
}

async function main(): Promise<void> {
  // === (0) 알고리즘 기준: 공개 AWS example vector 재현 (본 모듈과 동일한 primitive). ===
  {
    const sig = reproduceAwsPublishedExample();
    check("AWS 공개 example 서명 재현(f0e8bdb8...)", sig === AWS_PUBLISHED_SIGNATURE, sig);
  }

  // === (1) store SigV4 wiring: virtual-hosted GET → 결정형 서명 + 헤더 형태. ===
  {
    const calls: Call[] = [];
    const store = makeStore(recordingTransport(calls, () => okBytes(200, new TextEncoder().encode("hello"))), false);
    const ref = "s3://examplebucket/test.txt" as ObjectRef;
    const got = await store.get(ref);
    check("get → 바이트 디코드", got === "hello", String(got));

    const c = calls[0];
    check("get 은 GET", c?.method === "GET", c?.method);
    // virtual-hosted: host = <bucket>.<host>, URI = /<key>
    check("virtual-hosted host", c?.headers.host === "examplebucket.s3.amazonaws.com", c?.headers.host);
    check("virtual-hosted URL", c?.url === "https://examplebucket.s3.amazonaws.com/test.txt", c?.url);
    check("x-amz-date 헤더(고정 시계)", c?.headers["x-amz-date"] === "20130524T000000Z", c?.headers["x-amz-date"]);
    check(
      "x-amz-content-sha256(빈 바디)",
      c?.headers["x-amz-content-sha256"] === "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      c?.headers["x-amz-content-sha256"],
    );
    const sig = parseAuthSignature(c?.headers.authorization);
    check("store GET 결정형 서명(df548e2c...)", sig === STORE_GET_SIGNATURE, sig);
    check(
      "Authorization Credential scope",
      c?.headers.authorization?.includes(`Credential=${ACCESS_KEY}/20130524/us-east-1/s3/aws4_request`) === true,
      c?.headers.authorization,
    );
  }

  // === (2) put → path-style URI + body 전달 + ObjectRef 반환. ===
  {
    const calls: Call[] = [];
    const store = makeStore(recordingTransport(calls, () => okBytes(200, new Uint8Array())), true);
    const ref = await store.put("payload-bytes");
    check("put → s3 ObjectRef(bucket prefix)", String(ref).startsWith("s3://examplebucket/"), String(ref));
    const c = calls[0];
    check("put 은 PUT", c?.method === "PUT", c?.method);
    // path-style: host = endpoint host, URI = /<bucket>/<key>
    check("path-style host", c?.headers.host === "s3.us-east-1.amazonaws.com", c?.headers.host);
    check("path-style URL prefix", c?.url.startsWith("https://s3.us-east-1.amazonaws.com/examplebucket/") === true, c?.url);
    check("put body 전달", c?.body !== undefined && new TextDecoder().decode(c.body) === "payload-bytes");
    // 바디 해시가 빈-바디 해시가 아니어야(실제 페이로드 서명).
    check(
      "put x-amz-content-sha256 = 실제 페이로드 해시",
      c?.headers["x-amz-content-sha256"] === createHash("sha256").update("payload-bytes").digest("hex"),
      c?.headers["x-amz-content-sha256"],
    );
  }

  // === (3) get 404 → null. ===
  {
    const store = makeStore(recordingTransport([], () => okBytes(404, new Uint8Array())), true);
    const got = await store.get("s3://examplebucket/missing" as ObjectRef);
    check("get 404 → null", got === null, String(got));
  }

  // === (4) delete 멱등: 204 / 404 모두 성공(throw 없음), distinguishing 은 둘을 구분. ===
  {
    const store204 = makeStore(recordingTransport([], () => okBytes(204, new Uint8Array())), true);
    let threw = false;
    try {
      await store204.delete("s3://examplebucket/x" as ObjectRef);
    } catch {
      threw = true;
    }
    check("delete 204 → 성공(no throw)", !threw);
    check("deleteDistinguishing 204 → deleted", (await store204.deleteDistinguishing("s3://examplebucket/x" as ObjectRef)) === "deleted");

    const store404 = makeStore(recordingTransport([], () => okBytes(404, new Uint8Array())), true);
    check("deleteDistinguishing 404 → not_found", (await store404.deleteDistinguishing("s3://examplebucket/x" as ObjectRef)) === "not_found");
  }

  // === (5) delete 5xx → throw(삭제로 간주 금지) + 자격/서명 미누설. ===
  {
    const store = makeStore(recordingTransport([], () => okBytes(503, new Uint8Array())), true);
    let threw: unknown;
    try {
      await store.deleteDistinguishing("s3://examplebucket/x" as ObjectRef);
    } catch (e) {
      threw = e;
    }
    check("delete 503 → S3ObjectStoreError", threw instanceof S3ObjectStoreError, String(threw));
    check("delete 503 → status 보존", threw instanceof S3ObjectStoreError && threw.status === 503);
    assertNoLeak("delete 503 error", errorText(threw));
  }

  // === (6) 네트워크 오류 → throw, 원인(자격/URL/서명) 미누설. ===
  {
    const transport: S3HttpTransport = async () => {
      // 원인 메시지에 자격/서명-유사 문자열을 일부러 심어 누설 차단을 검증.
      throw new Error(`ECONNRESET Signature=df548e2c secret=${String(SECRET_KEY)} AWS4${String(SECRET_KEY)}`);
    };
    const store = makeStore(transport, true);
    let threw: unknown;
    try {
      await store.get("s3://examplebucket/x" as ObjectRef);
    } catch (e) {
      threw = e;
    }
    check("네트워크 오류 → S3ObjectStoreError", threw instanceof S3ObjectStoreError, String(threw));
    assertNoLeak("네트워크 오류 error", errorText(threw));
  }

  // === (7) ObjectRef 가 다른 bucket → throw, 메시지에 ObjectRef 값 미포함. ===
  {
    const store = makeStore(recordingTransport([], () => okBytes(200, new Uint8Array())), true);
    let threw: unknown;
    try {
      await store.get("s3://OTHER-bucket/secret-object-locator" as ObjectRef);
    } catch (e) {
      threw = e;
    }
    check("타 bucket ObjectRef → S3ObjectStoreError", threw instanceof S3ObjectStoreError);
    check(
      "오류 메시지에 ObjectRef 값 미포함",
      !errorText(threw).includes("secret-object-locator") && !errorText(threw).includes("OTHER-bucket"),
      errorText(threw),
    );
  }

  // === (8) config 검증 — http base / 빈 region·bucket·accessKeyId·secret 거부. ===
  {
    check("http base 거부", configRejects({ endpoint: "http://insecure" }));
    check("빈 region 거부", configRejects({ region: "" }));
    check("빈 bucket 거부", configRejects({ bucket: "" }));
    check("빈 accessKeyId 거부", configRejects({ accessKeyId: "" }));
    check("빈 secret 거부", configRejects({ secretAccessKey: "" as PlainSecret }));
  }

  console.log(`\ns3-object-store.unit: ${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

/** config override 가 생성자에서 S3ObjectStoreError(config)로 거부되는지. */
function configRejects(override: Partial<{ endpoint: string; region: string; bucket: string; accessKeyId: string; secretAccessKey: PlainSecret }>): boolean {
  try {
    new S3ObjectStore({
      endpoint: "https://s3.us-east-1.amazonaws.com",
      region: "us-east-1",
      bucket: "examplebucket",
      accessKeyId: ACCESS_KEY,
      secretAccessKey: SECRET_KEY,
      transport: async () => okBytes(200, new Uint8Array()),
      clock: () => FIXED_DATE,
      ...override,
    });
    return false;
  } catch (e) {
    return e instanceof S3ObjectStoreError && e.stage === "config";
  }
}

/**
 * 공개 AWS "GET Object" example(Range 헤더 포함) 서명을 본 모듈과 동일한 signing-key 체인 primitive 로
 * 재현 — SigV4 알고리즘 자체의 정확성 기준(문서 vector).
 */
function reproduceAwsPublishedExample(): string {
  const hmac = (key: string | Buffer, data: string): Buffer => createHmac("sha256", key).update(data, "utf8").digest();
  const sha256hex = (data: string): string => createHash("sha256").update(data, "utf8").digest("hex");
  const payloadHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
  const host = "examplebucket.s3.amazonaws.com";
  const canonicalHeaders = `host:${host}\nrange:bytes=0-9\nx-amz-content-sha256:${payloadHash}\nx-amz-date:20130524T000000Z\n`;
  const signedHeaders = "host;range;x-amz-content-sha256;x-amz-date";
  const canonicalRequest = ["GET", "/test.txt", "", canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const scope = "20130524/us-east-1/s3/aws4_request";
  const stringToSign = ["AWS4-HMAC-SHA256", "20130524T000000Z", scope, sha256hex(canonicalRequest)].join("\n");
  const kDate = hmac(`AWS4${String(SECRET_KEY)}`, "20130524");
  const kRegion = hmac(kDate, "us-east-1");
  const kService = hmac(kRegion, "s3");
  const kSigning = hmac(kService, "aws4_request");
  return createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");
}

/** 시크릿/signing-key 가 텍스트 어디에도 없는지(심층 누설 점검). */
function assertNoLeak(label: string, text: string): void {
  const probes = [String(SECRET_KEY), `AWS4${String(SECRET_KEY)}`];
  const leaks = probes.filter((s) => text.includes(s));
  check(`${label}: secret/signing-key 미누설`, leaks.length === 0, leaks.length ? `leaked=${leaks.length}` : undefined);
}

/** thrown error 의 직렬화 가능한 텍스트(name+message+stack+own props)를 모아 누설 점검. */
function errorText(error: unknown): string {
  if (error instanceof Error) {
    const own = JSON.stringify(error, Object.getOwnPropertyNames(error));
    return `${error.name}: ${error.message} ${error.stack ?? ""} ${own}`;
  }
  return String(error);
}

void main();
