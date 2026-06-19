/**
 * S3ObjectStore — `ObjectStore`(pg-gateway-artifact-sink.ts) 의 실제 S3 구현 (D8-A10 object_store).
 *
 * AWS S3 (및 S3 호환/MinIO) REST API 에 대해 **AWS Signature Version 4** 로 서명한 get/put/delete 를
 * 수행한다. 추가 npm 의존 없이 Node `crypto` 로 SigV4 (canonical request → string-to-sign →
 * HMAC-SHA256 signing-key chain) 를 직접 구현한다. HTTP 계층(`HttpTransport`)과 시계(`now`)는 주입 가능
 * (기본 global `fetch` / `Date`) — 테스트는 mock transport + 고정 시계로 결정형 서명을 검증한다(라이브 네트워크 없음).
 *
 * 보안 경계:
 *  - `secretAccessKey` 는 **PlainSecret** 으로 도착한다(Vault → SecretStore.resolve 경계에서 생성).
 *    오직 SigV4 HMAC signing-key 체인 안에서만 사용하며 로그/직렬화 sink 로 절대 흐르지 않는다
 *    (core-types brand + no-secret-taint lint, security-contracts §1·§4).
 *  - 오류 메시지에는 http status 와 key(object 경로)만 담는다 — 자격(accessKeyId/secretAccessKey),
 *    Authorization 헤더, 서명, object 바이트는 절대 포함하지 않는다.
 *  - object key 는 raw storage locator(내부 전용)다. 이 모듈은 ObjectStore 계약상 file/s3 URI 형식의
 *    ObjectRef 를 반환할 뿐이며, ObjectRef 의 public 노출 차단은 retention/redactor 증거 계층 책임이다
 *    (ARTIFACT_LIFECYCLE_OPERATIONAL_CONTRACT objectRefInternalOnly:true).
 */
import { createHash, createHmac, randomUUID } from "node:crypto";

import type { ObjectRef, PlainSecret } from "../../../ts/core-types";
import type { ObjectStore } from "../gateway/pg-gateway-artifact-sink";

/** 주입 가능한 최소 HTTP 표면(테스트 mock 경계). global `fetch` 의 부분집합. */
export type S3HttpTransport = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: Uint8Array;
  },
) => Promise<S3HttpTransportResponse>;

export interface S3HttpTransportResponse {
  readonly ok: boolean;
  readonly status: number;
  /** 응답 바디 바이트. get 성공 시 object 바이트, 오류 시 S3 XML 에러(파싱 안 함). */
  bytes(): Promise<Uint8Array>;
}

export interface S3ObjectStoreConfig {
  /** 절대 https endpoint — AWS(예: "https://s3.us-east-1.amazonaws.com") 또는 S3 호환/MinIO. 끝 슬래시 무시. */
  endpoint: string;
  /** AWS region(서명 scope). MinIO 는 보통 "us-east-1". */
  region: string;
  bucket: string;
  accessKeyId: string;
  /** Vault → SecretStore.resolve 로 도착한 PlainSecret. SigV4 HMAC 안에서만 사용(로그/직렬화 금지). */
  secretAccessKey: PlainSecret;
  /** 테스트/대체용 HTTP 주입(기본 global fetch). */
  transport?: S3HttpTransport;
  /** 서명 타임스탬프 결정성(테스트). 기본 system clock. */
  clock?: () => Date;
  /**
   * path-style 주소(버킷을 path 로 — MinIO/호환 기본). 기본 true.
   * false 면 virtual-hosted–style(`<bucket>.<host>`) — AWS 권장.
   */
  forcePathStyle?: boolean;
  /** S3 서비스 식별자(서명 scope). 기본 "s3". */
  service?: string;
}

/**
 * fail-closed 오류 — 메시지에 자격/서명/Authorization/object 바이트를 절대 싣지 않는다.
 * `key`(object 경로)와 `status`(HTTP 상태)만 진단용으로 노출한다.
 */
export class S3ObjectStoreError extends Error {
  constructor(
    readonly stage: "config" | "get" | "put" | "delete",
    message: string,
    readonly key?: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "S3ObjectStoreError";
  }
}

/** 빈 바디 sha256(SigV4 UNSIGNED 대신 실제 해시; GET/DELETE 는 빈 바디). */
const EMPTY_PAYLOAD_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

