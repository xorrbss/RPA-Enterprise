// reads.ts 도메인 분해 — 도메인 모듈 간 공유 leaf 심볼(동작 무변경).
// UUID_RE 정본은 server-shared(R2-5 단일화) — reads-* 계열 기존 표면 보존을 위한 재수출.
export { UUID_RE } from "./server-shared";
