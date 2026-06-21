/**
 * ContentRedactionTransform — `ArtifactContentTransform`(s3-artifact-redactor.ts) 의 DEFAULT,
 * security-contracts §4-anchored TEXT/JSON redactor. checklist row 51(artifact redaction object I/O)을
 * 텍스트/JSON artifact 에 대해 end-to-end 실행 가능하게 한다.
 *
 * ┌─ MASKING PRINCIPLE: OVER-MASK is safe, UNDER-MASK is a leak ────────────────────┐
 * │ §4 대상 클래스에 대해 **타깃 값의 어떤 일부도 새지 않는 것**이 1차 불변식이다. 양성(benign)    │
 * │ 텍스트를 과(過)마스킹하는 것은 허용 — 시크릿/PII 값의 일부라도 누출하는 것은 금지. 따라서      │
 * │ 구분자-경계 부분 마스킹(delimiter-bounded partial)을 버리고, **JSON 정확 경계** 또는           │
 * │ **키워드→EOL(줄 끝까지)** 마스킹을 쓴다(꼬리 누출 차단). 자기-구분(self-delimiting) PATTERN    │
 * │ 마스크(이메일/카드/RRN/전화/Bearer)는 토큰 전체를 매칭하므로 그대로 둔다(건전).               │
 * └──────────────────────────────────────────────────────────────────────────────────┘
 *
 * ┌─ TWO PATHS ────────────────────────────────────────────────────────────────────┐
 * │ (A) JSON-aware: fatal-decode·비바이너리 텍스트가 JSON.parse 에 성공하면 값을 재귀 walk 한다.  │
 * │     - KEY 가 민감 키(credential/PII)면 **값 전체**를 클래스 라벨로 치환(JSON 이 값 경계를      │
 * │       정확히 주므로 누출 0). - 그 외 값엔 self-delimiting PATTERN 마스크 적용. 재직렬화.        │
 * │ (B) 비-JSON line/text: 줄 단위로 - 민감 KEY 토큰 뒤 `:`/`=`/탭/다중공백(2+) 구분자가 오면       │
 * │     그 줄의 구분자 끝부터 **EOL 까지** 클래스 라벨로 마스킹(꼬리 누출 0). + Authorization/Bearer  │
 * │     EOL. + PATTERN 마스크. (키 substring 매칭 = JSON 경로와 대칭 — access_token 등 접두 키 포함.)  │
 * └──────────────────────────────────────────────────────────────────────────────────┘
 *
 * ┌─ SCOPE & FAIL-CLOSED ──────────────────────────────────────────────────────┐
 * │ 본 변환은 **UTF-8 텍스트/JSON** artifact 만 처리한다. 입력이 유효 UTF-8 텍스트가 아니거나   │
 * │ (fatal 디코드 통과 후에도) NUL/U+FFFD/과도한 C0 control 비율 같은 **콘텐츠 기반** 바이너리   │
 * │ 신호가 있거나, meta.type 이 image/binary 를 가리키면 **fail-closed**(throw) 한다 — redactor │
 * │ 가 이를 terminal_failed 로 매핑한다. 바이너리 판정은 **콘텐츠**가 1차 가드이고 meta.type 은  │
 * │ 추가 힌트일 뿐이다(artifacts.type 은 개방형이라 단독 가드로 신뢰 불가). 미마스킹/미지원       │
 * │ 바이트를 "not_required" 로 위장하지 않는다("조용한 false 금지").                          │
 * │                                                                                  │
 * │ 이미지 redaction(VLM 민감영역 마스킹, security-contracts §4 "이미지" + adapter md §6)은      │
 * │ 별개의 capability 다 — 텍스트 변환의 범위 밖이므로 여기서 처리하지 않고 fail-closed 한다.      │
 * └──────────────────────────────────────────────────────────────────────────────┘
 *
 * not_required 미반환(false-clean 금지): 본 변환은 유효 텍스트에 대해 명시적 면제 신호가 없으므로
 * **항상 `redacted`** 를 반환한다(매칭이 없으면 output == input 이지만 redaction_status=redacted 는
 * "redaction 수행됨 = 열람 안전"을 뜻한다). "패턴 미매칭 ⇒ 증명적으로 깨끗"이라는 거짓 주장(not_required
 * laundering)을 제거한다. 바이너리/비-UTF8 은 throw(terminal). not_required 는 affirmative 면제 신호가
 * 있을 때만 쓰는데 본 변환엔 그런 신호가 없다.
 *
 * 마스킹 대상(security-contracts §4 "redaction 대상"):
 *  - 자격증명: password/passwd/secret/token/otp/authorization/api_key/credential 키값(JSON 정확 경계 또는
 *    키워드→EOL), Bearer 토큰(EOL), Authorization 헤더값 전체(multi-param 스킴 포함 — EOL 까지).
 *  - PII: 이메일, 전화, 카드번호(Luhn 검증으로 오탐 감소), 주민(RRN) 은 self-delimiting PATTERN.
 *    account/acct/passport/iban/ssn/rrn 키는 **키 기반** 마스킹(JSON 정확 경계 또는 키워드→EOL).
 *  - hidden-instruction(§3): security/prompt-injection-patterns.ts 의 INSTRUCTION_OVERRIDE_PATTERNS 재사용
 *    (단일 진실원천) — 매칭 span 마스킹 + 플래그.
 *
 * ┌─ INHERENT LIMIT (honest scope — NOT a completeness proof) ──────────────────────┐
 * │ 패턴/키워드 redaction 은 **민감 KEY 도 인식 가능한 PATTERN 도 없는** 시크릿은 탐지하지 못한다  │
 * │ — 예: 양성(benign) 키 아래 자유서술(free prose) 안에 박힌 고엔트로피 bare 토큰. 그런 경우는    │
 * │ 소유자(owner) DLP/시맨틱 탐지가 필요하다. 또한 키-값 구분자가 흔한 형식(`:`/`=`/탭/다중공백)을  │
 * │ 벗어나거나(파이프/단일공백/컬럼형 TSV 의 cross-line key↔value 등) 키가 다른 줄·열에 있으면      │
 * │ best-effort 로 놓칠 수 있다 — 정합 보장이 필요하면 artifact 를 JSON 으로 산출하거나 owner DLP    │
 * │ 를 ArtifactContentTransform 으로 주입한다. 본 변환은 §4 key/pattern 을 마스킹하고 민감 키엔      │
 * │ 과(過)마스킹하며 owner-extensible 하다. **best-effort §4 마스킹**(완전성 증명 아님)이다.        │
 * └──────────────────────────────────────────────────────────────────────────────────┘
 *
 * 패턴 사전은 **owner-extensible**(§68 site-profile 정책으로 PII 패턴 확장) — 생성자 options 로 주입하며
 * §4 set 이 default. §4 범위 밖의 새 CLASS 를 발명하지 않는다(주입은 기존 class 의 패턴 확장만, append).
 *
 * 보안: 본 변환은 바이트를 반환할 뿐 원본/마스킹 시크릿을 절대 로깅/직렬화하지 않는다.
 */