export class S3ObjectStore implements ObjectStore {
  private readonly endpoint: string;
  private readonly host: string;
  private readonly scheme: string;
  private readonly region: string;
  private readonly bucket: string;
  private readonly accessKeyId: string;
  private readonly secretAccessKey: PlainSecret;
  private readonly transport: S3HttpTransport;
  private readonly clock: () => Date;
  private readonly forcePathStyle: boolean;
  private readonly service: string;

  constructor(config: S3ObjectStoreConfig) {
    const endpoint = config.endpoint.trim().replace(/\/+$/, "");
    let parsed: URL;
    try {
      parsed = new URL(endpoint);
    } catch {
      throw new S3ObjectStoreError("config", "S3ObjectStore endpoint must be an absolute URL");
    }
    if (parsed.protocol !== "https:") {
      throw new S3ObjectStoreError("config", "S3ObjectStore endpoint must be an absolute https URL");
    }
    if (config.region.trim() === "") {
      throw new S3ObjectStoreError("config", "S3ObjectStore region is required");
    }
    if (config.bucket.trim() === "") {
      throw new S3ObjectStoreError("config", "S3ObjectStore bucket is required");
    }
    if (config.accessKeyId.trim() === "") {
      throw new S3ObjectStoreError("config", "S3ObjectStore accessKeyId is required");
    }
    if (String(config.secretAccessKey).length === 0) {
      throw new S3ObjectStoreError("config", "S3ObjectStore secretAccessKey is required");
    }
    this.endpoint = endpoint;
    this.scheme = parsed.protocol; // "https:"
    this.host = parsed.host; // host[:port]
    this.region = config.region.trim();
    this.bucket = config.bucket.trim();
    this.accessKeyId = config.accessKeyId.trim();
    this.secretAccessKey = config.secretAccessKey;
    this.transport = config.transport ?? defaultFetchTransport;
    this.clock = config.clock ?? (() => new Date());
    this.forcePathStyle = config.forcePathStyle ?? true;
    this.service = (config.service ?? "s3").trim();
  }

  /** content 를 새 무작위 key 에 PUT → ObjectRef(s3://bucket/key) 반환. */
  async put(content: string): Promise<ObjectRef> {
    return this.putBytes(new TextEncoder().encode(content));
  }

  /** RAW bytes PUT. Redaction and visual evidence must not round-trip through UTF-8 text. */
  async putBytes(content: Uint8Array): Promise<ObjectRef> {
    const key = `${randomUUID()}.bin`;
    const body = new Uint8Array(content);
    const res = await this.send("PUT", key, body);
    if (!res.ok) {
      throw new S3ObjectStoreError("put", `s3 put returned HTTP ${res.status}`, key, res.status);
    }
    return this.toObjectRef(key);
  }

  /** ObjectRef → object 바이트(utf8 문자열). 부재(404/NoSuchKey)는 null(존재하지 않는 object). */
  async get(objectRef: ObjectRef): Promise<string | null> {
    const bytes = await this.getBytes(objectRef);
    if (bytes === null) return null;
    return new TextDecoder().decode(bytes);
  }

