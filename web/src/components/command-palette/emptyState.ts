export type PaletteEmptyKind = "policy" | "searching" | "lookup-error" | "short-query" | "none";

export interface PaletteEmptyCopy {
  readonly title: string;
  readonly detail: string;
  readonly action?: string;
}

const POLICY_FILTERED_EMPTY_TITLE = "현재 역할 또는 메뉴 모드에서 숨겨진 항목입니다.";
const POLICY_FILTERED_EMPTY_DETAIL = "검색어와 일치하는 화면이나 작업이 있지만 현재 표시 정책에서는 결과에 표시되지 않습니다.";
const LOOKUP_FAILURE_EMPTY_TITLE = "데이터 검색을 불러오지 못했습니다.";
const LOOKUP_FAILURE_EMPTY_DETAIL = "화면 이동 결과는 계속 사용할 수 있습니다. 데이터 검색만 잠시 실패했습니다.";
const NO_RESULTS_EMPTY_TITLE = "검색 결과가 없습니다.";
const NO_RESULTS_EMPTY_DETAIL =
  "표시 가능한 화면과 작업에서 일치하는 항목을 찾지 못했습니다. 현재 역할/메뉴 모드에서 숨겨진 항목은 결과에 표시되지 않습니다.";

export const POLICY_FILTERED_ADVANCED_ACTION = "다음 행동: 고급 메뉴 전환으로 확인하거나 권한 있는 담당자에게 요청하세요.";
export const POLICY_FILTERED_REQUEST_ACTION = "다음 행동: 권한 있는 담당자에게 요청하세요.";

export const EMPTY_STATE_COPY: Record<PaletteEmptyKind, PaletteEmptyCopy> = {
  policy: {
    title: POLICY_FILTERED_EMPTY_TITLE,
    detail: POLICY_FILTERED_EMPTY_DETAIL,
  },
  searching: {
    title: "검색 중...",
    detail: "최근 실행, 사람 확인, 자동화, 담당자 정보를 함께 확인하고 있습니다.",
  },
  "lookup-error": {
    title: LOOKUP_FAILURE_EMPTY_TITLE,
    detail: LOOKUP_FAILURE_EMPTY_DETAIL,
  },
  "short-query": {
    title: "조금 더 입력해 주세요.",
    detail: "두 글자 이상 입력하면 화면과 운영 데이터를 함께 검색합니다.",
  },
  none: {
    title: NO_RESULTS_EMPTY_TITLE,
    detail: NO_RESULTS_EMPTY_DETAIL,
  },
};