import { INSTRUCTION_OVERRIDE_PATTERNS } from "../../../security/prompt-injection-patterns";
import type {
  ArtifactContentTransform,
  ArtifactContentTransformMeta,
} from "./s3-artifact-redactor";

/**
 * 변환이 fail-closed 해야 하는 경우(비텍스트/이미지/바이너리/비-UTF8) 던지는 에러. redactor 는 transform
 * throw 를 terminal_failed 로 매핑한다 — 미지원 콘텐츠를 redacted/not_required 로 위장하지 않는다.
 * 메시지는 분류 사유(type/decode)만 — 원본 바이트/내용을 절대 담지 않는다.
 */
export class UnredactableContentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnredactableContentError";
  }
}

/** 마스킹 레이블(§4 class 별). 새 class 발명 금지 — 이 set 이 §4 와 1:1. */
const LABEL = {
  credential: "[REDACTED:credential]",
  hiddenInstruction: "[REDACTED:hidden-instruction]",
  pii: (cls: string): string => `[REDACTED:pii:${cls}]`,
} as const;

/** PII class 식별자(§4 PII 항목). account/passport/iban/ssn 은 key-based 마스킹으로 처리(아래 참조). */
type PiiClass = "email" | "phone" | "card" | "rrn" | "account" | "passport" | "iban" | "ssn";

