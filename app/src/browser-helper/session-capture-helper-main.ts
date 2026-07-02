/**
 * 단일 실행파일(Node SEA) 전용 엔트리 — 무조건 CLI 기동.
 *
 * 왜 별도 파일인가: session-capture-helper 의 run-as-main 가드는 import.meta.url 기반인데, SEA 는 CJS
 * 번들만 받으므로(esbuild cjs 출력에서 import.meta.url 이 비어) 가드가 항상 false 가 된다. tsx 직접 실행
 * 경로는 기존 가드가 담당하고, 본 엔트리는 scripts/build-session-capture-exe.mjs 번들 전용이다.
 */
import { runCliMain } from "./session-capture-helper";

runCliMain();
