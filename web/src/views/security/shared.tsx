// Security 패널 공유 — ReadinessMetric 은 RBAC/SecretRef감사/AuthReadiness 3개 패널이 공유한다.
export type MetricTone = "green" | "amber" | "blue" | "red";

export function ReadinessMetric({ label, value, tone }: { label: string; value: string; tone: MetricTone }): JSX.Element {
  return (
    <div className="metric-card">
      <span className="label">{label}</span>
      <strong>{value}</strong>
      <span className={`badge ${tone}`}>{tone === "green" ? "정상" : tone === "red" ? "확인 필요" : tone === "amber" ? "보강" : "정보"}</span>
    </div>
  );
}
