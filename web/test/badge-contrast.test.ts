import { readFileSync } from "node:fs";

import { describe, expect, test } from "vitest";

// styles.css 를 SSoT로 읽어 배지 토큰의 색대비를 검사한다. 누가 토큰을 다시 밝게 바꾸면 이 테스트가 회귀 차단.
// (axe color-contrast 규칙은 jsdom 한계로 a11y.test.tsx에서 비활성 — 그 공백을 토큰 단위로 메운다.)
// 경로는 vitest cwd(web 패키지 루트) 기준 상대 — node:fs는 jsdom env에서도 동작.
const css = readFileSync("src/styles.css", "utf8");

function cssVar(name: string): string {
  const m = css.match(new RegExp(`--${name}\\s*:\\s*(#[0-9a-fA-F]{6})`));
  if (m === null || m[1] === undefined) throw new Error(`styles.css 에 --${name} (#RRGGBB) 없음`);
  return m[1];
}

function luminance(hex: string): number {
  const chan = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((s) => (s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)));
  return 0.2126 * (chan[0] ?? 0) + 0.7152 * (chan[1] ?? 0) + 0.0722 * (chan[2] ?? 0);
}

function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

// .badge.<tone> 의 [텍스트색 var, 배경색 var] (styles.css 의 .badge.* 규칙과 일치해야 함)
const TONES: ReadonlyArray<readonly [string, string, string]> = [
  ["green", "green-ink", "green-soft"],
  ["amber", "amber-ink", "amber-soft"],
  ["red", "red-ink", "red-soft"],
  ["blue", "blue-ink", "blue-soft"],
  ["muted", "muted", "soft"],
];

describe("배지 색대비 (WCAG 2.1 AA — normal text 4.5:1)", () => {
  for (const [tone, fg, bg] of TONES) {
    test(`badge.${tone} 텍스트/배경 ≥ 4.5:1`, () => {
      expect(contrast(cssVar(fg), cssVar(bg))).toBeGreaterThanOrEqual(4.5);
    });
  }
});
