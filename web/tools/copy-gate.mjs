// copy-gate — 사용자 노출 문자열의 내부 용어 누출을 막는 정적 게이트 (T4, UI/UX 감사 P2 해소).
//
// 검사 대상: web/src/**/*.{ts,tsx}의 (a) 한국어가 포함된 문자열 리터럴, (b) 한국어가 포함된 JSX 텍스트.
// 위반: raw enum(SNAKE_CASE), 금지 영단어(redacted/handoff/metadata-only/fallback), 내부 스트림 참조(S4~S12).
//
// 원칙:
// - 코드 식별자·주석·영문 전용 리터럴은 검사하지 않는다(기술 식별자는 화면 문자열이 아님).
// - 템플릿 리터럴의 ${...} 보간은 코드이므로 제거 후 검사한다(라벨 지도 조회는 정당한 패턴).
// - 정당한 예외(계약 점검 문서 화면의 에러 코드, 운영자 CLI 안내의 환경변수명)는 allowlist로 명시한다 —
//   기술 상세의 정직 노출(문제 은폐 금지)은 허용하되, 항목이 늘면 리뷰에서 근거를 물을 수 있게 파일로 관리.
//
// 실행: npm --prefix web run lint:copy (CI: Operations console 게이트에 포함)
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const SRC = join(ROOT, "..", "src");
const ALLOW_PATH = join(ROOT, "copy-gate.allow.json");

const FORBIDDEN = [
  { name: "raw-enum", re: /\b[A-Z]{2,}(?:_[A-Z0-9]+)+\b/, hint: "상태/에러 코드는 badges.tsx 라벨 지도를 거쳐 한국어로 표시하세요." },
  { name: "redacted", re: /\bredacted\b/i, hint: '"마스킹 처리된"으로 표기하세요.' },
  { name: "handoff", re: /\bhandoff\b/i, hint: '"이관"으로 표기하세요.' },
  { name: "metadata-only", re: /\bmetadata-only\b/i, hint: '"메타데이터 전용"으로 표기하세요.' },
  { name: "fallback", re: /\bfallback\b/i, hint: '"대체 모델/대체 경로"로 표기하세요.' },
  // 내부 하드닝 스트림 참조(S4~S12). S1~S3은 S3(오브젝트 스토리지) 등 외부 고유명과 충돌해 제외.
  { name: "internal-stream-ref", re: /\bS(?:[4-9]|1[0-2])\b/, hint: "내부 작업 스트림 번호는 UI 카피에 노출하지 않습니다." },
];

const LITERAL_RE = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g;
const HANGUL_RE = /[가-힣]/;

const allow = existsSync(ALLOW_PATH)
  ? JSON.parse(readFileSync(ALLOW_PATH, "utf8"))
  : { files: [], terms: [] };
const allowedFiles = new Set((allow.files ?? []).map((f) => f.replace(/\\/g, "/")));
const allowedTerms = (allow.terms ?? []).map((t) => new RegExp(`\\b${t}\\b`));

function stripAllowedTerms(text) {
  let out = text;
  for (const re of allowedTerms) out = out.replace(new RegExp(re.source, "g"), " ");
  return out;
}

const violations = [];

function check(file, lineNo, kind, text) {
  const scrubbed = stripAllowedTerms(text);
  if (!HANGUL_RE.test(scrubbed)) return;
  for (const f of FORBIDDEN) {
    const m = scrubbed.match(f.re);
    if (m !== null) {
      violations.push(`${file}:${lineNo} [${f.name}] "${m[0]}" — ${f.hint}\n    ${text.trim().slice(0, 100)}`);
    }
  }
}

function scan(filePath, relPath) {
  const lines = readFileSync(filePath, "utf8").split("\n");
  lines.forEach((line, i) => {
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return;
    // (a) 문자열 리터럴 — 템플릿 보간(${...})은 코드이므로 제거.
    for (const m of line.matchAll(LITERAL_RE)) {
      const lit = (m[1] ?? m[2] ?? m[3] ?? "").replace(/\$\{[^}]*\}/g, " ");
      check(relPath, i + 1, "literal", lit);
    }
    // (b) JSX 텍스트 — 리터럴·태그·{표현식}·트레일링 주석(한국어 코드 주석 오탐 방지)을 걷어낸 잔여 텍스트.
    //     리터럴을 먼저 공백화했으므로 남은 `//`는 주석이다(URL의 `//`는 `x://` 형태라 공백 선행 조건에 안 걸림).
    const jsxText = line
      .replace(LITERAL_RE, " ")
      .replace(/(^|\s)\/\/.*$/, " ")
      .replace(/\{[^{}]*\}/g, " ")
      .replace(/<[^<>]*>/g, " ");
    check(relPath, i + 1, "jsx", jsxText);
  });
}

function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p);
    else if (/\.(ts|tsx)$/.test(entry.name)) {
      const rel = relative(SRC, p).replace(/\\/g, "/");
      if (allowedFiles.has(rel)) continue;
      scan(p, rel);
    }
  }
}

walk(SRC);

if (violations.length > 0) {
  console.error(`copy-gate FAIL: 사용자 노출 문자열에서 내부 용어 ${violations.length}건 검출\n`);
  for (const v of violations) console.error(`  ${v}\n`);
  console.error("정당한 기술 상세 노출이면 web/tools/copy-gate.allow.json에 근거와 함께 추가하세요.");
  process.exit(1);
}
console.log("copy-gate PASS: 사용자 노출 문자열에 내부 용어 누출 없음");
