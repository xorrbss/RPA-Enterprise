import "@testing-library/jest-dom/vitest";
import * as axeMatchers from "vitest-axe/matchers";
import { configure } from "@testing-library/react";
import { expect } from "vitest";

expect.extend(axeMatchers);

// findBy* 비동기 대기 한도 상향(기본 1000ms → 15000ms). 이 스위트는 App 전체를 마운트하고 폴링 쿼리(refetchInterval)를
// 여러 개 띄우므로, 파일-병렬 실행 + CPU 경합 시 기본 1초로는 요소 등장 전에 간헐 타임아웃(부하성 flaky)이 났다.
// 동작은 불변 — 빠른 통과는 그대로이고 느린 경합 케이스의 최대 대기만 늘려 결정적 green을 만든다.
configure({ asyncUtilTimeout: 15000 });

// jsdom 문서에 lang 부여(index.html의 lang="ko"와 동치) — axe html-has-lang 정합.
document.documentElement.lang = "ko";

// axe-core가 아이콘 ligature/contrast 판정 중 canvas와 pseudo-element style을 조회한다. jsdom은 두 경로를
// 완전히 구현하지 않으므로 a11y 테스트마다 "Not implemented" 경고가 stderr에 찍힌다.
Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
  configurable: true,
  value: function getContext(this: HTMLCanvasElement, contextId: string): CanvasRenderingContext2D | null {
    if (contextId !== "2d") return null;
    return {
      canvas: this,
      fillText: () => undefined,
      measureText: () => ({ width: 0 }),
    } as unknown as CanvasRenderingContext2D;
  } as HTMLCanvasElement["getContext"],
});

const getComputedStyleWithoutPseudo = window.getComputedStyle.bind(window);
Object.defineProperty(window, "getComputedStyle", {
  configurable: true,
  value: ((element: Element) => getComputedStyleWithoutPseudo(element)) as typeof window.getComputedStyle,
});
