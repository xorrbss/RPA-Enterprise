import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useApiClient } from "../../api/context";
import type { WorkerPoolItem, WorkerPoolPriority, WorkerPoolStatus } from "../../api/types";
import { ActionButton } from "../../components/ActionButton";
import { errorLabel } from "../../components/badges";

const PRIORITIES: readonly { value: WorkerPoolPriority; label: string }[] = [
  { value: "low", label: "낮음" },
  { value: "medium", label: "보통" },
  { value: "high", label: "높음" },
  { value: "critical", label: "긴급" },
];

export function WorkerPoolPanel(): JSX.Element | null {
  const api = useApiClient();
  const q = useQuery({
    queryKey: ["worker-pools"],
    queryFn: () => api.listWorkerPools(),
    refetchInterval: 15_000,
  });
  if (q.isLoading || q.data === undefined) return null;
  const { items, assigned_pool_key, pending } = q.data;
  const oldestQueuedMs =
    pending.oldest_queued_at !== null ? Date.now() - new Date(pending.oldest_queued_at).getTime() : 0;
  const stuckHint = assigned_pool_key !== null && pending.queued_runs > 0 && oldestQueuedMs > 5 * 60 * 1000;

  return (
    <section className="panel" aria-label="전용 워커 풀" style={{ marginBottom: 12 }}>
      <div className="panel-head">
        <h2>전용 워커 풀</h2>
        <span className="badge blue">{items.length}개 풀</span>
      </div>

      <p style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span className="subtle">현재 테넌트 배정:</span>
        {assigned_pool_key === null ? (
          <span className="badge">기본(default)</span>
        ) : (
          <>
            <span className="badge green">{assigned_pool_key}</span>
            <ActionButton
              label="배정 해제"
              confirmText="이 테넌트의 워커 풀 배정을 해제할까요?"
              action="worker_pool.manage"
              successText="해제됨"
              invalidateKeys={[["worker-pools"]]}
              run={(key) => api.unassignWorkerPool(key)}
            />
          </>
        )}
      </p>

      {pending.queued_runs > 0 && (
        <p style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span className="subtle">대기 실행:</span>
          <span className={`badge ${stuckHint ? "amber" : ""}`}>
            {pending.queued_runs}건
            {oldestQueuedMs > 0 ? ` · 가장 오래된 대기 ${Math.floor(oldestQueuedMs / 60000)}분` : ""}
          </span>
          {stuckHint && <span className="subtle">배정 풀의 worker, drain/disable 상태, WORKER_POOL_KEYS를 확인하세요.</span>}
        </p>
      )}

      <WorkerPoolCreateForm />

      {items.length === 0 ? (
        <p className="subtle">등록된 전용 풀이 없습니다.</p>
      ) : (
        <div className="table-wrap">
          <table className="ops-table">
            <thead>
              <tr>
                <th scope="col">풀</th>
                <th scope="col">상태</th>
                <th scope="col">동시성</th>
                <th scope="col">Priority</th>
                <th scope="col">설명</th>
                <th scope="col">관리</th>
              </tr>
            </thead>
            <tbody>
              {items.map((p) => (
                <tr key={p.pool_key}>
                  <td>
                    <code className="subtle">{p.pool_key}</code>
                    {assigned_pool_key === p.pool_key && <span className="badge green" style={{ marginLeft: 6 }}>배정됨</span>}
                    <div className="subtle" style={{ fontSize: 11 }}>수정: {p.updated_by ?? "-"} · {dateShort(p.updated_at)}</div>
                  </td>
                  <td><span className={`badge ${statusTone(p.status)}`}>{statusLabel(p.status)}</span></td>
                  <td>{p.max_concurrency}</td>
                  <td>{priorityLabel(p.priority)}</td>
                  <td>{p.description ?? <span className="subtle">-</span>}</td>
                  <td>
                    <WorkerPoolControls key={`${p.pool_key}:${p.updated_at}`} pool={p} assigned={assigned_pool_key === p.pool_key} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function WorkerPoolCreateForm(): JSX.Element {
  const api = useApiClient();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [poolKey, setPoolKey] = useState("");
  const [description, setDescription] = useState("");
  const [maxConcurrency, setMaxConcurrency] = useState(1);
  const [priority, setPriority] = useState<WorkerPoolPriority>("medium");
  const [msg, setMsg] = useState<{ tone: "green" | "red"; text: string } | null>(null);

  const create = useMutation({
    mutationFn: () =>
      api.createWorkerPool(
        {
          pool_key: poolKey.trim(),
          ...(description.trim() !== "" ? { description: description.trim() } : {}),
          max_concurrency: Math.max(1, Math.floor(maxConcurrency)),
          priority,
        },
        crypto.randomUUID(),
      ),
    onSuccess: () => {
      setMsg({ tone: "green", text: "생성됨" });
      setPoolKey("");
      setDescription("");
      setMaxConcurrency(1);
      setPriority("medium");
      void qc.invalidateQueries({ queryKey: ["worker-pools"] });
    },
    onError: (e) => setMsg({ tone: "red", text: errorLabel(e) }),
  });

  const keyTrim = poolKey.trim();
  const keyValid = /^[a-z0-9][a-z0-9_-]{0,62}$/.test(keyTrim) && keyTrim !== "default";

  return (
    <section className="panel" style={{ padding: 12, marginBottom: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
        <strong>풀 만들기</strong>
        <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
          {msg !== null && <span className={`badge ${msg.tone}`}>{msg.text}</span>}
          <button className="btn" type="button" onClick={() => { setMsg(null); setOpen((v) => !v); }}>
            {open ? "닫기" : "풀 만들기"}
          </button>
        </span>
      </div>
      {open && (
        <div style={{ display: "grid", gridTemplateColumns: "minmax(180px, 1fr) minmax(160px, 2fr) 110px 120px auto", gap: 8, marginTop: 10, alignItems: "end" }}>
          <label style={{ display: "grid", gap: 4 }}>
            <span className="subtle">풀 키</span>
            <input value={poolKey} onChange={(e) => setPoolKey(e.target.value)} placeholder="sensitive-finance" style={{ fontFamily: "monospace" }} />
          </label>
          <label style={{ display: "grid", gap: 4 }}>
            <span className="subtle">설명</span>
            <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="재무 민감 업무 전용" />
          </label>
          <label style={{ display: "grid", gap: 4 }}>
            <span className="subtle">동시성</span>
            <input type="number" min={1} value={maxConcurrency} onChange={(e) => setMaxConcurrency(Number(e.target.value))} />
          </label>
          <label style={{ display: "grid", gap: 4 }}>
            <span className="subtle">Priority</span>
            <select value={priority} onChange={(e) => setPriority(e.target.value as WorkerPoolPriority)}>
              {PRIORITIES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
            </select>
          </label>
          <button className="btn primary" type="button" disabled={!keyValid || create.isPending} onClick={() => create.mutate()}>
            {create.isPending ? "생성 중…" : "생성"}
          </button>
        </div>
      )}
    </section>
  );
}

function WorkerPoolControls(props: { pool: WorkerPoolItem; assigned: boolean }): JSX.Element {
  const api = useApiClient();
  const qc = useQueryClient();
  const [description, setDescription] = useState(props.pool.description ?? "");
  const [maxConcurrency, setMaxConcurrency] = useState(props.pool.max_concurrency);
  const [priority, setPriority] = useState<WorkerPoolPriority>(props.pool.priority);
  const [workerId, setWorkerId] = useState("");
  const [msg, setMsg] = useState<{ tone: "green" | "red"; text: string } | null>(null);

  const save = useMutation({
    mutationFn: () =>
      api.updateWorkerPool(
        props.pool.pool_key,
        {
          description: description.trim() !== "" ? description.trim() : null,
          max_concurrency: Math.max(1, Math.floor(maxConcurrency)),
          priority,
        },
        crypto.randomUUID(),
      ),
    onSuccess: () => {
      setMsg({ tone: "green", text: "저장됨" });
      void qc.invalidateQueries({ queryKey: ["worker-pools"] });
    },
    onError: (e) => setMsg({ tone: "red", text: errorLabel(e) }),
  });

  const assignWorker = useMutation({
    mutationFn: () => api.assignWorkerToPool(props.pool.pool_key, workerId.trim(), crypto.randomUUID()),
    onSuccess: () => {
      setMsg({ tone: "green", text: "worker 배정됨" });
      setWorkerId("");
      void qc.invalidateQueries({ queryKey: ["worker-pools"] });
    },
    onError: (e) => setMsg({ tone: "red", text: errorLabel(e) }),
  });

  const removeWorker = useMutation({
    mutationFn: () => api.removeWorkerFromPool(props.pool.pool_key, workerId.trim(), crypto.randomUUID()),
    onSuccess: () => {
      setMsg({ tone: "green", text: "worker 제거됨" });
      setWorkerId("");
      void qc.invalidateQueries({ queryKey: ["worker-pools"] });
    },
    onError: (e) => setMsg({ tone: "red", text: errorLabel(e) }),
  });

  const workerIdValid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(workerId.trim());
  const workerSummary = props.pool.workers;

  return (
    <div style={{ display: "grid", gap: 8, minWidth: 420 }}>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(140px, 1fr) 90px 110px auto", gap: 6, alignItems: "end" }}>
        <label style={{ display: "grid", gap: 4 }}>
          <span className="subtle">설명</span>
          <input value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
        <label style={{ display: "grid", gap: 4 }}>
          <span className="subtle">동시성</span>
          <input type="number" min={1} value={maxConcurrency} onChange={(e) => setMaxConcurrency(Number(e.target.value))} />
        </label>
        <label style={{ display: "grid", gap: 4 }}>
          <span className="subtle">Priority</span>
          <select value={priority} onChange={(e) => setPriority(e.target.value as WorkerPoolPriority)}>
            {PRIORITIES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
          </select>
        </label>
        <button className="btn" type="button" disabled={save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? "저장 중…" : "저장"}
        </button>
      </div>
      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
        {msg !== null && <span className={`badge ${msg.tone}`}>{msg.text}</span>}
        {workerSummary !== undefined && (
          <span className="badge blue">
            worker {workerSummary.active}/{workerSummary.total}
            {workerSummary.stale > 0 ? ` · stale ${workerSummary.stale}` : ""}
          </span>
        )}
        <PoolStatusButton pool={props.pool} status="active" label="활성화" disabled={props.pool.status === "active"} />
        <PoolStatusButton pool={props.pool} status="draining" label="Drain" disabled={props.pool.status === "draining"} />
        <PoolStatusButton pool={props.pool} status="disabled" label="비활성화" disabled={props.pool.status === "disabled"} />
        {!props.assigned && (
          <ActionButton
            label="이 테넌트에 배정"
            confirmText={`이 테넌트를 '${props.pool.pool_key}' 풀에 배정할까요?`}
            action="worker_pool.manage"
            successText="배정됨"
            invalidateKeys={[["worker-pools"]]}
            run={(key) => api.assignWorkerPool(props.pool.pool_key, key)}
          />
        )}
        <ActionButton
          label="삭제"
          confirmText={`'${props.pool.pool_key}' 풀을 삭제할까요?`}
          action="worker_pool.manage"
          successText="삭제됨"
          invalidateKeys={[["worker-pools"]]}
          run={(key) => api.deleteWorkerPool(props.pool.pool_key, key)}
        />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(220px, 1fr) auto auto", gap: 6, alignItems: "end" }}>
        <label style={{ display: "grid", gap: 4 }}>
          <span className="subtle">Worker UUID</span>
          <input value={workerId} onChange={(e) => setWorkerId(e.target.value)} placeholder="00000000-0000-4000-8000-000000000000" />
        </label>
        <button className="btn" type="button" disabled={!workerIdValid || assignWorker.isPending} onClick={() => assignWorker.mutate()}>
          배정
        </button>
        <button className="btn" type="button" disabled={!workerIdValid || removeWorker.isPending} onClick={() => removeWorker.mutate()}>
          제거
        </button>
      </div>
      {workerSummary !== undefined && workerSummary.worker_ids.length > 0 && (
        <div className="subtle" style={{ fontSize: 11, wordBreak: "break-all" }}>
          {workerSummary.worker_ids.join(", ")}
        </div>
      )}
    </div>
  );
}

function PoolStatusButton(props: { pool: WorkerPoolItem; status: WorkerPoolStatus; label: string; disabled: boolean }): JSX.Element | null {
  const api = useApiClient();
  return (
    <ActionButton
      label={props.label}
      confirmText={`'${props.pool.pool_key}' 풀 상태를 ${statusLabel(props.status)}(으)로 변경할까요?`}
      action="worker_pool.manage"
      inputLabel="변경 사유"
      inputOptional
      disabled={props.disabled}
      successText="변경됨"
      invalidateKeys={[["worker-pools"]]}
      run={(key, reason) =>
        api.updateWorkerPool(
          props.pool.pool_key,
          {
            status: props.status,
            ...(reason !== undefined && reason.trim() !== "" ? { reason: reason.trim() } : {}),
          },
          key,
        )
      }
    />
  );
}

function statusLabel(status: WorkerPoolStatus): string {
  if (status === "active") return "활성";
  if (status === "draining") return "Drain";
  return "비활성";
}

function statusTone(status: WorkerPoolStatus): string {
  if (status === "active") return "green";
  if (status === "draining") return "amber";
  return "red";
}

function priorityLabel(priority: WorkerPoolPriority): string {
  return PRIORITIES.find((p) => p.value === priority)?.label ?? priority;
}

function dateShort(value: string | null | undefined): string {
  if (value == null) return "-";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toISOString().slice(0, 16).replace("T", " ");
}
