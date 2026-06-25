import { FileVideo, Image } from "lucide-react";

import type { ScenarioGenerationEvidence } from "../../api/types";
import { evidenceStorageStatusLabel, hasRequestedImageEvidence, hasRequestedVideoEvidence } from "./helpers";

export function EvidenceStorageChip({ policy }: { policy: ScenarioGenerationEvidence }): JSX.Element {
  return (
    <span className="evidence-chip" aria-label={`증거 저장 상태: ${evidenceStorageStatusLabel(policy)}`}>
      {hasRequestedImageEvidence(policy) && <Image size={14} aria-hidden="true" />}
      {hasRequestedVideoEvidence(policy) && <FileVideo size={14} aria-hidden="true" />}
      {evidenceStorageStatusLabel(policy)}
    </span>
  );
}

export function ReadinessBadge({ ready }: { ready: boolean }): JSX.Element {
  return <span className={`badge ${ready ? "green" : "amber"}`}>{ready ? "준비됨" : "필요"}</span>;
}
