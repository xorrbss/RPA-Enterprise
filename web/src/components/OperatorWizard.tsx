import { useEffect, useState } from "react";

// 운영자용 '쉬운 만들기' — IR/flags/동작 같은 기술 용어 없이 평이한 질문 몇 개로 유효 IR을 생성한다.
// 템플릿이 흐름(navigate→observe→extract→종료)을 고정하고, 운영자는 페이지 주소/데이터 이름만 채운다.
// navigate는 실행기에서 "절대 URL"을 요구하므로(utility-executor) 페이지 주소는 https://… 절대 URL로 검증한다.
// ※ 산출 IR은 '구조'다 — 실제로 그 페이지에서 데이터를 가져오려면 실행기 연결 + 사이트별 추출 설정이 필요하다.

type Kind = "list" | "once";

// 절대 URL(http/https) 검증 — 실행기 navigate 요구사항.
function urlState(s: string): "empty" | "ok" | "bad" {
  const v = s.trim();
  if (v === "") return "empty";
  try {
    const u = new URL(v);
    return u.protocol === "http:" || u.protocol === "https:" ? "ok" : "bad";
  } catch {
    return "bad";
  }
}

function buildIr(name: string, pageUrl: string, dataName: string, kind: Kind): unknown {
  const meta = { name: name.trim() || "새 자동화", version: 1 };
  // 절대 URL이면 그대로, 아니면 구조만 유효하도록 placeholder(저장은 되지만 실행은 안 됨 — 안내로 표면화).
  const urlRef = urlState(pageUrl) === "ok" ? pageUrl.trim() : "https://example.com";
  const schemaRef = dataName.trim() || "수집데이터";
  if (kind === "list") {
    // 여러 화면 수집: 사이트 열기 → 화면 확인 → (목록 보이면) 가져오기 → 마무리.
    return {
      meta,
      start: "open",
      nodes: {
        open: { what: [{ action: "navigate", url_ref: urlRef }], next: "check" },
        check: {
          what: [{ action: "observe" }],
          on: [
            { when: "flags.reviews_visible", target: "collect", priority: 2 },
            { when: "flags.not_found", target: "done", priority: 1 },
          ],
        },
        collect: { what: [{ action: "extract", schema_ref: schemaRef }], next: "done" },
        done: { terminal: "success" },
      },
    };
  }
  // 한 번만: 사이트 열기 → 가져오기 → 마무리.
  return {
    meta,
    start: "open",
    nodes: {
      open: { what: [{ action: "navigate", url_ref: urlRef }], next: "collect" },
      collect: { what: [{ action: "extract", schema_ref: schemaRef }], next: "done" },
      done: { terminal: "success" },
    },
  };
}

function Field({ label, value, onChange, placeholder, hint }: { label: string; value: string; onChange: (v: string) => void; placeholder: string; hint?: JSX.Element }): JSX.Element {
  return (
    <label style={{ display: "block", marginBottom: 10 }}>
      <span className="subtle">{label}</span>
      <br />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        style={{ padding: "8px 10px", fontSize: 14, width: 420, maxWidth: "100%" }}
      />
      {hint !== undefined && <div style={{ marginTop: 4 }}>{hint}</div>}
    </label>
  );
}

export function OperatorWizard({ onChange }: { onChange: (ir: unknown) => void }): JSX.Element {
  const [name, setName] = useState("새 자동화");
  const [pageUrl, setPageUrl] = useState("");
  const [dataName, setDataName] = useState("");
  const [kind, setKind] = useState<Kind>("list");

  // 입력이 바뀔 때마다 IR 재생성 → 상위(폼)로 전달. 저장은 동일 파이프라인.
  useEffect(() => {
    onChange(buildIr(name, pageUrl, dataName, kind));
  }, [name, pageUrl, dataName, kind, onChange]);

  const us = urlState(pageUrl);

  return (
    <div>
      <p className="subtle" style={{ margin: "0 0 12px" }}>
        평이한 질문 몇 개로 자동화의 <b>흐름</b>을 만듭니다. 저장할 때 자동으로 검증됩니다.
      </p>
      <Field label="① 자동화 이름" value={name} onChange={setName} placeholder="예: 리뷰 수집" />
      <Field
        label="② 자동화할 페이지 주소 (전체 주소를 붙여넣으세요)"
        value={pageUrl}
        onChange={setPageUrl}
        placeholder="예: https://www.example.com/products/123"
        hint={
          us === "bad" ? (
            <span className="badge red">https:// 로 시작하는 전체 주소를 넣어 주세요 (지금 값은 실행기가 열 수 없습니다)</span>
          ) : us === "ok" ? (
            <span className="badge green">주소 형식 OK</span>
          ) : undefined
        }
      />
      <Field label="③ 가져올 데이터 이름(라벨)" value={dataName} onChange={setDataName} placeholder="예: 리뷰목록" />
      <label style={{ display: "block", marginBottom: 6 }}>
        <span className="subtle">④ 방식</span>
        <br />
        <select value={kind} onChange={(e) => setKind(e.target.value as Kind)} style={{ padding: "8px 10px", fontSize: 14, minWidth: 420, maxWidth: "100%" }}>
          <option value="list">여러 화면에서 목록 수집 (페이지 넘기며)</option>
          <option value="once">한 화면에서 한 번만 가져오기</option>
        </select>
      </label>
      <p className="badge" style={{ display: "block", margin: "10px 0 0", whiteSpace: "normal" }}>
        ⚠ 지금은 자동화의 <b>흐름(구조)</b>만 만들어 저장합니다. 실제로 이 페이지에서 데이터를 가져오는 동작은
        실행기(브라우저 워커) 연결과 사이트별 추출 설정이 있어야 합니다. ‘③ 데이터 이름’은 라벨이며 실제 추출 규칙은 별도입니다.
      </p>
    </div>
  );
}
