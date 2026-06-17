import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useApiClient } from "../api/context";
import { useCan } from "../api/permissions";
import { ApiError, type ApiErrorBody, type CreateRunBody, type ScenarioItem } from "../api/types";
import { extractUrlRefKeys, extractParamDefaults, urlRefLabel } from "../api/scenario-params";
import { errorLabel } from "./badges";
import { navigate } from "../router";

// 자동화 실행 버튼 + 파라미터 입력 패널.
// 파라미터 시나리오(navigate.url_ref 가 params 키)는 실행 전 값(URL)을 받아야 한다(런타임 v2.11). 실행 시 getScenario로
// IR을 받아 필요한 키를 도출하고, 키별 입력을 채워 createRun(params). 키가 없으면 추가 입력 없이 실행.
// 조용한 실패 금지: ApiError 는 **패널 안**에 표면화(닫힌 패널 뒤 배지로 가려 '무반응'처럼 보이던 문제 해소).
// 다정책+기본없음 테넌트는 createRun 이 model_required(422) → 모델명 입력 폼을 노출해 재실행(임의선택 금지, Gateway 뷰 동형).
// RBAC: run.create 미보유 시 숨김(백엔드가 최종 강제).

// createRun 의 model_required(다정책+기본없음 → 임의선택 불가) 판별. error-catalog 본문 details.reason 으로 식별.
function modelRequiredOf(body: ApiErrorBody | null): { available: number } | null {
  const details = body?.details;
  if (details === undefined || details.reason !== "model_required") return null;
  const available = typeof details.available === "number" ? details.available : 0;
  return { available };
}

