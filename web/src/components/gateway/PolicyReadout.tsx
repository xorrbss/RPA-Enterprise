import type { GatewayPolicy } from "../../api/types";

// 예산/한도 수치에 단위를 붙여 운영자에게 의미를 명확히 한다(계약: 토큰 한도=tokens, maxCost=USD).
// 미설정 값엔 단위를 붙이지 않는다("미지정") — 없는 값을 0이나 단위로 위장하지 않는다(조용한 false 금지).
function numberSetting(
  record: Record<string, unknown> | undefined,
  key: string,
  unit: "토큰" | "USD",
): string {
  const value = record?.[key];
  if (typeof value !== "number" || !Number.isFinite(value)) return "미지정";
  return unit === "USD" ? `$${value} USD` : `${value.toLocaleString("ko-KR")} 토큰`;
}

function booleanSetting(
  record: Record<string, unknown> | undefined,
  key: string,
): string {
  return record?.[key] === true ? "지원" : "미지원";
}

function policyJson(value: unknown): string {
  return JSON.stringify(value ?? {}, null, 2);
}

export function PolicyReadout({
  policy,
}: {
  policy: GatewayPolicy;
}): JSX.Element {
  return (
    <dl className="metrics" style={{ margin: 0 }}>
      <div className="metric">
        <div className="label">AI 모델</div>
        <div className="value" style={{ fontSize: 18 }}>
          {policy.model}
        </div>
      </div>
      <div className="metric">
        <div className="label">상태</div>
        <div className="value" style={{ fontSize: 18 }}>
          {policy.is_default ? "기본 정책" : "일반 정책"}
        </div>
      </div>
      <div className="metric">
        <div className="label">컨텍스트 한도</div>
        <div className="value" style={{ fontSize: 18 }}>
          {numberSetting(policy.capabilities, "maxContextTokens", "토큰")}
        </div>
      </div>
      <div className="metric">
        <div className="label">지원 기능</div>
        <div style={{ display: "grid", gap: 6, marginTop: 6 }}>
          <span className="badge blue">
            구조화 응답 {booleanSetting(policy.capabilities, "jsonMode")}
          </span>
          <span className="badge blue">
            화면 이미지 입력 {booleanSetting(policy.capabilities, "vision")}
          </span>
        </div>
      </div>
      <div className="metric">
        <div className="label">사용량 한도</div>
        <div style={{ display: "grid", gap: 4, marginTop: 6 }}>
          <span>입력 {numberSetting(policy.budget, "maxInputTokens", "토큰")}</span>
          <span>출력 {numberSetting(policy.budget, "maxOutputTokens", "토큰")}</span>
        </div>
      </div>
      <div className="metric">
        <div className="label">비용 한도 (실행당)</div>
        <div className="value" style={{ fontSize: 18 }}>
          {numberSetting(policy.budget, "maxCost", "USD")}
        </div>
      </div>
      <div className="metric">
        <div className="label">상세 설정</div>
        <details className="developer-details">
          <summary>상세 설정 원문 보기</summary>
          <pre style={{ marginTop: 8, fontSize: 12 }}>
            {policyJson({
              capabilities: policy.capabilities ?? {},
              budget: policy.budget ?? {},
            })}
          </pre>
        </details>
      </div>
      <div className="metric">
        <div className="label">데이터 반출 경계</div>
        <p className="subtle" style={{ margin: "6px 0 0" }}>
          {/* T4: 내부 하드닝 스트림 참조("S11")·영문 용어를 운영자 문장으로 재작성(감사 P2). */}
          Gateway 전송 전 마스킹 경계를 적용합니다. 시크릿 값은 AI 모델로 보내지 않고 별도 주입 경로를 사용합니다. 실행별 마스킹 증빙은 실행 기록의 증빙 목록에서 확인합니다.
        </p>
      </div>
    </dl>
  );
}
