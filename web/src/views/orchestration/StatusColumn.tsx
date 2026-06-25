export function StatusColumn({
  title,
  rows,
  caption,
}: {
  title: string;
  rows: readonly { name: string; status: string; tone: "green" | "blue" | "amber" | "red" | "muted"; action: string }[];
  caption?: string;
}): JSX.Element {
  return (
    <div className="ops-column">
      <h3>{title}</h3>
      {caption !== undefined && <p className="subtle">{caption}</p>}
      <ul>
        {rows.map((row) => (
          <li key={row.name}>
            <span>
              <strong>{row.name}</strong>
              <span className="subtle">{row.action}</span>
            </span>
            <span className={`badge ${row.tone}`}>{row.status}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
