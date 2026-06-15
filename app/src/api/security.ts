/**
 * 제어평면 보안 인프라 (D7 선행 B2/B3 — D7 분석 §1.2/§4.3).
 *
 * B3 (보안 헤더): 모든 응답에 베이스라인 헤더(nosniff/frame-deny/referrer/CORP). API는 JSON만 반환하므로
 *   CSP는 정적 콘솔을 서빙하는 계층(nginx)의 소관이며 여기서는 부착하지 않는다(KISS, 분석 §3.4).
 * B2 (CORS): 기본은 same-origin(분석 권장: nginx/vite `/v1` 프록시) → corsOrigins 미지정 시 CORS 미등록.
 *   교차 출처 dev가 필요할 때만 명시적 allowlist로 opt-in한다(가정 금지: 와일드카드/credentials 자동허용 안 함).
 *
 * 주입형 설정(ApiServerDeps.security). 미지정 시 헤더만 적용하고 CORS는 비활성(same-origin 안전 기본값).
 */
import cors from "@fastify/cors";
import type { FastifyInstance } from "fastify";

export interface SecurityConfig {
  /** B2: 허용 origin allowlist. 미지정/빈 배열 → CORS 비활성(same-origin). */
  readonly corsOrigins?: readonly string[];
  /** B3: HSTS 부착(https 배포 환경에서만 의미; 로컬 http에서는 off 권장). 기본 false. */
  readonly hsts?: boolean;
}

const BASELINE_HEADERS: ReadonlyArray<readonly [string, string]> = [
  ["X-Content-Type-Options", "nosniff"],
  ["X-Frame-Options", "DENY"],
  ["Referrer-Policy", "no-referrer"],
  ["Cross-Origin-Resource-Policy", "same-origin"],
];

/**
 * 보안 미들웨어 등록. buildServer가 app 생성 직후(라우트/인증 훅 이전) 호출해야 CORS preflight가
 * 인증보다 먼저 처리되고 헤더가 모든 응답에 적용된다.
 */
export function registerSecurity(app: FastifyInstance, config: SecurityConfig): void {
  // B3: 베이스라인 보안 헤더(모든 응답). onSend는 에러 응답에도 적용된다.
  app.addHook("onSend", async (_request, reply, payload) => {
    for (const [name, value] of BASELINE_HEADERS) {
      reply.header(name, value);
    }
    if (config.hsts === true) {
      reply.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }
    return payload;
  });

  // B2: CORS opt-in. allowlist가 있을 때만 등록(same-origin 기본은 미등록).
  const origins = config.corsOrigins;
  if (origins !== undefined && origins.length > 0) {
    const allow = new Set(origins);
    // app.register는 ready()에서 로드된다(buildServer는 동기 반환). cors의 preflight onRequest가
    // 인증 preHandler보다 먼저 동작하도록 보안 등록을 라우트/인증 훅보다 앞서 호출한다.
    void app.register(cors, {
      origin: (origin, cb) => {
        // 동일 출처/비브라우저(origin undefined)는 허용, 그 외는 allowlist 일치 시에만(와일드카드 금지).
        cb(null, origin === undefined || allow.has(origin));
      },
      methods: ["GET", "POST", "PUT", "OPTIONS"],
      allowedHeaders: ["authorization", "content-type", "idempotency-key", "if-match", "x-correlation-id"],
      exposedHeaders: ["etag"],
      maxAge: 600,
    });
  }
}
