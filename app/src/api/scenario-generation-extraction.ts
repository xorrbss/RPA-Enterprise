/**
 * 시나리오 생성 — 추출(extract) 노드·결정형 결과 스키마·프롬프트 기반 추출 필드 후보/지시문.
 * buildDeterministicMvpGenerationPlan(scenario-generation-planner.ts)이 소비한다.
 * (분해 전 planner 내부였음 — CLAUDE.md #7. RecordingPolicy 외 의존 없는 leaf.)
 */
import type { RecordingPolicy } from "./scenario-generation-policy";

export interface ExtractionFieldPlan {
  readonly name: string;
  readonly description: string;
}

export function extractNode(input: {
  instruction: string;
  next: string;
  recording: RecordingPolicy;
  schemaRef: string;
  fields: readonly ExtractionFieldPlan[];
}): Record<string, unknown> {
  return {
    what: [
      {
        action: "extract",
        instruction: input.instruction,
        schema_ref: input.schemaRef,
        args: {
          schema_version: "1",
          strict: true,
          schema: generatedExtractSchema(input.fields),
        },
      },
    ],
    next: input.next,
    policy: { recording: input.recording },
    side_effect: { kind: "read_only" },
  };
}

function generatedExtractSchema(fields: readonly ExtractionFieldPlan[]): Record<string, unknown> {
  const rowProperties: Record<string, unknown> = {};
  for (const field of fields) {
    rowProperties[field.name] = {
      type: "string",
      description: field.description,
    };
  }
  return {
    type: "object",
    additionalProperties: false,
    required: ["summary", "rows"],
    properties: {
      summary: { type: "string" },
      rows: {
        type: "array",
        items: {
          type: "object",
          ...(Object.keys(rowProperties).length > 0 ? { properties: rowProperties } : {}),
          additionalProperties: true,
        },
      },
    },
  };
}

const EXTRACTION_FIELD_CANDIDATES: readonly {
  readonly name: string;
  readonly description: string;
  readonly patterns: readonly RegExp[];
}[] = [
  {
    name: "title",
    description: "화면에 표시된 제목, 타이틀, 문서명, 게시글명 또는 항목명",
    patterns: [/(?:제목|타이틀|문서명|게시글명|공지명|항목명|\btitles?\b|\bsubjects?\b)/i],
  },
  {
    name: "url",
    description: "항목 상세 페이지나 참조 대상의 링크 URL",
    patterns: [/(?:링크|주소|\blinks?\b|\burls?\b|\bhref\b)/i],
  },
  {
    name: "date",
    description: "화면에 표시된 날짜, 작성일, 등록일, 마감일 또는 기한",
    patterns: [/(?:날짜|일자|작성일|등록일|마감일|기한|\bdate\b|\bcreated\b|\bupdated\b|\bdue\b)/i],
  },
  {
    name: "author",
    description: "작성자, 기안자, 요청자, 담당자 또는 소유자",
    patterns: [/(?:작성자|기안자|요청자|담당자|소유자|\bauthor\b|\bwriter\b|\brequester\b|\bowner\b)/i],
  },
  {
    name: "status",
    description: "업무 상태, 처리 상태, 승인/반려 상태 또는 진행 단계",
    patterns: [/(?:상태|진행\s*단계|승인|반려|\bstatus\b|\bstate\b|\bprogress\b)/i],
  },
  {
    name: "amount",
    description: "금액, 가격, 합계, 총액 또는 비용을 화면 원문에 가깝게 보존한 값",
    patterns: [/(?:금액|가격|합계|총액|비용|\bamount\b|\bprice\b|\btotal\b|\bcost\b)/i],
  },
  {
    name: "rating",
    description: "별점, 평점, 점수 또는 rating 값",
    patterns: [/(?:별점|평점|점수|\brating\b|\bscore\b)/i],
  },
  {
    name: "file_name",
    description: "첨부 파일명 또는 다운로드 대상 파일명",
    patterns: [/(?:첨부\s*파일명|파일명|\bfile\s*name\b|\bfilename\b)/i],
  },
  {
    name: "order_id",
    description: "주문번호, 주문 ID 또는 주문을 식별하는 번호",
    patterns: [/(?:주문\s*번호|주문\s*ID|\border\s*(?:id|number|no\.?)\b)/i],
  },
  {
    name: "document_id",
    description: "문서번호, 결재번호, 문서 ID 또는 문서를 식별하는 번호",
    patterns: [/(?:문서\s*번호|결재\s*번호|문서\s*ID|\bdocument\s*(?:id|number|no\.?)\b)/i],
  },
  {
    name: "quantity",
    description: "수량, 개수, 건수를 화면 원문에 가깝게 보존한 값",
    patterns: [/(?:수량|개수|건수|\bquantity\b|\bqty\b|\bcount\b)/i],
  },
  {
    name: "category",
    description: "분류, 구분, 유형 또는 카테고리",
    patterns: [/(?:분류|구분|유형|카테고리|\bcategory\b)/i],
  },
  {
    name: "department",
    description: "부서, 소속 또는 담당 조직",
    patterns: [/(?:부서|소속|\bdepartment\b|\bteam\b)/i],
  },
  {
    name: "phone",
    description: "전화번호, 연락처 또는 휴대폰 번호",
    patterns: [/(?:전화\s*번호|연락처|휴대폰|\bphone\b|\btel\b)/i],
  },
  {
    name: "email",
    description: "이메일 주소 또는 메일 주소",
    patterns: [/(?:이메일|메일\s*주소|\bemail\b|\be-mail\b)/i],
  },
];

export function extractionFieldPlan(prompt: string): readonly ExtractionFieldPlan[] {
  const fields: ExtractionFieldPlan[] = [];
  const seen = new Set<string>();
  for (const candidate of EXTRACTION_FIELD_CANDIDATES) {
    if (seen.has(candidate.name)) continue;
    if (candidate.patterns.some((pattern) => pattern.test(prompt))) {
      seen.add(candidate.name);
      fields.push({ name: candidate.name, description: candidate.description });
    }
  }
  return fields;
}

export function extractionInstruction(prompt: string, fields: readonly ExtractionFieldPlan[]): string {
  return [
    "사용자의 자연어 요청을 기준으로 화면에서 필요한 업무 결과를 추출한다.",
    "반환 형식은 { summary: string, rows: object[] } 이다.",
    ...extractionFieldInstructions(fields),
    "화면에 결과가 없으면 rows는 빈 배열로 두고 summary에 관찰 내용을 적는다.",
    `사용자 요청: ${prompt}`,
  ].join("\n");
}

export function paginatedExtractionInstruction(prompt: string, fields: readonly ExtractionFieldPlan[]): string {
  return [
    "현재 페이지에 보이는 결과만 추출한다. 이전 페이지나 다음 페이지를 상상해 합치지 않는다.",
    "반복 실행 전체의 병합은 런타임이 담당한다. 각 페이지에서는 { summary: string, rows: object[] }만 반환한다.",
    ...extractionFieldInstructions(fields),
    "페이지에 결과가 없으면 rows는 빈 배열로 둔다.",
    `사용자 요청: ${prompt}`,
  ].join("\n");
}

function extractionFieldInstructions(fields: readonly ExtractionFieldPlan[]): string[] {
  if (fields.length === 0) return [];
  const names = fields.map((field) => field.name).join(", ");
  return [
    `rows의 각 객체는 가능한 경우 다음 snake_case 필드를 포함한다: ${names}.`,
    "필드 값을 화면에서 찾을 수 없으면 추측하지 말고 해당 필드를 생략한다.",
  ];
}