/** 마스킹 룰: 패턴 + 이를 대체할 마스킹 문자열을 산출하는 함수. self-delimiting PATTERN 마스크에 쓴다. */
interface MaskRule {
  /** 전역(g) 정규식 — 매칭마다 replace. */
  readonly pattern: RegExp;
  /** 매칭을 마스킹 문자열로 치환(매칭 그룹을 받아 value 부분만 가릴 수 있음). */
  readonly replace: (match: string, ...groups: string[]) => string;
}

/**
 * owner 가 §68(site-profile) 정책으로 패턴을 확장할 때 쓰는 options. 모든 필드는 **추가**(append)된다 —
 * §4 default set 을 대체하지 않는다(default 가 항상 적용된 뒤 추가 룰이 더해진다). 새 CLASS 추가가 아니라
 * 기존 §4 class(특히 PII)의 패턴을 사이트별로 늘리는 용도. extraPiiRules 는 self-delimiting PATTERN 마스크
 * (JSON 값 + 비-JSON 줄 양쪽에 적용)로, **토큰 전체를 매칭하는 정규식**이어야 누출이 없다.
 */
export interface ContentRedactionOptions {
  /** 추가 자격증명 PATTERN 룰(예: 사이트별 토큰 형식). 토큰 전체를 매칭해야 한다(self-delimiting). */
  readonly extraCredentialRules?: readonly MaskRule[];
  /** 추가 PII PATTERN 룰(예: 사이트별 사번/주문번호 등 §68 확장). class 라벨은 호출자가 정한다. */
  readonly extraPiiRules?: readonly MaskRule[];
  /** 추가 민감 KEY 토큰(JSON 키 / 키워드→EOL 양쪽에 더해진다). 정규식 fragment(소스 문자열)로 준다. */
  readonly extraSensitiveKeySources?: readonly string[];
  /**
   * 비텍스트로 간주할 meta.type 접두어/식별자(소문자 비교). default 에 더해진다. image/binary 류는
   * 항상 fail-closed.
   */
  readonly extraBinaryTypeMarkers?: readonly string[];
}

/** §4 image/binary 류로 간주할 meta.type 마커(소문자 substring 매칭) — default. */
const DEFAULT_BINARY_TYPE_MARKERS: readonly string[] = [
  "image",
  "png",
  "jpeg",
  "jpg",
  "gif",
  "webp",
  "bmp",
  "tiff",
  "pdf",
  "video",
  "audio",
  "binary",
  "octet-stream",
  "zip",
  "gzip",
  "screenshot",
  "vlm_input",
];

/**
 * 민감 자격증명 KEY fragment(JSON property name / key:value 의 키). 줄 끝까지(EOL) 또는 JSON 값 전체를
 * 마스킹할 때 키 식별에 쓴다. credential 라벨로 처리.
 */
const CREDENTIAL_KEY_SOURCE = String.raw`password|passwd|secret|token|otp|authorization|api[ _-]?key|credential`;

/**
 * 민감 PII KEY fragment. account/acct/passport/iban/ssn/rrn — 약어/스펠링(account no / account number /
 * passport number 등)을 단어 사이 공백·하이픈·언더스코어로 허용한다(under-mask 차단). pii 라벨로 처리.
 */
const PII_KEY_SOURCE = String.raw`account(?:[ _-]*(?:number|no|num|id))?|acct|passport(?:[ _-]*(?:number|no|num))?|iban(?:[ _-]*(?:number|no|num))?|ssn|rrn`;

