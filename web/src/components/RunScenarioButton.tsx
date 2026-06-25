import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useApiClient } from "../api/context";
import { useCan } from "../api/permissions";
import { ApiError, type ApiErrorBody, type CreateRunBody, type GatewayPolicy, type Paginated, type ScenarioItem, type SiteItem } from "../api/types";
import {
  coerceParamValue,
  extractScenarioParamFields,
  extractUrlRefKeys,
  isParamFieldInvalid,
  isParamFieldMissing,
  shouldIncludeParam,
  type ScenarioParamField,
} from "../api/scenario-params";
import { errorLabel } from "./badges";
import { navigate } from "../router";

// 자동화 실행 버튼 + 파라미터 입력 패널.
// 파라미터 시나리오(navigate.url_ref 가 params 키)는 실행 전 값(URL)을 받아야 한다(런타임 v2.11). 실행 시 getScenario로
// IR을 받아 필요한 키를 도출하고, 키별 입력을 채워 createRun(params). 키가 없으면 추가 입력 없이 실행.
// 조용한 실패 금지: ApiError 는 **패널 안**에 표면화(닫힌 패널 뒤 배지로 가려 '무반응'처럼 보이던 문제 해소).
// 다정책+기본없음 테넌트는 createRun 이 model_required(422) → AI 모델 선택 폼을 노출해 재실행(임의선택 금지, Gateway 뷰 동형).
// RBAC: run.create 미보유 시 숨김(백엔드가 최종 강제).

// createRun 의 model_required(다정책+기본없음 → 임의선택 불가) 판별. error-catalog 본문 details.reason 으로 식별.
function modelRequiredOf(body: ApiErrorBody | null): { available: number } | null {
  const details = body?.details;
  if (details === undefined || details.reason !== "model_required") return null;
  const available = typeof details.available === "number" ? details.available : 0;
  return { available };
}

const RUN_PARAM_MEMORY_PREFIX = "rpa.run.params.";

function runParamMemoryKey(scenarioId: string): string {
  return `${RUN_PARAM_MEMORY_PREFIX}${scenarioId}`;
}

function runParamStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  return window.localStorage;
}

// model_required(다정책+기본없음) 테넌트에서 마지막으로 성공 실행에 쓴 AI 모델을 기억(테넌트 단위 정책이라 전역 키).
// model_required 가 실제로 걸렸을 때만 pre-fill 하므로, 모델이 불필요한 실행에 stale 모델이 적용되지 않는다.
const RUN_MODEL_MEMORY_KEY = "rpa.run.last_model";

function readLastRunModel(): string {
  const storage = runParamStorage();
  if (storage === null) return "";
  try {
    return storage.getItem(RUN_MODEL_MEMORY_KEY) ?? "";
  } catch {
    return "";
  }
}

function writeLastRunModel(model: string): void {
  const storage = runParamStorage();
  if (storage === null || model.length === 0) return;
  try {
    storage.setItem(RUN_MODEL_MEMORY_KEY, model);
  } catch {
    // 브라우저 저장소가 막힌 환경(시크릿/하드닝)에서도 실행은 계속되어야 한다.
  }
}

function readRememberedRunParams(scenarioId: string): Record<string, string> {
  const storage = runParamStorage();
  if (storage === null) return {};
  try {
    const raw = storage.getItem(runParamMemoryKey(scenarioId));
    if (raw === null) return {};
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  } catch {
    return {};
  }
}

function shouldRememberRunParam(field: ScenarioParamField): boolean {
  if (field.source === "url_ref") return true;
  const key = field.key.toLowerCase();
  return key === "entry_url" || key === "start_url" || key === "login_url" || key.endsWith("_url");
}

function writeRememberedRunParams(
  scenarioId: string,
  fields: readonly ScenarioParamField[],
  submitted: Readonly<Record<string, string>>,
): void {
  const storage = runParamStorage();
  if (storage === null) return;
  const remembered = Object.fromEntries(
    fields
      .filter(shouldRememberRunParam)
      .map((field): [string, string] => [field.key, submitted[field.key]?.trim() ?? ""])
      .filter((entry): entry is [string, string] => entry[1].length > 0),
  );
  try {
    if (Object.keys(remembered).length === 0) {
      storage.removeItem(runParamMemoryKey(scenarioId));
    } else {
      storage.setItem(runParamMemoryKey(scenarioId), JSON.stringify(remembered));
    }
  } catch {
    // Browser storage can be unavailable in hardened/private contexts; execution should still proceed.
  }
}

