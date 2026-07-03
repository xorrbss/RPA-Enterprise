// 실행 입력값/모델 로컬 기억 — 성공 실행의 URL 파라미터·AI 모델을 localStorage 에 보존해 다음 실행 pre-fill.

import type { ScenarioParamField } from "../../api/scenario-params";

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

export function readLastRunModel(): string {
  const storage = runParamStorage();
  if (storage === null) return "";
  try {
    return storage.getItem(RUN_MODEL_MEMORY_KEY) ?? "";
  } catch {
    return "";
  }
}

export function writeLastRunModel(model: string): void {
  const storage = runParamStorage();
  if (storage === null || model.length === 0) return;
  try {
    storage.setItem(RUN_MODEL_MEMORY_KEY, model);
  } catch {
    // 브라우저 저장소가 막힌 환경(시크릿/하드닝)에서도 실행은 계속되어야 한다.
  }
}

export function readRememberedRunParams(scenarioId: string): Record<string, string> {
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

export function writeRememberedRunParams(
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
