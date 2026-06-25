export interface SparklinePoint {
  readonly value: number | null;
  readonly label: string;
}

const PAD = 3;

// 경량 인라인 SVG 스파크라인(외부 라이브러리 없음). null 값은 선을 끊는다 — 데이터 없는 구간을 0으로 단정하지 않는다
// ("조용한 false 금지"). 모든 non-null 점은 dot 으로 표시해 고립된 데이터 날도 보이게 한다(선이 없다고 숨기지 않음).
// 접근성: role="img" + aria-label 요약. 값은 domainMax(미지정 시 표본 최댓값)로 normalize.
export function Sparkline({
  points,
  ariaLabel,
  domainMax,
  width = 132,
  height = 30,
}: {
  points: readonly SparklinePoint[];
  ariaLabel: string;
  domainMax?: number;
  width?: number;
  height?: number;
}): JSX.Element {
  const numeric = points.map((p) => p.value).filter((v): v is number => v !== null);
  const max = domainMax ?? (numeric.length > 0 ? Math.max(...numeric) : 0);
  const innerW = width - PAD * 2;
  const innerH = height - PAD * 2;
  const n = points.length;
  const xAt = (i: number): number => (n <= 1 ? width / 2 : PAD + (i / (n - 1)) * innerW);
  const yAt = (v: number): number =>
    max <= 0 ? height - PAD : PAD + innerH - (Math.max(0, Math.min(v, max)) / max) * innerH;

  // 연속 non-null 구간을 모은다. 2점 이상인 구간만 선(path)으로 잇고, 모든 non-null 점은 dot 으로 찍는다.
  const linePaths: string[] = [];
  const dots: { readonly x: number; readonly y: number }[] = [];
  let run: { i: number; v: number }[] = [];
  const flush = (): void => {
    if (run.length >= 2) {
      linePaths.push(run.map((p, k) => `${k === 0 ? "M" : "L"} ${xAt(p.i).toFixed(1)} ${yAt(p.v).toFixed(1)}`).join(" "));
    }
    run = [];
  };
  points.forEach((p, i) => {
    if (p.value === null) {
      flush();
      return;
    }
    run.push({ i, v: p.value });
    dots.push({ x: xAt(i), y: yAt(p.value) });
  });
  flush();

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={ariaLabel}
      style={{ display: "block", color: "var(--accent, #2563eb)", overflow: "visible" }}
    >
      {dots.length === 0 && (
        <line
          x1={PAD}
          y1={height - PAD}
          x2={width - PAD}
          y2={height - PAD}
          stroke="currentColor"
          strokeWidth={1}
          opacity={0.25}
          strokeDasharray="2 2"
        />
      )}
      {linePaths.map((d, i) => (
        <path
          key={i}
          d={d}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          strokeLinejoin="round"
          strokeLinecap="round"
          opacity={0.85}
        />
      ))}
      {dots.map((dot, i) => (
        <circle
          key={i}
          cx={dot.x}
          cy={dot.y}
          r={i === dots.length - 1 ? 2.4 : 1.4}
          fill="currentColor"
          opacity={i === dots.length - 1 ? 1 : 0.7}
        />
      ))}
    </svg>
  );
}
