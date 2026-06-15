// 닫힌 enum 필터 드롭다운(actions 슬롯용). label 래핑으로 접근성 보장. '전체'=필터 해제.
export function FilterSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string | undefined;
  options: readonly string[];
  onChange: (v: string | undefined) => void;
}): JSX.Element {
  return (
    <label style={{ display: "inline-flex", gap: 6, alignItems: "center", fontSize: 12, color: "var(--muted)" }}>
      {label}
      <select
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value === "" ? undefined : e.target.value)}
        style={{ padding: "5px 8px", borderRadius: 8, border: "1px solid var(--line-strong)", background: "var(--surface)", fontSize: 13 }}
      >
        <option value="">전체</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </label>
  );
}