  /**
   * ObjectRef → object 의 RAW 바이트(디코드 없음). 부재(404/NoSuchKey)는 null. redaction 파이프라인이
   * 바이너리 fail-closed 를 유지하려면 이 경로를 써야 한다(TextDecoder 의 U+FFFD 치환으로 binary 가
   * always-valid UTF-8 텍스트로 둔갑하는 것을 차단).
   */
  async getBytes(objectRef: ObjectRef): Promise<Uint8Array | null> {
    const key = this.keyFromObjectRef(objectRef, "get");
    const res = await this.send("GET", key, undefined);
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new S3ObjectStoreError("get", `s3 get returned HTTP ${res.status}`, key, res.status);
    }
    return res.bytes();
  }

  /**
   * ObjectRef DELETE. S3 DELETE 는 멱등(부재여도 204) — 부재/존재 모두 정상 반환.
   * 5xx/네트워크는 throw(상위 retention 계층이 transient_failed 로 매핑; 삭제로 간주 금지).
   * (계약상 반환은 void — 부재/삭제 구분은 retention store 가 별도 HEAD 없이 처리하지 않는다;
   *  S3 DELETE 자체가 부재를 성공으로 흡수하므로 호출부는 transient 실패만 구분하면 된다.)
   */
  async delete(objectRef: ObjectRef): Promise<void> {
    const key = this.keyFromObjectRef(objectRef, "delete");
    const res = await this.send("DELETE", key, undefined);
    // S3 DELETE: 204(삭제됨) 또는 404 NoSuchKey(이미 부재) 모두 멱등 성공.
    if (res.ok || res.status === 404) return;
    throw new S3ObjectStoreError("delete", `s3 delete returned HTTP ${res.status}`, key, res.status);
  }

  /**
   * ObjectRef 가 부재(이미 삭제됨)인지 구분 가능한 멱등 삭제. retention 계층이 deleted/not_found 를
   * 구분하는 데 사용한다(ObjectStore.delete 는 void 라 둘을 합치므로 별도 표면).
   *
   * 실 S3/MinIO 의 DELETE 는 **부재여도 204** 를 돌려준다(404 가 아님 — delete() 주석 참조). 따라서 DELETE
   * status 만으로는 deleted/not_found 를 구분할 수 없다 → **HEAD 로 존재를 먼저 확인**한다: 부재(404)면
   * not_found(DELETE 생략), 존재하면 DELETE 후 deleted. HEAD~DELETE 사이 타 actor 가 지워 DELETE 가 404 여도
   * 객체는 사라진 상태이므로 deleted 로 본다. 5xx/네트워크 오류는 throw(삭제로 간주 금지).
   */
  async deleteDistinguishing(objectRef: ObjectRef): Promise<"deleted" | "not_found"> {
    const key = this.keyFromObjectRef(objectRef, "delete");
    const head = await this.send("HEAD", key, undefined);
    if (head.status === 404) return "not_found";
    if (!head.ok) {
      throw new S3ObjectStoreError("delete", `s3 head returned HTTP ${head.status}`, key, head.status);
    }
    const res = await this.send("DELETE", key, undefined);
    if (res.ok || res.status === 404) return "deleted";
    throw new S3ObjectStoreError("delete", `s3 delete returned HTTP ${res.status}`, key, res.status);
  }

  /** key → ObjectRef(s3://bucket/key) — 내부 locator. */
  private toObjectRef(key: string): ObjectRef {
    return `s3://${this.bucket}/${key}` as ObjectRef;
  }

  /** ObjectRef(s3://bucket/key) → key. 다른 bucket/형식은 throw(메시지에 ObjectRef 미포함 — stage 만). */
  private keyFromObjectRef(objectRef: ObjectRef, stage: "get" | "delete"): string {
    const ref = String(objectRef);
    const prefix = `s3://${this.bucket}/`;
    if (!ref.startsWith(prefix) || ref.length <= prefix.length) {
      // ObjectRef 는 내부 전용 — 오류 메시지에 값을 싣지 않는다(objectRefInternalOnly).
      throw new S3ObjectStoreError(stage, "objectRef is not an s3 ref for the configured bucket");
    }
    return ref.slice(prefix.length);
  }

  /** SigV4 서명 후 단일 HTTP 요청 송신. 네트워크 오류는 자격 누설 없이 throw. */
  private async send(
    method: "GET" | "PUT" | "DELETE" | "HEAD",
    key: string,
    body: Uint8Array | undefined,
  ): Promise<S3HttpTransportResponse> {
    const { url, headers } = this.signRequest(method, key, body);
    try {
      return await this.transport(url, { method, headers, body });
    } catch {
      // 원인 메시지(자격/서명/URL 토큰 가능성)를 절대 전파하지 않는다 — stage/key 만.
      const stage = method === "GET" ? "get" : method === "PUT" ? "put" : "delete";
      throw new S3ObjectStoreError(stage, `s3 ${method.toLowerCase()} failed (network)`, key);
    }
  }

  /**
   * AWS Signature Version 4 서명. canonical request → string-to-sign → signing-key 체인.
   * secretAccessKey(PlainSecret)는 오직 여기 HMAC 안에서만 쓰인다(로그/직렬화 없음).
   */
  private signRequest(
    method: string,
    key: string,
    body: Uint8Array | undefined,
  ): { url: string; headers: Record<string, string> } {
    const now = this.clock();
    const amzDate = toAmzDate(now); // YYYYMMDDTHHMMSSZ
    const dateStamp = amzDate.slice(0, 8); // YYYYMMDD

    const { host, canonicalUri, url } = this.resolveTarget(key);
    const payloadHash = body === undefined ? EMPTY_PAYLOAD_SHA256 : sha256hex(body);

    // 서명 대상 헤더(정렬·소문자) — host, x-amz-content-sha256, x-amz-date.
    const canonicalHeaders =
      `host:${host}\n` + `x-amz-content-sha256:${payloadHash}\n` + `x-amz-date:${amzDate}\n`;
    const signedHeaders = "host;x-amz-content-sha256;x-amz-date";

    const canonicalRequest = [
      method,
      canonicalUri,
      "", // canonical query string(없음)
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join("\n");

    const scope = `${dateStamp}/${this.region}/${this.service}/aws4_request`;
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      amzDate,
      scope,
      sha256hex(new TextEncoder().encode(canonicalRequest)),
    ].join("\n");

    const signingKey = this.deriveSigningKey(dateStamp);
    const signature = hmacHex(signingKey, stringToSign);

    const authorization =
      `AWS4-HMAC-SHA256 Credential=${this.accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`;

    return {
      url,
      headers: {
        host,
        "x-amz-date": amzDate,
        "x-amz-content-sha256": payloadHash,
        authorization,
      },
    };
  }

  /**
   * signing-key 체인. kSecret = "AWS4"+secret → kDate → kRegion → kService → kSigning.
   * secretAccessKey(PlainSecret)는 첫 HMAC key 로만 들어간다(이 함수 밖으로 나가지 않음).
   */
  private deriveSigningKey(dateStamp: string): Buffer {
    // PlainSecret → HMAC key. String() 은 log/serialize sink 가 아니므로 brand 누설 아님(HMAC 입력).
    const kSecret = `AWS4${String(this.secretAccessKey)}`;
    const kDate = hmac(kSecret, dateStamp);
    const kRegion = hmac(kDate, this.region);
    const kService = hmac(kRegion, this.service);
    return hmac(kService, "aws4_request");
  }

  /** path-style vs virtual-hosted-style 주소 + canonical URI(키 세그먼트 인코딩) 산출. */
  private resolveTarget(key: string): { host: string; canonicalUri: string; url: string } {
    const encodedKey = encodeS3Key(key);
    if (this.forcePathStyle) {
      const host = this.host;
      const canonicalUri = `/${this.bucket}/${encodedKey}`;
      return { host, canonicalUri, url: `${this.scheme}//${host}${canonicalUri}` };
    }
    const host = `${this.bucket}.${this.host}`;
    const canonicalUri = `/${encodedKey}`;
    return { host, canonicalUri, url: `${this.scheme}//${host}${canonicalUri}` };
  }
}

