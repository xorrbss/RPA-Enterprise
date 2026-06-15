import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useApiClient } from "../api/context";
import { useCan } from "../api/permissions";
import { ApiError, type ScenarioItem } from "../api/types";
import { extractUrlRefKeys } from "../api/scenario-params";

// 자동화 실행 버튼 + 파라미터 입력 패널.
// 파라미터 시나리오(navigate.url_ref 가 params 키)는 실행 전 값(URL)을 받아야 한다(런타임 v2.11). 실행 시 getScenario로
// IR을 받아 필요한 키를 도출하고, 키별 입력을 채워 createRun(params). 키가 없으면 추가 입력 없이 실행.
// 조용한 실패 금지: ApiError 코드 표면화. RBAC: run.create 미보유 시 숨김(백엔드가 최종 강제).
export function RunScenarioButton({ scenario }: { scenario: ScenarioItem }): JSX.Element | null {
  const api = useApiClient();
  const can = useCan();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ tone: "green" | "red"; text: string } | null>(null);

  const detail = useQuery({
    queryKey: ["scenario-detail", scenario.scenario_id],
    queryFn: () => api.getScenario(scenario.scenario_id),
    enabled: open,
  });
  const keys = extractUrlRefKeys(detail.data?.ir);
  const missing = keys.filter((k) => (values[k] ?? "").trim().length === 0);

  const run = useMutation({
    mutationFn: () => {
      const params = Object.fromEntries(keys.map((k) => [k, (values[k] ?? "").trim()]));
      return api.createRun({ scenario_version_id: scenario.latest_version_id, params }, crypto.randomUUID());
    },
    onSuccess: () => {
      setMsg({ tone: "green", text: "실행 등록됨" });
      setOpen(false);
      setValues({});
      void qc.invalidateQueries({ queryKey: ["runs"] });
    },
    onError: (e) => setMsg({ tone: "red", text: e instanceof ApiError ? `${e.code} (${e.httpStatus})` : "실패" }),
  });

  if (!can("run.create")) return null;

  return (
    <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
      <button className="btn" type="button" onClick={() => { setMsg(null); setOpen((v) => !v); }} disabled={run.isPending}>
        실행
      </button>
      {msg !== null && <span className={`badge ${msg.tone}`}>{msg.text}</span>}

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
                  <span style={{ display: "block", fontSize: 13, marginBottom: 2 }}>{k}</span>
                  <input
                    type="text"
                    value={values[k] ?? ""}
                    onChange={(e) => setValues((prev) => ({ ...prev, [k]: e.target.value }))}
                    placeholder="https://… (실행 대상 URL)"
                    aria-label={k}
                    style={{ width: "100%", fontFamily: "monospace", fontSize: 13, padding: 8, boxSizing: "border-box" }}
                  />
                </label>
              ))}
              <button
                className="btn"
                type="button"
                onClick={() => run.mutate()}
                disabled={run.isPending || missing.length > 0}
              >
                {run.isPending ? "등록 중…" : "실행 시작"}
              </button>
              {missing.length > 0 && (
                <span className="subtle" style={{ marginLeft: 8, fontSize: 12 }}>필요한 값을 모두 입력하세요.</span>
              )}
            </>
          )}
        </section>
      )}
    </span>
  );
}
