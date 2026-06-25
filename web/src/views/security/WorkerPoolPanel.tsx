import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useApiClient } from "../../api/context";
import { ActionButton } from "../../components/ActionButton";
import { errorLabel } from "../../components/badges";

// DG-3 전용 워커 풀(admin worker_pool.manage). 풀 레지스트리 + 현재 테넌트 배정 관리. 테넌트를 전용 풀에
// 배정하면 그 테넌트의 실행이 해당 풀을 서비스하는 워커에서만 처리된다(민감 테넌트 격리). 미배정=기본(default,
// 모든 워커). 라우팅은 백엔드 enqueue flag + 워커 forbiddenFlags 가 수행. 게이트는 SecurityView 에서 적용.
export function WorkerPoolPanel(): JSX.Element | null {
  const api = useApiClient();
  const q = useQuery({
    queryKey: ["worker-pools"],
    queryFn: () => api.listWorkerPools(),
    refetchInterval: 15_000,
  });
  if (q.isLoading || q.data === undefined) return null;
  const { items, assigned_pool_key, pending } = q.data;
  // 지연 힌트: 전용 풀 배정 + queued 가 5분 이상 쌓이면 워커 부재/포화 가능성을 정직하게 표기(단정 아님).
  const STUCK_THRESHOLD_MS = 5 * 60 * 1000;
  const oldestQueuedMs =
    pending.oldest_queued_at !== null ? Date.now() - new Date(pending.oldest_queued_at).getTime() : 0;
  const stuckHint = assigned_pool_key !== null && pending.queued_runs > 0 && oldestQueuedMs > STUCK_THRESHOLD_MS;
  return (
    <section className="panel" aria-label="전용 워커 풀" style={{ marginBottom: 12 }}>
      <div className="panel-head">
        <h2>전용 워커 풀</h2>
        <span className="badge blue">{items.length}개 풀</span>
      </div>
      <p className="subtle">
        테넌트를 전용 워커 풀에 배정하면 그 테넌트의 실행이 해당 풀을 맡은 워커에서만 처리됩니다(민감 테넌트 격리).
        배정하지 않으면 모든 워커가 처리하는 기본 풀로 실행됩니다.
      </p>
      <p style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span className="subtle">현재 이 테넌트 배정:</span>
        {assigned_pool_key === null ? (
          <span className="badge">기본(default) · 모든 워커</span>
        ) : (
          <>
            <span className="badge green">{assigned_pool_key}</span>
            <ActionButton
              label="배정 해제"
              confirmText="이 테넌트의 풀 배정을 해제할까요? (기본 풀로 돌아갑니다)"
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
          <span className="subtle">대기 중 실행:</span>
          <span className={`badge ${stuckHint ? "amber" : ""}`}>
            {pending.queued_runs}건
            {oldestQueuedMs > 0 ? ` · 가장 오래된 ${Math.floor(oldestQueuedMs / 60000)}분 대기` : ""}
          </span>
          {stuckHint && (
            <span className="subtle">⚠ 이 풀을 서비스하는 워커가 없거나 포화일 수 있습니다 — 워커 배치/WORKER_POOL_KEYS를 확인하세요.</span>
          )}
        </p>
      )}
      <WorkerPoolCreateForm />
      {items.length === 0 ? (
        <p className="subtle">등록된 전용 풀이 없습니다. 풀을 만들고 워커를 그 풀에 배치한 뒤 테넌트를 배정하세요.</p>
      ) : (
        <div className="table-wrap">
          <table className="ops-table">
            <thead>
              <tr>
                <th scope="col">풀 키</th>
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
                  </td>
                  <td>{p.description ?? <span className="subtle">—</span>}</td>
                  <td style={{ display: "flex", gap: 6 }}>
                    {assigned_pool_key !== p.pool_key && (
                      <ActionButton
                        label="이 풀에 배정"
                        confirmText={`이 테넌트를 '${p.pool_key}' 풀에 배정할까요?`}
                        action="worker_pool.manage"
                        successText="배정됨"
                        invalidateKeys={[["worker-pools"]]}
                        run={(key) => api.assignWorkerPool(p.pool_key, key)}
                      />
                    )}
                    <ActionButton
                      label="삭제"
                      confirmText={`'${p.pool_key}' 풀을 삭제할까요? (배정된 테넌트가 있으면 먼저 해제해야 합니다)`}
                      action="worker_pool.manage"
                      successText="삭제됨"
                      invalidateKeys={[["worker-pools"]]}
                      run={(key) => api.deleteWorkerPool(p.pool_key, key)}
                    />
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

// 풀 생성 폼(admin). pool_key = 소문자 영숫자+_-, 'default' 예약.
function WorkerPoolCreateForm(): JSX.Element {
  const api = useApiClient();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [poolKey, setPoolKey] = useState("");
  const [description, setDescription] = useState("");
  const [msg, setMsg] = useState<{ tone: "green" | "red"; text: string } | null>(null);

  const create = useMutation({
    mutationFn: () =>
      api.createWorkerPool(
        { pool_key: poolKey.trim(), ...(description.trim() !== "" ? { description: description.trim() } : {}) },
        crypto.randomUUID(),
      ),
    onSuccess: () => {
      setMsg({ tone: "green", text: "생성됨" });
      setPoolKey("");
      setDescription("");
      void qc.invalidateQueries({ queryKey: ["worker-pools"] });
    },
    onError: (e) => setMsg({ tone: "red", text: errorLabel(e) }),
  });

  const keyTrim = poolKey.trim();
  const keyValid = /^[a-z0-9][a-z0-9_-]{0,62}$/.test(keyTrim) && keyTrim !== "default";

  return (
    <section className="panel" style={{ padding: 12, marginBottom: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
        <strong>전용 풀 만들기</strong>
        <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
          {msg !== null && <span className={`badge ${msg.tone}`}>{msg.text}</span>}
          <button className="btn" type="button" onClick={() => { setMsg(null); setOpen((v) => !v); }}>
            {open ? "닫기" : "풀 만들기"}
          </button>
        </span>
      </div>
      {open && (
        <div style={{ display: "grid", gap: 8, marginTop: 10, maxWidth: 520 }}>
          <label style={{ display: "grid", gap: 4 }}>
            <span className="subtle">풀 키</span>
            <input
              value={poolKey}
              onChange={(e) => setPoolKey(e.target.value)}
              placeholder="예: sensitive-finance"
              style={{ fontFamily: "monospace" }}
            />
            <span className="subtle">소문자 영숫자와 -, _ 만. (default 는 기본 풀이라 사용할 수 없습니다.)</span>
          </label>
          <label style={{ display: "grid", gap: 4 }}>
            <span className="subtle">설명 (선택)</span>
            <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="예: 재무 민감 업무 전용" />
          </label>
          <div>
            <button className="btn primary" type="button" disabled={!keyValid || create.isPending} onClick={() => create.mutate()}>
              {create.isPending ? "생성 중…" : "생성"}
            </button>
            {!keyValid && <span className="subtle" style={{ marginLeft: 8 }}>소문자 영숫자/-/_ 형식의 풀 키를 입력하세요.</span>}
          </div>
        </div>
      )}
    </section>
  );
}