// === SigV4 primitives (Node crypto, no deps) ===

function hmac(key: string | Buffer, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

function hmacHex(key: Buffer, data: string): string {
  return createHmac("sha256", key).update(data, "utf8").digest("hex");
}

function sha256hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Date → AWS basic ISO8601 (YYYYMMDDTHHMMSSZ). */
function toAmzDate(date: Date): string {
  return date.toISOString().replace(/[:-]/g, "").replace(/\.\d{3}/, "");
}

/**
 * S3 canonical URI 키 인코딩 — RFC 3986, 단 "/" 는 path 구분자로 보존.
 * encodeURIComponent 가 인코딩하지 않는 !'()* 도 인코딩한다(AWS 규약).
 */
function encodeS3Key(key: string): string {
  return key
    .split("/")
    .map((seg) =>
      encodeURIComponent(seg).replace(
        /[!'()*]/g,
        (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
      ),
    )
    .join("/");
}

/** 기본 transport — Node 24 global fetch 어댑터(추가 의존 없음). */
const defaultFetchTransport: S3HttpTransport = async (url, init) => {
  // @types/node BodyInit 가 Uint8Array 를 직접 받지 않아 ArrayBuffer 복사본으로 전달.
  let body: ArrayBuffer | undefined;
  if (init.body !== undefined) {
    const copy = new Uint8Array(init.body.byteLength);
    copy.set(init.body);
    body = copy.buffer;
  }
  const res = await fetch(url, {
    method: init.method,
    headers: init.headers,
    body,
  });
  return {
    ok: res.ok,
    status: res.status,
    bytes: async () => new Uint8Array(await res.arrayBuffer()),
  };
};