export function RunScenarioButton({ scenario }: { scenario: ScenarioItem }): JSX.Element | null {
  const api = useApiClient();
  const can = useCan();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [model, setModel] = useState("");
  const [msg, setMsg] = useState<{ tone: "green" | "red"; text: string } | null>(null);
  // null=모델 불필요(기본/단일정책 자동해소). non-null=createRun 이 model_required 로 거부 → 모델명 입력 필요.
  const [modelRequired, setModelRequired] = useState<{ available: number } | null>(null);
  // 모델명 직타 검증(P0-3) — '확인'을 누른 모델 문자열. getGatewayPolicy 로 실제 존재하는 정책인지 확인한 뒤에만 실행 허용.
  const [checkedModel, setCheckedModel] = useState("");
  const policyCheck = useQuery({
    queryKey: ["run-model-check", checkedModel],
    queryFn: () => api.getGatewayPolicy(checkedModel),
    enabled: modelRequired !== null && checkedModel.length > 0,
    retry: false,
  });
  // 확인된 모델이 현재 입력과 일치하고 정책 조회가 성공해야 확정(입력을 수정하면 재확인 필요 — 맹목 직타 차단).
  const modelConfirmed = checkedModel.length > 0 && checkedModel === model.trim() && policyCheck.isSuccess;

  const detail = useQuery({
    queryKey: ["scenario-detail", scenario.scenario_id],
    queryFn: () => api.getScenario(scenario.scenario_id),
    enabled: open,
  });
  const keys = extractUrlRefKeys(detail.data?.ir);
  // params_schema default(쉬운 만들기가 실은 입력 URL)로 prefill. 사용자가 입력하면 values 가 우선.
  const defaults = extractParamDefaults(detail.data?.ir);
  const valueFor = (k: string): string => values[k] ?? defaults[k] ?? "";
  const missing = keys.filter((k) => valueFor(k).trim().length === 0);
  // model_required 거부 후엔 모델명을 입력·확인(getGatewayPolicy)하기 전까지 실행 차단(맹목 직타 가드).
  const needModel = modelRequired !== null && !modelConfirmed;

  const run = useMutation({
    mutationFn: () => {
      const params = Object.fromEntries(keys.map((k) => [k, valueFor(k).trim()]));
      const base: CreateRunBody = { scenario_version_id: scenario.latest_version_id, params };
      const m = model.trim();
      return api.createRun(m.length > 0 ? { ...base, model: m } : base, crypto.randomUUID());
    },
    onSuccess: (result) => {
      setMsg(null);
      setOpen(false);
      setValues({});
      setModel("");
      setModelRequired(null);
      setCheckedModel("");
      void qc.invalidateQueries({ queryKey: ["runs"] });
      // 시작 → 관찰 직행(P0-1): 방금 만든 run 의 라이브 트레이스로 즉시 이동(수동 '실행 기록 보기'·UUID 복붙 제거).
      navigate("runTrace", { run: result.run_id });
    },
    onError: (e) => {
      // model_required → 모델명 입력 노출(임의선택 금지). 그 외 에러는 코드 표면화. 둘 다 패널 안에 표시.
      const mr = e instanceof ApiError && e.code === "IR_SCHEMA_INVALID" ? modelRequiredOf(e.body) : null;
      if (mr !== null) {
        setModelRequired(mr);
        setMsg({ tone: "red", text: `AI 모델을 지정해야 합니다 (정책 ${mr.available}개, 기본 미지정). 모델명 입력 후 다시 실행하세요.` });
      } else {
        setMsg({ tone: "red", text: errorLabel(e) });
      }
    },
  });

  if (!can("run.create")) return null;

  return (
    <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
      <button className="btn" type="button" onClick={() => { setMsg(null); setOpen((v) => !v); }} disabled={run.isPending}>
        실행
      </button>
      {/* 패널 닫힌 뒤(성공) 보이는 배지. 에러 시엔 패널이 열린 채라 아래(패널 안)에서 표시한다. */}
      {msg !== null && !open && <span className={`badge ${msg.tone}`}>{msg.text}</span>}

      {open && (
        <section
          className="panel"
          aria-label={`${scenario.name} 실행`}
          style={{ position: "absolute", zIndex: 20, marginTop: 4, padding: 12, minWidth: 320, maxWidth: 460 }}
        >
          <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <strong>{scenario.name} 실행</strong>
            <button className="btn" type="button" onClick={() => setOpen(false)} disabled={run.isPending}>
              닫기
            </button>
          </header>

          {detail.isLoading ? (
            <p className="subtle" role="status" style={{ margin: 0 }}>실행 정보를 불러오는 중…</p>
          ) : detail.isError ? (
            <p className="badge red" role="alert" style={{ display: "block", margin: 0 }}>시나리오를 불러오지 못했습니다.</p>
          ) : (
            <>
              <p className="subtle" style={{ margin: "0 0 8px" }}>
                {keys.length > 0
                  ? "이 자동화는 실행에 아래 값이 필요합니다. 입력 후 실행하세요."
                  : "추가 입력 없이 최신 버전으로 실행합니다."}
              </p>
              {keys.map((k) => (
                <label key={k} style={{ display: "block", marginBottom: 8 }}>
                  {/* raw url_ref 키 대신 운영자용 한국어 라벨(P0-3). 미매핑 키는 원본 폴백(조용한 공백 금지). */}
                  <span style={{ display: "block", fontSize: 13, marginBottom: 2 }}>{urlRefLabel(k)}</span>
                  <input
                    type="text"
                    value={valueFor(k)}
                    onChange={(e) => setValues((prev) => ({ ...prev, [k]: e.target.value }))}
                    placeholder="https://… (실행 대상 URL)"
                    aria-label={urlRefLabel(k)}
                    style={{ width: "100%", fontFamily: "monospace", fontSize: 13, padding: 8, boxSizing: "border-box" }}
                  />
                </label>
              ))}
              {modelRequired !== null && (
                <label style={{ display: "block", marginBottom: 8 }}>
                  <span style={{ display: "block", fontSize: 13, marginBottom: 2 }}>AI 모델 (gateway_policies.model)</span>
                  <span style={{ display: "flex", gap: 6 }}>
                    <input
                      type="text"
                      value={model}
                      onChange={(e) => setModel(e.target.value)}
                      placeholder="예: gpt-4o-mini"
                      aria-label="AI 모델"
                      style={{ flex: 1, fontFamily: "monospace", fontSize: 13, padding: 8, boxSizing: "border-box" }}
                    />
                    {/* 직타 모델을 getGatewayPolicy 로 검증(P0-3) — 실제 정책 존재 확인 후에만 실행 허용(맹목 입력 제거). */}
                    <button className="btn" type="button" onClick={() => setCheckedModel(model.trim())} disabled={model.trim().length === 0 || policyCheck.isFetching}>
                      확인
                    </button>
                  </span>
                  {checkedModel.length > 0 && checkedModel === model.trim() && (
                    <span className="subtle" role="status" style={{ display: "block", marginTop: 4, fontSize: 12 }}>
                      {policyCheck.isFetching
                        ? "모델 정책 확인 중…"
                        : modelConfirmed
                          ? `확인됨 — 정책 ‘${policyCheck.data?.model ?? checkedModel}’ 사용`
                          : policyCheck.isError
                            ? `‘${checkedModel}’ 정책을 찾을 수 없습니다. 모델명을 확인하세요.`
                            : ""}
                    </span>
                  )}
                </label>
              )}
              {msg !== null && (
                <p className={`badge ${msg.tone}`} role="alert" style={{ display: "block", margin: "0 0 8px", whiteSpace: "normal" }}>
                  {msg.text}
                </p>
              )}
              <button
                className="btn"
                type="button"
                onClick={() => run.mutate()}
                disabled={run.isPending || missing.length > 0 || needModel}
              >
                {run.isPending ? "등록 중…" : "실행 시작"}
              </button>
              {(missing.length > 0 || needModel) && (
                <span className="subtle" style={{ marginLeft: 8, fontSize: 12 }}>필요한 값을 모두 입력하세요.</span>
              )}
            </>
          )}
        </section>
      )}
    </span>
  );
}
