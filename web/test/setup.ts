import "@testing-library/jest-dom/vitest";
import * as axeMatchers from "vitest-axe/matchers";
import { expect } from "vitest";

expect.extend(axeMatchers);

// jsdom 문서에 lang 부여(index.html의 lang="ko"와 동치) — axe html-has-lang 정합.
document.documentElement.lang = "ko";
