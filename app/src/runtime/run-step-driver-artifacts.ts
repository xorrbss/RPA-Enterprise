// run-step-driver.ts 에서 추출 — outcome→artifact 매핑 + run-video/merged-extract artifact append +
// artifact-lifecycle 잡 enqueue(동작 무변경). 전부 leaf(drive 코어 미호출), drive 가 역import.
import type { PoolClient } from "pg";

import type {
  RunVideoRecording,
  RuntimeWorkerJob,
  VisualEvidenceVideoPolicy,
} from "../../../ts/runtime-contract";
import type { ScenarioOutcome } from "./ir-interpreter";
import type { MergedExtractArtifactSink } from "./merged-extract-artifact";
import type { ClaimedRun, DriveDeps } from "./run-step-driver";

export function videoPolicyFromIr(irDoc: unknown): VisualEvidenceVideoPolicy | undefined {
  if (!isRecord(irDoc)) return undefined;
  const meta = irDoc.meta;
  if (!isRecord(meta)) return undefined;
  const evidence = meta.evidence;
  if (!isRecord(evidence)) return undefined;
  const video = evidence.video;
  if (video === "always" || video === "failure") return video;
  return undefined;
}

export function systemFailureOutcome(): ScenarioOutcome {
  return { terminal: "fail_system", visited: [], steps: [], artifacts: [] };
}

export function visualEvidenceLifecycleEnqueuerRequired(deps: DriveDeps): boolean {
  return deps.visualEvidenceRecorder !== undefined || deps.visualEvidenceVideoRecorder !== undefined;
}


export async function appendRunVideoArtifact(
  outcome: ScenarioOutcome,
  recording: RunVideoRecording | undefined,
  policy: VisualEvidenceVideoPolicy | undefined,
): Promise<ScenarioOutcome> {
  if (recording === undefined || policy === undefined) return outcome;
  if (policy === "failure" && (outcome.terminal === "success" || outcome.terminal === "success_empty")) {
    await recording.discard({ reason: "terminal_success" });
    return outcome;
  }
  const artifactRef = await recording.stopAndPersist({ terminal: knownTerminal(outcome.terminal) });
  if (artifactRef === undefined) return outcome;
  return { ...outcome, artifacts: [...outcome.artifacts, artifactRef] };
}

export async function appendMergedExtractArtifact(
  outcome: ScenarioOutcome,
  sink: MergedExtractArtifactSink | undefined,
  run: ClaimedRun,
): Promise<ScenarioOutcome> {
  if (sink === undefined || outcome.mergedExtract === undefined) return outcome;
  const artifactRef = await sink.put({
    tenantId: run.tenantId,
    runId: run.runId,
    correlationId: run.correlationId,
    extractPages: outcome.extractPages ?? [],
    mergedExtract: outcome.mergedExtract,
  });
  return { ...outcome, artifacts: [...outcome.artifacts, artifactRef] };
}

export function knownTerminal(terminal: string): "success" | "success_empty" | "fail_business" | "fail_system" | "suspend" {
  if (
    terminal === "success" ||
    terminal === "success_empty" ||
    terminal === "fail_business" ||
    terminal === "fail_system" ||
    terminal === "suspend"
  ) {
    return terminal;
  }
  throw new Error(`driveScenario: terminal '${terminal}' cannot finalize run video evidence`);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function enqueueArtifactLifecycleJobsForOutcome(
  client: PoolClient,
  run: ClaimedRun,
  deps: DriveDeps,
  outcome: ScenarioOutcome,
): Promise<void> {
  const artifactRefs = [...new Set(outcome.artifacts)];
  if (artifactRefs.length === 0) return;
  const enqueuer = deps.runtimeJobEnqueuer;
  if (enqueuer === undefined) {
    throw new Error("driveScenario: artifacts produced on direct run-drive require RuntimeJobEnqueuePort for lifecycle jobs");
  }
  const jobs: RuntimeWorkerJob[] = [
    ...artifactRefs.map((artifactRef): RuntimeWorkerJob => ({
      kind: "artifact_redaction",
      tenantId: run.tenantId as RuntimeWorkerJob["tenantId"],
      runId: run.runId as RuntimeWorkerJob["runId"],
      artifactId: artifactRef as RuntimeWorkerJob["artifactId"],
      correlationId: run.correlationId as RuntimeWorkerJob["correlationId"],
    })),
    {
      kind: "artifact_retention",
      tenantId: run.tenantId as RuntimeWorkerJob["tenantId"],
      correlationId: run.correlationId as RuntimeWorkerJob["correlationId"],
    },
  ];
  for (const job of jobs) {
    await enqueuer.enqueueRuntimeJob(client, job);
  }
}

