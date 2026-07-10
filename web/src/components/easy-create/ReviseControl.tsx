import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useApiClient } from "../../api/context";
import { navigate } from "../../router";
import { errorLabel } from "../badges";
import { ApiError, type ScenarioGenerationReviseRequest, type ScenarioGenerationResult } from "../../api/types";

// F2: 말로 고치기 입력(설계 §2.1~§2.3) — 초안 직후(GenerationResult)와 저장된 자동화(FocusedScenarioStudio
// 설계 탭) 두 표면이 같은 컴포넌트를 쓴다. base_version은 화면이 공유하는 scenario-detail 쿼리의 version이며
// 서버가 head와 대조한다(불일치=409, PUT If-Match 규율과 동형). 실패·비활성 사유는 항상 문장으로 표기한다
// (조용한 비활성·미노출 금지).

const NOT_PERSISTED_MESSAGE =
  "이 초안은 아직 자동화로 저장되지 않아 말로 고치기를 쓸 수 없습니다. 먼저 저장한 뒤 다시 시도해 주세요.";

export function ReviseControl({
  generationId,
  scenarioId,
  onRevised,
}: {
  readonly generationId: string;
  readonly scenarioId: string | null;
  readonly onRevised: (next: ScenarioGenerationResult) => void;
}): JSX.Element {
  const api = useApiClient();
  const qc = useQueryClient();
  const [instruction, setInstruction] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [promptNotRetained, setPromptNotRetained] = useState(false);

  // 현재 버전 조회 — 스튜디오 설계 탭(DesignStepCards)과 같은 쿼리키를 공유해 화면이 본 버전과 일치시킨다.
  const detail = useQuery({
    queryKey: ["scenario-detail", scenarioId],
    queryFn: () => api.getScenario(scenarioId as string),
    enabled: scenarioId !== null && !promptNotRetained,
  });

  const mutation = useMutation({
    mutationFn: (body: ScenarioGenerationReviseRequest) =>
      api.reviseScenarioGeneration(generationId, body, crypto.randomUUID()),
    onSuccess: (next) => {
      setInstruction("");
      setError(null);
      setConflict(false);
      void qc.invalidateQueries({ queryKey: ["scenarios"] });
      void qc.invalidateQueries({ queryKey: ["scenario-generations"] });
      void qc.invalidateQueries({ queryKey: ["scenario-detail", scenarioId] });
      qc.setQueryData(["scenario-generation", next.generation_id], next);
      onRevised(next);
    },
    onError: (e) => {
      if (e instanceof ApiError && e.code === "SCENARIO_VERSION_CONFLICT") {
        setConflict(true);
        return;
      }
      if (e instanceof ApiError && e.code === "IR_SCHEMA_INVALID") {
        const reason = typeof e.body?.details?.reason === "string" ? e.body.details.reason : null;
        if (reason === "prompt_not_retained") {
          setPromptNotRetained(true);
          return;
        }
        if (reason === "scenario_not_persisted") {
          setError(NOT_PERSISTED_MESSAGE);
          return;
        }
        if (reason === "instruction_required") {
          setError("수정할 내용을 입력해 주세요.");
          return;
        }
      }
      setError(errorLabel(e));
    },
  });

  if (scenarioId === null) {
    return (
      <p className="subtle revise-control-note" role="note">
        {NOT_PERSISTED_MESSAGE}
      </p>
    );
  }

  if (promptNotRetained) {
    return (
      <div className="revise-control" aria-label="말로 고치기 사용 불가 안내">
        <p className="form-alert amber" role="note">
          이 자동화는 원본 요청이 저장되기 전에 만들어져 말로 고치기를 쓸 수 없습니다. 요청을 새로 입력해 다시
          만들어 주세요.
        </p>
        <button className="linklike" type="button" onClick={() => navigate("create")}>
          만들기 홈으로
        </button>
      </div>
    );
  }

  function submit(): void {
    setError(null);
    setConflict(false);
    const text = instruction.trim();
    if (text.length === 0) {
      setError("수정할 내용을 입력해 주세요.");
      return;
    }
    const version = detail.data?.version;
    if (version === undefined) {
      setError("자동화의 현재 버전을 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.");
      return;
    }
    mutation.mutate({ instruction: text, base_version: version });
  }

  return (
    <div className="revise-control" aria-label="말로 고치기">
      <strong>말로 고치기</strong>
      <div className="revise-control-row">
        <textarea
          rows={1}
          maxLength={2000}
          value={instruction}
          placeholder="예: 로그인한 다음 화면을 저장하는 단계도 넣어줘"
          aria-label="수정 요청 입력"
          disabled={mutation.isPending}
          onChange={(e) => setInstruction(e.target.value)}
        />
        <button className="btn" type="button" onClick={submit} disabled={mutation.isPending}>
          {mutation.isPending ? "고치는 중" : "말로 고치기"}
        </button>
      </div>
      {mutation.isPending && <span className="subtle">요청을 반영해 새 초안을 만드는 중입니다.</span>}
      {error !== null && (
        <p className="form-alert red" role="alert">
          {error}
        </p>
      )}
      {conflict && (
        <div className="form-alert amber" role="alert">
          다른 곳에서 이 자동화가 먼저 수정되었습니다. 최신 내용을 불러온 뒤 다시 시도해 주세요.
          <button
            className="linklike"
            type="button"
            onClick={() => {
              setConflict(false);
              void qc.invalidateQueries({ queryKey: ["scenario-detail", scenarioId] });
            }}
          >
            최신 내용 다시 불러오기
          </button>
        </div>
      )}
    </div>
  );
}
