import type { DocumentExtraction, DocumentExtractionField, DocumentJobStatus } from "../../api/types";
import { ErrorState, desktopStateForError } from "../../components/states";
import { documentStatusLabel, documentStatusTone } from "./helpers";

export function ClassifiedErrorState({ error, message, onRetry }: { error: unknown; message: string; onRetry?: () => void }): JSX.Element {
  const state = desktopStateForError(error);
  return <ErrorState title={state.title} message={`${message} ${state.message}`} details={state.details} onRetry={onRetry} />;
}

export function DocumentStatusBadge(props: { status: DocumentJobStatus }): JSX.Element {
  return <span className={`badge ${documentStatusTone(props.status)}`}>{documentStatusLabel(props.status)}</span>;
}

export function DocumentExtractionStatusBadge(props: { status: DocumentExtraction["status"] }): JSX.Element {
  return <span className={`badge ${props.status === "completed" ? "green" : props.status === "failed" ? "red" : "amber"}`}>{props.status === "completed" ? "추출 완료" : props.status === "failed" ? "실패" : "검증 필요"}</span>;
}

export function FieldStatusBadge(props: { field: DocumentExtractionField }): JSX.Element {
  const label = props.field.status === "extracted" ? "확정" : props.field.status === "low_confidence" ? "검증 필요" : "누락";
  const tone = props.field.status === "extracted" ? "green" : "amber";
  return <span className={`badge ${tone}`}>{label}</span>;
}
