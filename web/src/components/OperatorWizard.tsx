import { useEffect, useState } from "react";

// 운영자용 '쉬운 만들기' — IR/flags/동작 같은 기술 용어 없이 평이한 질문 몇 개로 유효 IR을 생성한다.
// 템플릿이 흐름(navigate→observe→extract→종료)을 고정하고, 운영자는 이름/사이트/데이터만 채운다.
// 산출 IR은 저장 시 동일 컴파일 파이프라인(ajv→IREL→V1–V11)이 재검증한다. (executor 불요 — 정적 IR 생성)

type Kind = "list" | "once";

function buildIr(name: string, site: string, dataName: string, kind: Kind): unknown {
  const meta = { name: name.trim() || "새 자동화", version: 1 };
  const urlRef = site.trim() || "대상사이트";
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

function Field({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (v: string) => void; placeholder: string }): JSX.Element {
  return (
    <label style={{ display: "block", marginBottom: 10 }}>
      <span className="subtle">{label}</span>
      <br />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        style={{ padding: "8px 10px", fontSize: 14, width: 360, maxWidth: "100%" }}
      />
    </label>
  );
}

export function OperatorWizard({ onChange }: { onChange: (ir: unknown) => void }): JSX.Element {
  const [name, setName] = useState("새 자동화");
  const [site, setSite] = useState("");
  const [dataName, setDataName] = useState("");
  const [kind, setKind] = useState<Kind>("list");

  // 입력이 바뀔 때마다 IR 재생성 → 상위(폼)로 전달. 저장은 동일 파이프라인.
  useEffect(() => {
    onChange(buildIr(name, site, dataName, kind));
  }, [name, site, dataName, kind, onChange]);

  return (
    <div>
      <p className="subtle" style={{ margin: "0 0 12px" }}>
        평이한 질문 몇 개로 자동화를 만듭니다. 어려운 설정은 자동으로 채워지고, 저장할 때 자동 검증됩니다.
      </p>
      <Field label="① 자동화 이름" value={name} onChange={setName} placeholder="예: 리뷰 수집" />
      <Field label="② 어떤 사이트에서? (주소 또는 이름)" value={site} onChange={setSite} placeholder="예: review-site" />
      <Field label="③ 무엇을 가져올까요?" value={dataName} onChange={setDataName} placeholder="예: 리뷰목록" />
      <label style={{ display: "block", marginBottom: 6 }}>
        <span className="subtle">④ 방식</span>
        <br />
        <select value={kind} onChange={(e) => setKind(e.target.value as Kind)} style={{ padding: "8px 10px", fontSize: 14, minWidth: 360, maxWidth: "100%" }}>
          <option value="list">여러 화면에서 목록 수집 (페이지 넘기며)</option>
          <option value="once">한 화면에서 한 번만 가져오기</option>
        </select>
      </label>
      <p className="subtle" style={{ margin: "8px 0 0", fontSize: 12 }}>
        더 세밀하게 만들려면 위의 ‘단계 편집’이나 ‘IR 직접 편집’(개발자)을 사용하세요.
      </p>
    </div>
  );
}
