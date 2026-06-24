import { PAGESTATE_FLAG_KEYS } from "../executor/page-state-resolver";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface PageStateSelectorSummary {
  readonly configured: boolean;
  readonly login_url_configured: boolean;
  readonly authenticated_selector_configured: boolean;
  readonly flag_count: number;
  readonly flags: readonly string[];
}

export function summarizePageStateSelectors(value: unknown): PageStateSelectorSummary {
  if (!isRecord(value)) {
    return {
      configured: false,
      login_url_configured: false,
      authenticated_selector_configured: false,
      flag_count: 0,
      flags: [],
    };
  }

  const flags = isRecord(value.flags)
    ? Object.keys(value.flags).filter((key) => (PAGESTATE_FLAG_KEYS as readonly string[]).includes(key)).sort()
    : [];
  const auth = isRecord(value.authenticatedWhen) && typeof value.authenticatedWhen.selector === "string" && value.authenticatedWhen.selector.length > 0;
  const login = typeof value.loginUrl === "string" && value.loginUrl.length > 0;
  return {
    configured: login || auth || flags.length > 0,
    login_url_configured: login,
    authenticated_selector_configured: auth,
    flag_count: flags.length,
    flags,
  };
}
