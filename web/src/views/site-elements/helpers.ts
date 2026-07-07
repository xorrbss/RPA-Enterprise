import type {
  SiteElementCreateBody,
  SiteElementItem,
  SiteElementProbeResponse,
  SiteElementProbeStatus,
  SiteElementStability,
  SiteElementType,
  SiteItem,
} from "../../api/types";

export const ELEMENT_TYPES: readonly SiteElementType[] = ["button", "input", "link", "table", "row", "field", "message", "other"];
export const STABILITIES: readonly SiteElementStability[] = ["stable", "review_needed", "broken"];

export const TYPE_LABEL: Record<SiteElementType, string> = {
  button: "버튼",
  input: "입력 필드",
  link: "링크",
  table: "테이블",
  row: "행",
  field: "데이터 필드",
  message: "메시지",
  other: "기타",
};

export const STABILITY_LABEL: Record<SiteElementStability, string> = {
  stable: "안정",
  review_needed: "검토 필요",
  broken: "재점검 필요",
};

export const PROBE_LABEL: Record<SiteElementProbeStatus, string> = {
  matched: "검증됨",
  not_found: "찾을 수 없음",
  invalid_selector: "화면 조건 오류",
  failed: "검증 실패",
  not_run: "검증 안 됨",
};

export function stabilityTone(value: SiteElementStability): string {
  if (value === "stable") return "green";
  if (value === "review_needed") return "amber";
  return "red";
}

export function probeTone(value: SiteElementProbeStatus): string {
  if (value === "matched") return "green";
  if (value === "not_found" || value === "not_run") return "amber";
  return "red";
}

export function probeMessageTone(value: SiteElementProbeStatus): "green" | "amber" | "red" {
  if (value === "matched") return "green";
  if (value === "not_found" || value === "not_run") return "amber";
  return "red";
}

export function probeReasonLabel(result: SiteElementProbeResponse): string {
  switch (result.reason_code) {
    case "SAMPLE_URL_REQUIRED":
      return "샘플 주소가 필요합니다.";
    case "SELECTOR_PROBE_PROVIDER_UNAVAILABLE":
      return "브라우저 검증 연결이 필요합니다.";
    case "SELECTOR_NOT_FOUND":
      return "해당 화면에서 요소를 찾지 못했습니다.";
    case "SELECTOR_INVALID":
      return "화면에서 찾는 조건 문법을 확인하세요.";
    case "SELECTOR_PROBE_FAILED":
      return "브라우저 검증 중 오류가 발생했습니다.";
    case null:
      return PROBE_LABEL[result.probe_status];
    default:
      return PROBE_LABEL[result.probe_status];
  }
}

export function probeMatchLabel(result: SiteElementProbeResponse): string {
  if (result.match_count !== null) return `${result.match_count}개 일치`;
  if (result.probe_status === "not_run") return "검증 연결 대기";
  return "일치 수 확인 불가";
}

export const EMPTY_FORM: SiteElementCreateBody = {
  element_key: "",
  label: "",
  selector: "",
  element_type: "button",
  stability: "stable",
  source: "manual",
  sample_url: "",
  notes: "",
};

export interface BulkProbeItem {
  label: string;
  status: SiteElementProbeStatus;
  reason: string;
}

export interface BulkProbeState {
  running: boolean;
  total: number;
  checked: number;
  matched: number;
  attention: number;
  failed: number;
  results: readonly BulkProbeItem[];
}

export function formatCount(value: number): string {
  return new Intl.NumberFormat("ko-KR").format(value);
}

export function appendUniqueSites(prev: readonly SiteItem[], next: readonly SiteItem[]): SiteItem[] {
  const seen = new Set(prev.map((item) => item.site_profile_id));
  return [...prev, ...next.filter((item) => !seen.has(item.site_profile_id))];
}

export function appendUniqueElements(prev: readonly SiteElementItem[], next: readonly SiteElementItem[]): SiteElementItem[] {
  const seen = new Set(prev.map((item) => item.element_id));
  return [...prev, ...next.filter((item) => !seen.has(item.element_id))];
}
