import { FLAGS, SELECT, flagLabel, type Flow, type Rule } from "./model";

export function LoopControls({
  flow,
  ids,
  onChange,
}: {
  flow: Extract<Flow, { kind: "loop" }>;
  ids: readonly string[];
  onChange: (flow: Extract<Flow, { kind: "loop" }>) => void;
}): JSX.Element {
  const set = (patch: Partial<Extract<Flow, { kind: "loop" }>>) =>
    onChange({ ...flow, ...patch });
  const untilOptions = FLAGS.map((flag) => `flags.${flag}`);
  const hasKnownUntil = untilOptions.includes(flow.until);
  return (
    <span
      style={{
        display: "inline-flex",
        flexWrap: "wrap",
        gap: 6,
        alignItems: "center",
      }}
    >
      <span className="subtle">반복할 단계</span>
      <select
        value={flow.bodyTarget}
        onChange={(e) => set({ bodyTarget: e.target.value })}
        style={SELECT}
      >
        {ids.map((id) => (
          <option key={id} value={id}>
            {id}
          </option>
        ))}
      </select>
      <span className="subtle">반복 후 이동</span>
      <select
        value={flow.exitTarget}
        onChange={(e) => set({ exitTarget: e.target.value })}
        style={SELECT}
      >
        {ids.map((id) => (
          <option key={id} value={id}>
            {id}
          </option>
        ))}
      </select>
      <span className="subtle">멈춤 조건</span>
      <select
        value={hasKnownUntil ? flow.until : "__custom"}
        onChange={(e) => {
          if (e.target.value !== "__custom") set({ until: e.target.value });
        }}
        style={SELECT}
      >
        {untilOptions.map((value) => {
          const flag = value.replace("flags.", "");
          return (
            <option key={value} value={value}>
              {flagLabel(flag)}
            </option>
          );
        })}
        {!hasKnownUntil && <option value="__custom">사용자 조건</option>}
      </select>
      <span className="subtle">최대 반복</span>
      <input
        type="number"
        min={1}
        max={10000}
        value={flow.maxIterations}
        onChange={(e) => set({ maxIterations: Number(e.target.value) })}
        style={{ ...SELECT, width: 72 }}
      />
    </span>
  );
}

export function BranchRules({
  rules,
  ids,
  onChange,
}: {
  rules: readonly Rule[];
  ids: readonly string[];
  onChange: (rules: Rule[]) => void;
}): JSX.Element {
  const set = (i: number, patch: Partial<Rule>) =>
    onChange(rules.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <span style={{ display: "inline-flex", flexDirection: "column", gap: 4 }}>
      {rules.map((r, i) => (
        <span
          key={i}
          style={{ display: "inline-flex", gap: 4, alignItems: "center" }}
        >
          <span className="subtle">조건</span>
          <select
            value={r.when.replace("flags.", "")}
            onChange={(e) => set(i, { when: `flags.${e.target.value}` })}
            style={SELECT}
          >
            {FLAGS.map((f) => (
              <option key={f} value={f}>
                {flagLabel(f)}
              </option>
            ))}
          </select>
          <span className="subtle">이동</span>
          <select
            value={r.target}
            onChange={(e) => set(i, { target: e.target.value })}
            style={SELECT}
          >
            {ids.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
          <span className="subtle">순서</span>
          <input
            type="number"
            value={r.priority}
            onChange={(e) => set(i, { priority: Number(e.target.value) })}
            style={{ ...SELECT, width: 52 }}
          />
          <button
            className="btn"
            type="button"
            onClick={() => onChange(rules.filter((_, j) => j !== i))}
            disabled={rules.length === 1}
          >
            ×
          </button>
        </span>
      ))}
      <button
        className="btn"
        type="button"
        onClick={() =>
          onChange([
            ...rules,
            {
              when: "flags.blocked",
              target: ids[0] ?? "n1",
              priority: rules.length + 1,
            },
          ])
        }
      >
        + 조건
      </button>
    </span>
  );
}