export function RunScenarioButton({ scenario }: { scenario: ScenarioItem }): JSX.Element | null {
  const api = useApiClient();
  const can = useCan();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [rememberedValues, setRememberedValues] = useState<Record<string, string>>({});
  const pendingRememberedValues = useRef<Record<string, string>>({});
  const [model, setModel] = useState("");
  const [msg, setMsg] = useState<{ tone: "green" | "red"; text: string } | null>(null);
  // null=모델 불필요(기본/단일정책 자동해소). non-null=createRun 이 model_required 로 거부 → AI 모델 선택 필요.
  const [modelRequired, setModelRequired] = useState<{ available: number } | null>(null);
  // AI 모델 선택 검증(P0-3) — '확인'을 누른 모델 값. getGatewayPolicy 로 실제 존재하는 정책인지 확인한 뒤에만 실행 허용.
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
  const policies = useQuery({
    queryKey: ["gateway-policies", "run-readiness"],
    queryFn: () => api.listGatewayPolicies(),
    enabled: open,
    retry: false,
  });
  const sites = useQuery({
    queryKey: ["sites", "run-readiness"],
    queryFn: () => api.listSites({ limit: 200 }),
    enabled: open,
    retry: false,
  });
  const validation = useQuery({
    queryKey: ["scenario-validation", scenario.scenario_id, scenario.version],
    queryFn: () => api.validateScenario(scenario.scenario_id, detail.data!.ir, crypto.randomUUID()),
    enabled: open && detail.data?.ir !== undefined,
    retry: false,
  });
  const policyItems = policies.data?.items ?? [];
  const fields = extractScenarioParamFields(detail.data?.ir);
  const urlRefKeys = extractUrlRefKeys(detail.data?.ir);
  // params_schema default(쉬운 만들기가 실은 입력 URL)로 prefill. 사용자가 입력하면 values 가 우선.
  const valueFor = (field: ScenarioParamField): string => values[field.key] ?? rememberedValues[field.key] ?? field.defaultValue;
  const missing = fields.filter((field) => isParamFieldMissing(field, valueFor(field)));
  const invalid = fields.filter((field) => isParamFieldInvalid(field, valueFor(field)));
  const urlRefFields = fields.filter((field) => urlRefKeys.includes(field.key));
  // model_required 거부 후엔 AI 모델을 선택·확인(getGatewayPolicy)하기 전까지 실행 차단(맹목 직타 가드).
  const needModel = modelRequired !== null && !modelConfirmed;

  const run = useMutation({
    mutationFn: () => {
      const submitted = Object.fromEntries(fields.map((field) => [field.key, valueFor(field)]));
      pendingRememberedValues.current = submitted;
      const params = Object.fromEntries(
        fields
          .filter((field) => shouldIncludeParam(field, submitted[field.key] ?? ""))
          .map((field) => [field.key, coerceParamValue(field, submitted[field.key] ?? "")]),
      );
      const base: CreateRunBody = { scenario_version_id: scenario.latest_version_id, params };
      const m = model.trim();
      return api.createRun(m.length > 0 ? { ...base, model: m } : base, crypto.randomUUID());
    },
    onSuccess: (result) => {
      writeRememberedRunParams(scenario.scenario_id, fields, pendingRememberedValues.current);
      writeLastRunModel(model.trim()); // 성공한 실행의 모델만 기억(실패 모델 미기억)

      setRememberedValues(readRememberedRunParams(scenario.scenario_id));
      setMsg(null);
      setOpen(false);
      setValues({});
      setModel("");
      setModelRequired(null);
      setCheckedModel("");
      void qc.invalidateQueries({ queryKey: ["runs"] });
      // 시작 → 관찰 직행(P0-1): 방금 만든 run 의 라이브 트레이스로 즉시 이동(수동 '실행 기록 보기'·UUID 복붙 제거).
      navigate("runTrace", { run: result.run_id, focus: "artifacts" });
    },
    onError: (e) => {
      // model_required → AI 모델 선택 노출(임의선택 금지). 그 외 에러는 코드 표면화. 둘 다 패널 안에 표시.
      const mr = e instanceof ApiError && e.code === "IR_SCHEMA_INVALID" ? modelRequiredOf(e.body) : null;
      if (mr !== null) {
        setModelRequired(mr);
        // 마지막으로 쓴 모델을 pre-fill(확인은 여전히 필요 — 정책 조회로 유효성 재확인, 맹목 직타 아님).
        if (model.trim().length === 0) {
          const last = readLastRunModel();
          if (last.length > 0) setModel(last);
        }
        setMsg({ tone: "red", text: `AI 모델을 지정해야 합니다 (정책 ${mr.available}개, 기본 미지정). AI 모델을 선택하고 확인한 뒤 다시 실행하세요.` });
      } else {
        setMsg({ tone: "red", text: errorLabel(e) });
      }
    },
  });

  if (!can("run.create")) return null;

  return (
    <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
      <button
        className="btn primary"
        type="button"
        onClick={() => {
          setMsg(null);
          if (!open) setRememberedValues(readRememberedRunParams(scenario.scenario_id));
          setOpen((v) => !v);
        }}
        disabled={run.isPending}
      >
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
            <p className="badge red" role="alert" style={{ display: "block", margin: 0 }}>자동화 정보를 불러오지 못했습니다.</p>
          ) : (
            <>
              <p className="subtle" style={{ margin: "0 0 8px" }}>
                {fields.length > 0
                  ? "이 자동화는 실행에 아래 값이 필요합니다. 입력 후 실행하세요."
                  : "추가 입력 없이 최신 버전으로 실행합니다."}
              </p>
              {fields.map((field) => (
                <ParamFieldInput
                  key={field.key}
                  field={field}
                  value={valueFor(field)}
                  onChange={(value) => setValues((prev) => ({ ...prev, [field.key]: value }))}
                />
              ))}
              <ReadinessCard
                hasIr={detail.data?.ir !== undefined}
                fields={fields}
                missing={missing}
                invalid={invalid}
                policies={policies}
                sites={sites}
                validation={validation}
                modelRequired={modelRequired}
                modelConfirmed={modelConfirmed}
                targetUrls={urlRefFields.map((field) => valueFor(field).trim()).filter((v) => v.length > 0)}
              />
              {modelRequired !== null && (
                <label style={{ display: "block", marginBottom: 8 }}>
                  <span style={{ display: "block", fontSize: 13, marginBottom: 2 }}>AI 모델</span>
                  <span style={{ display: "flex", gap: 6 }}>
                    {policyItems.length > 0 ? (
                      <select
                        value={model}
                        onChange={(e) => {
                          setModel(e.target.value);
                          setCheckedModel("");
                        }}
                        aria-label="AI 모델"
                        style={{ flex: 1, padding: 8, boxSizing: "border-box" }}
                      >
                        <option value="">AI 모델 선택</option>
                        {policyItems.map((policy) => (
                          <option key={policy.model} value={policy.model}>
                            {policy.model}{policy.is_default === true ? " · 기본" : ""}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        type="text"
                        value={model}
                        onChange={(e) => {
                          setModel(e.target.value);
                          setCheckedModel("");
                        }}
                        placeholder="예: gpt-4o-mini"
                        aria-label="AI 모델"
                        style={{ flex: 1, fontFamily: "monospace", fontSize: 13, padding: 8, boxSizing: "border-box" }}
                      />
                    )}
                    {/* 선택한 AI 모델을 getGatewayPolicy 로 검증(P0-3) — 실제 정책 존재 확인 후에만 실행 허용(맹목 입력 제거). */}
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
                            ? `‘${checkedModel}’ 정책을 찾을 수 없습니다. AI 모델 선택을 확인하세요.`
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
                disabled={run.isPending || missing.length > 0 || invalid.length > 0 || needModel}
              >
                {run.isPending ? "등록 중…" : "실행 시작"}
              </button>
              {(missing.length > 0 || invalid.length > 0 || needModel) && (
                <span className="subtle" style={{ marginLeft: 8, fontSize: 12 }}>필요한 값을 모두 입력하세요.</span>
              )}
            </>
          )}
        </section>
      )}
    </span>
  );
}

function ParamFieldInput({
  field,
  value,
  onChange,
}: {
  field: ScenarioParamField;
  value: string;
  onChange: (value: string) => void;
}): JSX.Element {
  const label = field.required ? `${field.label} *` : field.label;
  const commonStyle = { width: "100%", padding: 8, boxSizing: "border-box" } as const;
  return (
    <label style={{ display: "block", marginBottom: 8 }}>
      {/* params_schema title/description 을 우선 사용하고, 미정의 키는 운영자용 라벨로 폴백한다. */}
      <span style={{ display: "block", fontSize: 13, marginBottom: 2 }}>{label}</span>
      {field.kind === "checkbox" ? (
        <span className="checkbox-inline">
          <input
            type="checkbox"
            checked={value === "true"}
            onChange={(event) => onChange(event.target.checked ? "true" : "false")}
            aria-label={field.label}
          />
          <span>{value === "true" ? "사용" : "사용 안 함"}</span>
        </span>
      ) : field.kind === "select" ? (
        <select
          value={value}
          onChange={(event) => onChange(event.target.value)}
          aria-label={field.label}
          style={commonStyle}
        >
          <option value="">선택하세요</option>
          {(field.options ?? []).map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      ) : (
        <input
          type={field.kind === "number" ? "number" : "text"}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={field.placeholder}
          aria-label={field.label}
          style={{
            ...commonStyle,
            fontFamily: field.kind === "text" && field.placeholder?.startsWith("https://") ? "monospace" : undefined,
            fontSize: 13,
          }}
        />
      )}
      {field.description !== undefined && (
        <span className="subtle" style={{ display: "block", marginTop: 4, fontSize: 12 }}>
          {field.description}
        </span>
      )}
    </label>
  );
}

function CheckRow({ tone, label, detail, action }: { tone: "green" | "amber" | "red" | "blue"; label: string; detail: string; action?: JSX.Element }): JSX.Element {
  return (
    <div className="readiness-row">
      <span className={`badge ${tone}`}>{label}</span>
      <span className="subtle">{detail}</span>
      {action}
    </div>
  );
}

function ReadinessCard({
  hasIr,
  fields,
  missing,
  invalid,
  policies,
  sites,
  validation,
  modelRequired,
  modelConfirmed,
  targetUrls,
}: {
  hasIr: boolean;
  fields: readonly ScenarioParamField[];
  missing: readonly ScenarioParamField[];
  invalid: readonly ScenarioParamField[];
  policies: ReturnType<typeof useQuery<Paginated<GatewayPolicy>>>;
  sites: ReturnType<typeof useQuery<Paginated<SiteItem>>>;
  validation: ReturnType<typeof useQuery<{ valid: boolean; report: unknown }>>;
  modelRequired: { available: number } | null;
  modelConfirmed: boolean;
  targetUrls: readonly string[];
}): JSX.Element {
  const policyItems = policies.data?.items ?? [];
  const hasDefault = policyItems.some((p) => p.is_default === true);
  const modelTone = modelRequired !== null && !modelConfirmed
    ? "red"
    : policies.isError || policyItems.length === 0 || (!hasDefault && policyItems.length > 1)
      ? "amber"
      : "green";
  const modelText = modelRequired !== null && !modelConfirmed
    ? "AI 모델을 선택하고 확인해야 실행할 수 있습니다."
    : policies.isLoading
      ? "모델 정책 확인 중입니다."
      : policies.isError
        ? "모델 정책을 불러오지 못했습니다. 실행 시 서버가 최종 판정합니다."
        : policyItems.length === 0
          ? "등록된 모델 정책이 없습니다."
          : hasDefault || policyItems.length === 1
            ? "기본 또는 단일 모델 정책으로 실행할 수 있습니다."
            : "기본 정책이 없어 실행 시 AI 모델 선택이 필요할 수 있습니다.";
  const validationTone = !hasIr
    ? "amber"
    : validation.isLoading
      ? "blue"
      : validation.isError
        ? "amber"
        : validation.data?.valid === true
          ? "green"
          : "red";
  const validationText = !hasIr
    ? "자동화 정의를 불러오지 못해 실행 전 검사를 먼저 확인할 수 없습니다."
    : validation.isLoading
      ? "자동화 정의를 확인하는 중입니다."
      : validation.isError
        ? "실행 전 검사 호출에 실패했습니다. 저장 시 검증과 실행 시 서버 판정을 따릅니다."
        : validation.data?.valid === true
          ? "자동화 정의 검사를 통과했습니다."
          : "자동화 정의 검사 오류가 있습니다. 실행 전 자동화 검사를 권장합니다.";
  const paramTone = missing.length === 0 && invalid.length === 0 ? "green" : "red";
  const paramText = fields.length === 0
    ? "추가 실행값 없이 실행할 수 있습니다."
    : invalid.length > 0
      ? `입력값 형식을 확인하세요: ${invalid.map((field) => field.label).join(", ")}.`
      : missing.length === 0
      ? "필수 실행값이 모두 입력되었습니다."
      : `필수 실행값 ${missing.map((field) => field.label).join(", ")} 입력이 필요합니다.`;
  const site = siteReadiness(targetUrls, sites);
  return (
    <section className="readiness-card" aria-label="실행 전 준비 점검">
      <strong>실행 전 준비 점검</strong>
      <CheckRow tone={paramTone} label="실행값" detail={paramText} />
      <CheckRow
        tone={validationTone}
        label="실행 전 검사"
        detail={validationText}
        action={<button className="linklike" type="button" onClick={() => navigate("irValidation")}>검사 화면</button>}
      />
      <CheckRow
        tone={modelTone}
        label="모델 정책"
        detail={modelText}
        action={<button className="linklike" type="button" onClick={() => navigate("llmGateway")}>정책 보기</button>}
      />
      <CheckRow
        tone={site.tone}
        label="사이트/세션"
        detail={site.detail}
        action={
          site.sessionSiteId !== undefined ? (
            <button className="linklike" type="button" onClick={() => navigate("security", { site: site.sessionSiteId as string })}>
              세션 등록하러 가기
            </button>
          ) : targetUrls.length > 0 ? (
            <button className="linklike" type="button" onClick={() => navigate("security")}>
              사이트 보기
            </button>
          ) : undefined
        }
      />
    </section>
  );
}

function originOf(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}

function siteReadiness(
  targetUrls: readonly string[],
  sites: ReturnType<typeof useQuery<Paginated<SiteItem>>>,
): { tone: "green" | "amber" | "red" | "blue"; detail: string; sessionSiteId?: string } {
  if (targetUrls.length === 0) return { tone: "blue", detail: "웹사이트 이동이 없는 자동화입니다." };
  const origins = targetUrls.map(originOf);
  if (origins.some((origin) => origin === null)) return { tone: "red", detail: "실행 대상 웹 주소를 확인할 수 없습니다." };
  if (sites.isLoading) return { tone: "blue", detail: "등록 사이트와 세션 상태를 확인하는 중입니다." };
  if (sites.isError) return { tone: "amber", detail: "사이트 목록을 불러오지 못했습니다. 실행 시 서버가 최종 판정합니다." };
  const siteItems = sites.data?.items ?? [];
  const matched = origins.map((origin) => siteItems.find((site) => originOf(site.url_pattern ?? "") === origin));
  if (matched.some((site) => site === undefined)) {
    return { tone: "amber", detail: "등록된 사이트와 매칭되지 않는 실행 주소가 있습니다." };
  }
  const concrete = matched.filter((site): site is SiteItem => site !== undefined);
  const pendingRed = concrete.find((site) => site.risk === "red" && site.approval_status !== "approved");
  if (pendingRed !== undefined) return { tone: "red", detail: `${pendingRed.name ?? "고위험 사이트"} 승인 후 실행할 수 있습니다.` };
  const openCircuit = concrete.find((site) => site.circuit_status !== "closed");
  if (openCircuit !== undefined) return { tone: "amber", detail: `${openCircuit.name ?? "대상 사이트"} 자동 차단 상태가 ${openCircuit.circuit_status}입니다.` };
  const needsSession = concrete.find((site) => site.login_capable === true && site.session_ready !== true);
  if (needsSession !== undefined) {
    return {
      tone: "amber",
      detail: `${needsSession.name ?? "대상 사이트"}는 로그인이 필요합니다. 세션을 등록하세요.`,
      sessionSiteId: needsSession.site_profile_id,
    };
  }
  return { tone: "green", detail: "대상 사이트 승인, 자동 차단, 세션 상태가 준비되어 있습니다." };
}