/**
 * 비-JSON 줄 키워드→EOL 마스킹과 JSON property name 식별에 쓰는 정규식은 owner 확장(extraSensitiveKeySources)
 * 을 append 해야 하므로 인스턴스 생성자에서 조립한다(아래 ContentRedactionTransform 참조).
 */

/** Authorization 헤더값 전체(스킴+자격, multi-param 포함) — EOL 까지. 비-JSON 줄 경로에서만 쓴다. */
const AUTHORIZATION_LINE = /\bAuthorization\s*:\s*\S[^\r\n]*/gi;
/** Bearer <token …> — Bearer 뒤 자격값을 EOL 까지. 비-JSON 줄 경로에서만 쓴다. */
const BEARER_LINE = /\bBearer\s+\S[^\r\n]*/gi;
/** Bearer 토큰(self-delimiting) — JSON 값 안의 Bearer 도 가린다. 토큰 1개만(공백/EOL/구분자 경계). */
const BEARER_TOKEN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/g;

/** key 문자열에서 PII class 라벨 산출(account/passport/iban/ssn). */
function piiKeyLabel(keyName: string): string {
  const k = keyName.toLowerCase();
  if (k.includes("passport")) return LABEL.pii("passport" satisfies PiiClass);
  if (k.includes("iban")) return LABEL.pii("iban" satisfies PiiClass);
  if (k.includes("ssn")) return LABEL.pii("ssn" satisfies PiiClass);
  if (k.includes("rrn")) return LABEL.pii("rrn" satisfies PiiClass);
  return LABEL.pii("account" satisfies PiiClass);
}

/**
 * §4 self-delimiting PATTERN 마스크(JSON 값 + 비-JSON 줄 양쪽에 적용). 각 정규식은 **토큰 전체**를 매칭하므로
 * 부분 누출이 없다 — 이것이 이들을 양쪽 경로에서 안전하게 재사용할 수 있는 이유다. card 는 Luhn 통과분만.
 */
