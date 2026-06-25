import { isRecord, jsonCellLabel, type JsonSummary } from "./artifact-helpers";

export function JsonSummaryPreview({
  summary,
}: {
  summary: JsonSummary;
}): JSX.Element {
  const records = summary.sample.filter(isRecord);
  const columns = summary.keys.length > 0 ? summary.keys : ["value"];
  return (
    <div style={{ display: "grid", gap: 8, marginTop: 8 }}>
      {records.length > 0 ? (
        <div className="table-wrap compact-table">
          <table>
            <thead>
              <tr>
                {columns.map((key) => (
                  <th key={key}>{key}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {records.map((row, index) => (
                <tr key={index}>
                  {columns.map((key) => (
                    <td key={key}>{jsonCellLabel(row[key])}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <ul className="summary-list">
          {summary.sample.map((value, index) => (
            <li key={index}>{jsonCellLabel(value)}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function TextArtifactSummaryPreview({ content }: { content: string }): JSX.Element {
  const trimmed = content.trim();
  const lineCount = trimmed === "" ? 0 : trimmed.split(/\r?\n/).length;
  return (
    <div className="artifact-json-summary" aria-label="결과 요약" style={{ marginTop: 8 }}>
      <span>
        <span className="subtle">형식</span>
        <strong>텍스트 결과</strong>
      </span>
      <span>
        <span className="subtle">크기</span>
        <strong>{trimmed.length.toLocaleString("ko-KR")}자</strong>
      </span>
      <span>
        <span className="subtle">줄 수</span>
        <strong>{lineCount.toLocaleString("ko-KR")}줄</strong>
      </span>
    </div>
  );
}
