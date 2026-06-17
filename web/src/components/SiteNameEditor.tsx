import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { useApiClient } from "../api/context";
import { useCan } from "../api/permissions";
import { ApiError } from "../api/types";
import type { SiteItem } from "../api/types";

// 사이트명 인라인 편집: 이름 클릭 → 입력칸(현재 이름 prefill) → 저장(PATCH /v1/sites/{id}, Idempotency-Key 1회 생성)
// → ["sites"] invalidate. 조용한 실패 금지: 오류는 ApiError 코드로 인라인 표면화. site.update 권한 없으면 일반
// 텍스트로만 표시(클릭 불가; 최종 강제는 백엔드). Enter=저장 / Esc=취소.
export function SiteNameEditor(props: { site: SiteItem }): JSX.Element {
  const { site } = props;
  const api = useApiClient();
  const can = useCan();
  const qc = useQueryClient();
  const display = site.name ?? site.site_profile_id.slice(0, 8);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(site.name ?? "");
  const [msg, setMsg] = useState<{ tone: "green" | "red"; text: string } | null>(null);
  const mut = useMutation({
    mutationFn: (name: string) => api.updateSite(site.site_profile_id, name, crypto.randomUUID()),
    onSuccess: () => {
      setEditing(false);
      void qc.invalidateQueries({ queryKey: ["sites"] });
    },
    onError: (e) => setMsg({ tone: "red", text: e instanceof ApiError ? `${e.code} (${e.httpStatus})` : "실패" }),
  });

  // 권한 없으면 평문(읽기 전용 역할은 편집 트리거를 노출하지 않는다).
  if (!can("site.update")) return <span>{display}</span>;

  if (!editing) {
    return (
      <button
        type="button"
        title="이름 수정 (클릭)"
        style={{
          background: "none",
          border: "none",
          padding: 0,
          color: "inherit",
          font: "inherit",
          cursor: "pointer",
          textDecoration: "underline dotted",
          textUnderlineOffset: 3,
        }}
        onClick={() => {
          setMsg(null);
          setValue(site.name ?? "");
          setEditing(true);
        }}
      >
        {display}
      </button>
    );
  }

  const submit = (): void => {
    const next = value.trim();
    if (next === "" || next === (site.name ?? "")) {
      // 빈 값/무변경은 저장하지 않고 편집만 종료(불필요 요청·422 회피).
      setEditing(false);
      return;
    }
    mut.mutate(next);
  };

  return (
    <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
      <input
        aria-label="사이트 이름"
        value={value}
        autoFocus
        disabled={mut.isPending}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
          else if (e.key === "Escape") setEditing(false);
        }}
      />
      <button type="button" className="btn" disabled={mut.isPending} onClick={submit}>
        {mut.isPending ? "저장 중…" : "저장"}
      </button>
      <button type="button" className="btn" disabled={mut.isPending} onClick={() => setEditing(false)}>
        취소
      </button>
      {msg !== null && <span className={`badge ${msg.tone}`} role="alert">{msg.text}</span>}
    </span>
  );
}