function defaultPatternRules(): MaskRule[] {
  return [
    // Bearer 토큰(self-delimiting) — JSON 값 등 줄 단위 경로 밖에서도 가린다.
    {
      pattern: BEARER_TOKEN,
      replace: () => `Bearer ${LABEL.credential}`,
    },
    // 이메일.
    {
      pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
      replace: () => LABEL.pii("email" satisfies PiiClass),
    },
    // 주민등록번호(RRN): 6자리-7자리. card 보다 먼저(둘 다 digit run 이라 우선순위 명시).
    {
      pattern: /\b\d{6}-\d{7}\b/g,
      replace: () => LABEL.pii("rrn" satisfies PiiClass),
    },
    // 카드번호: 13~19 digit(공백/하이픈 구분 허용). Luhn 통과분만 마스킹(오탐 감소).
    {
      pattern: /\b(?:\d[ -]?){12,18}\d\b/g,
      replace: (m: string) => (isLuhnValid(m) ? LABEL.pii("card" satisfies PiiClass) : m),
    },
    // 전화: 한국/국제 흔한 형태. 경계 lookaround 로 더 긴 digit run(예: 카드) 안의 부분 매칭 배제.
    {
      pattern: /(?<![\d(])(?<!\d[ -])(?:\+?\d{1,3}[ -])?\(?\d{2,4}\)?[ -]\d{3,4}[ -]?\d{4}(?![ -]?\d)/g,
      replace: (m: string) =>
        countDigits(m) >= 9 && countDigits(m) <= 13 ? LABEL.pii("phone" satisfies PiiClass) : m,
    },
  ];
}

/** 문자열 내 숫자 개수. */
function countDigits(s: string): number {
  let n = 0;
  for (const ch of s) if (ch >= "0" && ch <= "9") n += 1;
  return n;
}

/** Luhn 체크섬 검증(카드번호 오탐 감소). 구분자(공백/하이픈) 제거 후 검사. */
function isLuhnValid(raw: string): boolean {
  const digits = raw.replace(/[^\d]/g, "");
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = digits.charCodeAt(i) - 48; // '0' = 48
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}

/**
 * DEFAULT §4-anchored TEXT/JSON content redactor. UTF-8 텍스트만 처리하며 image/binary/비-UTF8 은
 * fail-closed(throw UnredactableContentError → redactor terminal_failed).
 */
export class ContentRedactionTransform implements ArtifactContentTransform {
  private readonly patternRules: readonly MaskRule[];
  private readonly credentialKeyName: RegExp;
  private readonly piiKeyName: RegExp;
  private readonly sensitiveKeyLine: RegExp;
  private readonly binaryMarkers: readonly string[];

  constructor(options: ContentRedactionOptions = {}) {
    // §4 default PATTERN 마스크(self-delimiting)가 항상 먼저, owner 확장(§68)은 그 뒤에 append.
    this.patternRules = [
      ...defaultPatternRules(),
      ...(options.extraCredentialRules ?? []),
      ...(options.extraPiiRules ?? []),
    ];

    // 민감 KEY 식별 — owner 확장 key fragment 를 credential·PII 양쪽 식별과 줄 정규식에 모두 append.
    const extraKeys = options.extraSensitiveKeySources ?? [];
    const extraAlt = extraKeys.length > 0 ? `|${extraKeys.join("|")}` : "";
    this.credentialKeyName = new RegExp(`(?:${CREDENTIAL_KEY_SOURCE}${extraAlt})`, "i");
    this.piiKeyName = new RegExp(`(?:${PII_KEY_SOURCE})`, "i");
    // key 뒤 선택적 닫는 따옴표("/')를 허용해 한 줄짜리 JSON("key":val)이 비-JSON 문서 안에 섞여 있어도
    // 키워드→EOL 마스킹이 걸리게 한다(전체 문서가 JSON 이 아니면 JSON walk 가 안 돌므로 줄 경로의 누출 방지).
    // 키워드를 key 토큰의 substring 으로 매칭(JSON 경로 credentialKeyName/piiKeyName 와 대칭) — access_token,
    // refresh_token, user_password, app_secret, a_token, bank_account_no 처럼 word-char/hyphen/dot 접두·접미가
    // 붙은 §4 키도 잡는다(\b 앵커 비대칭으로 인한 under-mask 누출 차단). key 토큰 전체+구분자를 group1 로 보존하고
    // 값은 EOL 까지 마스킹(over-mask=안전). 양쪽 [\w.-]* 는 줄 안에서만(구분자/공백/콤마 미포함) 키 토큰에 한정.
    // 구분자: `:`/`=` 외에 탭·다중공백(2+)도 인정한다(config/log/TSV 의 흔한 형식). 단일 공백은
    // 과도(자연문)라 제외. 구분자 종류 무관하게 값은 EOL 까지 마스킹(over-mask=안전). exotic 형식
    // (파이프/단일공백/컬럼형 cross-line)·자유서술 내 임베드 시크릿은 best-effort 한계(아래 헤더 주석).
    this.sensitiveKeyLine = new RegExp(
      String.raw`([\w.-]*(?:${CREDENTIAL_KEY_SOURCE}|${PII_KEY_SOURCE}${extraAlt})[\w.-]*["']?(?:\s*[:=]|\t+| {2,}))\s*\S`,
      "i",
    );

    this.binaryMarkers = [
      ...DEFAULT_BINARY_TYPE_MARKERS,
      ...(options.extraBinaryTypeMarkers ?? []).map((m) => m.toLowerCase()),
    ];
  }

  async transform(
    bytes: Uint8Array,
    meta: ArtifactContentTransformMeta,
  ): Promise<{ kind: "redacted"; bytes: Uint8Array }> {
    // (1) meta.type 이 image/binary 류면 즉시 fail-closed(텍스트 변환의 범위 밖). meta.type 은 **추가 힌트**
    //     일 뿐 단독 가드가 아니다(artifacts.type 은 개방형이라 우회 가능) — 콘텐츠 기반 가드가 (2)(3)에서 1차.
    const type = (meta.type ?? "").toLowerCase();
    if (this.binaryMarkers.some((marker) => type.includes(marker))) {
      throw new UnredactableContentError(
        "non-text artifact (image/binary) is not auto-redactable by the text transform — fail closed (§4 image = VLM region masking, a separate capability)",
      );
    }

    // (2) UTF-8 디코드 — 비-UTF8(바이너리)이면 fail-closed. fatal:true 로 잘못된 시퀀스를 throw.
    //     redactor 가 RAW 바이트를 그대로 넘기므로(decode→re-encode round-trip 제거, VULN1) 진짜 binary 는
    //     여기서 throw 된다 — get()(텍스트)의 U+FFFD 치환으로 가드가 무력화되던 경로를 닫는다.
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new UnredactableContentError(
        "artifact content is not valid UTF-8 text — fail closed (binary content is not auto-redactable here)",
      );
    }

    // (3) 콘텐츠 기반 바이너리 탐지(meta.type 독립). fatal 디코드를 통과해도(BOM·U+FFFD 가 원본에 있거나
    //     uncommon 인코딩) 다음이면 binary 로 보고 fail-closed: NUL(0x00), U+FFFD(�), 또는 과도한
    //     C0 control 비율(\t\r\n 제외). 한 글자라도 손상/제어가 섞이면 "마스킹했으니 안전"이라 주장하지 않는다.
    if (looksBinary(text)) {
      throw new UnredactableContentError(
        "artifact content has binary signal (NUL / replacement char / excessive control bytes) — fail closed",
      );
    }

    // (4) §4 마스킹 적용. not_required 미반환 — 유효 텍스트는 항상 redacted(매칭 없으면 output==input).
    //     OVER-MASK 안전 / UNDER-MASK 누출 원칙: JSON 은 정확 경계, 비-JSON 은 키워드→EOL.
    const masked = this.maskContent(text);

    // (4c) hidden-instruction(§3) — INSTRUCTION_OVERRIDE_PATTERNS 재사용(SSoT). 매칭 span 마스킹 + 플래그.
    const finalText = this.maskHiddenInstructions(masked);

    return { kind: "redacted", bytes: new TextEncoder().encode(finalText) };
  }

  /**
   * JSON-aware 경로 우선. 텍스트가 JSON 으로 파싱되면 값을 재귀 walk(정확 경계 마스킹), 실패하면 비-JSON
   * 줄 단위 경로(키워드→EOL + PATTERN 마스크)로 fall back. 둘 다 OVER-MASK-not-UNDER-MASK 를 지킨다.
   */
  private maskContent(text: string): string {
    const trimmed = text.trim();
    // JSON 은 object/array 로 시작하는 경우만 walk(원시 스칼라/문자열만 있는 입력은 줄 경로가 더 보수적).
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined; // 줄 경로로 fall through.
      }
      if (parsed !== undefined) {
        const walked = this.maskJsonValue(parsed, /* keyName */ undefined);
        // 들여쓰기 2 로 재직렬화(원본 포맷은 보존하지 않음 — 마스킹 산출물이라 무방, 누출 0이 우선).
        return JSON.stringify(walked, null, 2);
      }
    }
    return this.maskLines(text);
  }

  /**
   * JSON 값 재귀 walk. KEY(부모 property name)가 민감 키면 **값 전체**를 라벨로 치환(정확 경계, 누출 0).
   * 그 외 string 값엔 self-delimiting PATTERN 마스크 적용. 숫자/불리언도 민감 키면 라벨 문자열로 치환.
   */
  private maskJsonValue(value: unknown, keyName: string | undefined): unknown {
    // 민감 KEY(부모 property)면 **값 전체**(스칼라/객체/배열 무관)를 라벨로 치환 — 객체/배열로 내려가기 **전에** 검사한다.
    //   (RED-01) 종전엔 이 검사가 스칼라 leaf 에서만 실행돼, {"credential":{"value":"비밀"}} 처럼 민감 키 값이 객체/
    //   array-of-objects 면 내부의 비-민감 키(value)로 walk 내려가 패턴 미매칭 비밀이 그대로 누출됐다(under-mask).
    if (keyName !== undefined) {
      if (this.credentialKeyName.test(keyName)) return LABEL.credential;
      if (this.piiKeyName.test(keyName)) return piiKeyLabel(keyName);
    }
    if (Array.isArray(value)) {
      // 비민감 키 배열: 원소는 부모 키를 상속(원소 내부의 중첩 민감 키/패턴은 원소 walk 에서 처리).
      return value.map((el) => this.maskJsonValue(el, keyName));
    }
    if (value !== null && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = this.maskJsonValue(v, k);
      }
      return out;
    }
    // 스칼라(string/number/boolean/null) — 비민감 키.
    if (typeof value === "string") {
      return this.applyPatternRules(value);
    }
    return value; // number/boolean/null 은 비민감 키면 그대로(패턴 마스크는 문자열에만).
  }

  /**
   * 비-JSON 줄 경로. 줄 단위로: (a) 민감 KEY 토큰 뒤 `:`/`=` 가 오면 그 줄을 **구분자 끝부터 EOL 까지**
   * 라벨로 마스킹(꼬리 누출 0 — delimiter-bounded 부분 마스킹을 대체). (b) Authorization/Bearer EOL.
   * (c) self-delimiting PATTERN 마스크. 줄 안에 여러 신호가 있어도 보수적으로 처리한다.
   *
   * HEADER LINE-FOLDING(best-effort): RFC 822/HTTP 헤더는 다음 줄이 공백(SP/TAB)으로 시작하면 **접힌(folded)
   * 연속 값**이다. 직전 줄이 민감 헤더(Authorization/sensitive key)로 EOL 마스킹됐고 현재 줄이 공백으로 시작하면
   * 연속 줄도 EOL 마스킹한다(꼬리 누출 차단). 양성 들여쓰기 본문을 과마스킹할 수 있으나 OVER-MASK 안전 원칙을
   * 따른다. (free prose 안의 임의 위치 시크릿은 탐지 불가 — 헤더 인접 folding 한정 보수적 처리.)
   */
  private maskLines(text: string): string {
    const lines = text.split(/(\r?\n)/); // 캡처 그룹으로 개행을 보존(홀수 인덱스가 개행).
    let prevWasSensitiveHeader = false;
    for (let i = 0; i < lines.length; i += 2) {
      const raw = lines[i];
      // 직전이 민감 헤더였고 현재 줄이 공백(SP/TAB)으로 시작하는 비-빈 줄 → folded 연속값으로 보고 EOL 마스킹.
      if (prevWasSensitiveHeader && /^[ \t]+\S/.test(raw)) {
        const indent = raw.slice(0, raw.length - raw.trimStart().length);
        lines[i] = `${indent}${LABEL.credential}`;
        // prevWasSensitiveHeader 유지 — 다중 folded 줄(연속 접힘)도 모두 마스킹.
        continue;
      }
      const result = this.maskOneLine(raw);
      lines[i] = result.text;
      prevWasSensitiveHeader = result.maskedSensitiveHeader;
    }
    return lines.join("");
  }

  /**
   * 한 줄(개행 제외)에 대한 마스킹. KEY→EOL 이 가장 강하므로 먼저 시도, 아니면 PATTERN 마스크.
   * maskedSensitiveHeader: 이 줄이 Authorization/민감 KEY 헤더로 EOL 마스킹됐는지(folding 판정용).
   */
  private maskOneLine(line: string): { text: string; maskedSensitiveHeader: boolean } {
    // (a) 민감 KEY 토큰 뒤 `:`/`=` → 그 줄의 구분자 끝부터 EOL 까지 라벨로 마스킹(과마스킹, 누출 0).
    const keyMatch = this.sensitiveKeyLine.exec(line);
    if (keyMatch !== null) {
      const keyPart = keyMatch[1]; // key + 구분자(`:`/`=`)까지.
      const keyStart = keyMatch.index;
      const before = line.slice(0, keyStart);
      const keyName = keyPart;
      const label = this.credentialKeyName.test(keyName)
        ? LABEL.credential
        : piiKeyLabel(keyName);
      // 구분자 뒤(값) 전부를 라벨로 — EOL 까지. before(키 앞 텍스트)는 PATTERN 마스크도 한 번 적용.
      return {
        text: `${this.applyLineHeaderRules(before)}${keyPart} ${label}`,
        maskedSensitiveHeader: true,
      };
    }
    // (b) Authorization / Bearer 헤더값 → EOL. (global regex 의 lastIndex 누수 방지 위해 test 전 reset.)
    AUTHORIZATION_LINE.lastIndex = 0;
    const hadAuthHeader = AUTHORIZATION_LINE.test(line) || /\bBearer\s+\S/i.test(line);
    AUTHORIZATION_LINE.lastIndex = 0;
    let out = line.replace(AUTHORIZATION_LINE, `Authorization: ${LABEL.credential}`);
    out = out.replace(BEARER_LINE, `Bearer ${LABEL.credential}`);
    // (c) self-delimiting PATTERN 마스크.
    return { text: this.applyPatternRules(out), maskedSensitiveHeader: hadAuthHeader };
  }

  /** 키 앞 텍스트(before)에 대한 보수적 마스크 — Authorization/Bearer/PATTERN(꼬리 누출 없음). */
  private applyLineHeaderRules(before: string): string {
    let out = before.replace(AUTHORIZATION_LINE, `Authorization: ${LABEL.credential}`);
    out = out.replace(BEARER_LINE, `Bearer ${LABEL.credential}`);
    return this.applyPatternRules(out);
  }

  /** self-delimiting PATTERN 마스크(이메일/카드/RRN/전화/Bearer + owner 확장) 적용. */
  private applyPatternRules(s: string): string {
    let out = s;
    for (const rule of this.patternRules) {
      // 전역 정규식의 lastIndex 누수를 막기 위해 매 호출 reset(공유 정규식 객체이므로).
      rule.pattern.lastIndex = 0;
      out = out.replace(rule.pattern, (m, ...g) =>
        rule.replace(m, ...(g.slice(0, -2) as string[])),
      );
    }
    return out;
  }

  /** hidden-instruction(§3) span 마스킹 — INSTRUCTION_OVERRIDE_PATTERNS(SSoT) 재사용. */
  private maskHiddenInstructions(text: string): string {
    let out = text;
    for (const pattern of INSTRUCTION_OVERRIDE_PATTERNS) {
      // 공유 패턴은 비-global 이므로 global flag 를 부여한 복사본으로 전체 치환.
      const global = new RegExp(
        pattern.source,
        pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`,
      );
      out = out.replace(global, (m) => (m.length === 0 ? m : LABEL.hiddenInstruction)); // zero-width 보호.
    }
    return out;
  }
}

/**
 * 콘텐츠 기반 바이너리 신호 탐지(meta.type 독립). fatal UTF-8 디코드를 통과한 텍스트에도 적용한다 —
 * NUL/U+FFFD 한 글자, 또는 과도한 C0 control 비율(\t\r\n 제외)이면 binary 로 본다. 빈 문자열은 binary 아님.
 */
function looksBinary(text: string): boolean {
  if (text.length === 0) return false;
  let control = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code === 0x00 || code === 0xfffd) return true; // NUL 또는 replacement char → binary.
    // C0 control(0x00–0x1F) 중 흔한 공백(\t=9, \n=10, \r=13)만 허용; 그 외는 control 로 카운트.
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) control += 1;
    else if (code === 0x7f) control += 1; // DEL.
  }
  // C0 control 이 1% 초과면 binary 로 본다(텍스트엔 사실상 없어야 함). 최소 1자라도 짧은 입력 과민 방지 위해 비율.
  return control / text.length > 0.01;
}
