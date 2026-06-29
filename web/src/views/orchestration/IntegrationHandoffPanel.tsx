import { useState, type FormEvent } from "react";

import type { IntegrationHandoff, IntegrationHandoffReceiptStatus } from "../../api/types";
import { formatDateTime } from "./format";

export interface IntegrationHandoffCreateDraft {
  readonly providerAlias: string;
  readonly jobRef: string;
  readonly payloadRef: string;
  readonly callbackUrlSecretRef: string | null;
  readonly callbackSignatureSecretRef: string | null;
  readonly legalHold: boolean;
}

export interface IntegrationHandoffReceiptDraft {
  readonly externalJobId: string;
  readonly status: IntegrationHandoffReceiptStatus;
  readonly receiptId: string;
  readonly errorCode: string | null;
  readonly legalHold: boolean;
}

export interface IntegrationHandoffDispatchDraft {
  readonly endpointSecretRef: string;
  readonly allowedHosts: readonly string[];
  readonly maxAttempts: number;
  readonly legalHold: boolean;
}

interface HandoffProviderProfile {
  readonly id: string;
  readonly label: string;
  readonly alias: string;
  readonly callbackUrlSecretRef: string;
  readonly callbackSignatureSecretRef: string;
  readonly dispatchEndpointSecretRef: string;
  readonly allowedHosts: string;
}

const HANDOFF_PROVIDER_PROFILES: readonly HandoffProviderProfile[] = [
  {
    id: "owner-defined",
    label: "Owner-defined existing RPA",
    alias: "existing-rpa-primary",
    callbackUrlSecretRef: "secret://tenant-a/integration/existing-rpa/callback-url",
    callbackSignatureSecretRef: "secret://tenant-a/integration/existing-rpa/callback-signing",
    dispatchEndpointSecretRef: "secret://tenant-a/integration/existing-rpa/dispatch-endpoint",
    allowedHosts: "rpa-provider.example.com",
  },
  {
    id: "uipath",
    label: "UiPath provider profile",
    alias: "uipath-primary",
    callbackUrlSecretRef: "secret://tenant-a/integration/uipath/callback-url",
    callbackSignatureSecretRef: "secret://tenant-a/integration/uipath/callback-signing",
    dispatchEndpointSecretRef: "secret://tenant-a/integration/uipath/dispatch-endpoint",
    allowedHosts: "uipath.example.com",
  },
  {
    id: "automation-anywhere",
    label: "Automation Anywhere provider profile",
    alias: "automation-anywhere-primary",
    callbackUrlSecretRef: "secret://tenant-a/integration/automation-anywhere/callback-url",
    callbackSignatureSecretRef: "secret://tenant-a/integration/automation-anywhere/callback-signing",
    dispatchEndpointSecretRef: "secret://tenant-a/integration/automation-anywhere/dispatch-endpoint",
    allowedHosts: "automation-anywhere.example.com",
  },
  {
    id: "power-automate",
    label: "Power Automate provider profile",
    alias: "power-automate-primary",
    callbackUrlSecretRef: "secret://tenant-a/integration/power-automate/callback-url",
    callbackSignatureSecretRef: "secret://tenant-a/integration/power-automate/callback-signing",
    dispatchEndpointSecretRef: "secret://tenant-a/integration/power-automate/dispatch-endpoint",
    allowedHosts: "power-automate.example.com",
  },
  {
    id: "blue-prism",
    label: "Blue Prism provider profile",
    alias: "blue-prism-primary",
    callbackUrlSecretRef: "secret://tenant-a/integration/blue-prism/callback-url",
    callbackSignatureSecretRef: "secret://tenant-a/integration/blue-prism/callback-signing",
    dispatchEndpointSecretRef: "secret://tenant-a/integration/blue-prism/dispatch-endpoint",
    allowedHosts: "blue-prism.example.com",
  },
];

const DEFAULT_HANDOFF_PROVIDER_PROFILE = HANDOFF_PROVIDER_PROFILES[0] as HandoffProviderProfile;

export function IntegrationHandoffPanel({
  handoffs,
  isLoading,
  isError,
  canCreate,
  isCreating,
  createError,
  onCreate,
  canDispatch,
  dispatchingHandoffId,
  dispatchErrorHandoffId,
  onDispatch,
  canRecordReceipt,
  recordingHandoffId,
  receiptErrorHandoffId,
  onRecordReceipt,
}: {
  handoffs: readonly IntegrationHandoff[];
  isLoading: boolean;
  isError: boolean;
  canCreate: boolean;
  isCreating: boolean;
  createError: boolean;
  onCreate: (draft: IntegrationHandoffCreateDraft) => void;
  canDispatch: boolean;
  dispatchingHandoffId: string | null;
  dispatchErrorHandoffId: string | null;
  onDispatch: (handoff: IntegrationHandoff, draft: IntegrationHandoffDispatchDraft) => void;
  canRecordReceipt: boolean;
  recordingHandoffId: string | null;
  receiptErrorHandoffId: string | null;
  onRecordReceipt: (handoff: IntegrationHandoff, draft: IntegrationHandoffReceiptDraft) => void;
}): JSX.Element {
  return (
    <div className="ops-column">
      <div className="ops-alert-center-head">
        <h3>Existing RPA handoff</h3>
        <span className="badge muted">{isLoading ? "Loading" : `${handoffs.length} shown`}</span>
      </div>
      {canCreate && (
        <IntegrationHandoffCreateForm
          isCreating={isCreating}
          hasError={createError}
          onCreate={onCreate}
        />
      )}
      <IntegrationHandoffList
        handoffs={handoffs}
        isError={isError}
        canDispatch={canDispatch}
        dispatchingHandoffId={dispatchingHandoffId}
        dispatchErrorHandoffId={dispatchErrorHandoffId}
        onDispatch={onDispatch}
        canRecordReceipt={canRecordReceipt}
        recordingHandoffId={recordingHandoffId}
        receiptErrorHandoffId={receiptErrorHandoffId}
        onRecordReceipt={onRecordReceipt}
      />
    </div>
  );
}

function IntegrationHandoffCreateForm({
  isCreating,
  hasError,
  onCreate,
}: {
  isCreating: boolean;
  hasError: boolean;
  onCreate: (draft: IntegrationHandoffCreateDraft) => void;
}): JSX.Element {
  const [providerProfileId, setProviderProfileId] = useState(DEFAULT_HANDOFF_PROVIDER_PROFILE.id);
  const [providerAlias, setProviderAlias] = useState(DEFAULT_HANDOFF_PROVIDER_PROFILE.alias);
  const [jobRef, setJobRef] = useState("queue:invoice-posting");
  const [payloadRef, setPayloadRef] = useState("artifact://handoff/invoice-posting-001");
  const [callbackUrlSecretRef, setCallbackUrlSecretRef] = useState(DEFAULT_HANDOFF_PROVIDER_PROFILE.callbackUrlSecretRef);
  const [callbackSignatureSecretRef, setCallbackSignatureSecretRef] = useState(DEFAULT_HANDOFF_PROVIDER_PROFILE.callbackSignatureSecretRef);
  const [legalHold, setLegalHold] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);

  function selectProviderProfile(profileId: string): void {
    const profile = HANDOFF_PROVIDER_PROFILES.find((candidate) => candidate.id === profileId) ?? DEFAULT_HANDOFF_PROVIDER_PROFILE;
    setProviderProfileId(profile.id);
    setProviderAlias(profile.alias);
    setCallbackUrlSecretRef(profile.callbackUrlSecretRef);
    setCallbackSignatureSecretRef(profile.callbackSignatureSecretRef);
  }

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const provider = providerAlias.trim();
    const job = jobRef.trim();
    const payload = payloadRef.trim();
    const callbackRef = callbackUrlSecretRef.trim();
    const callbackSignatureRef = callbackSignatureSecretRef.trim();
    if (provider.length === 0 || job.length === 0 || payload.length === 0) {
      setValidationError("Provider, job ref, and payload ref are required.");
      return;
    }
    if (callbackRef.length > 0 && !callbackRef.startsWith("secret://")) {
      setValidationError("Callback URL must be a SecretRef.");
      return;
    }
    if (callbackSignatureRef.length > 0 && !callbackSignatureRef.startsWith("secret://")) {
      setValidationError("Callback signature key must be a SecretRef.");
      return;
    }
    setValidationError(null);
    onCreate({
      providerAlias: provider,
      jobRef: job,
      payloadRef: payload,
      callbackUrlSecretRef: callbackRef.length === 0 ? null : callbackRef,
      callbackSignatureSecretRef: callbackSignatureRef.length === 0 ? null : callbackSignatureRef,
      legalHold,
    });
  }

  return (
    <form className="ops-webhook-form" onSubmit={submit}>
      <div className="form-grid ops-webhook-grid">
        <label className="field">
          Handoff provider profile
          <select aria-label="Handoff provider profile" value={providerProfileId} onChange={(event) => selectProviderProfile(event.target.value)}>
            {HANDOFF_PROVIDER_PROFILES.map((profile) => (
              <option key={profile.id} value={profile.id}>{profile.label}</option>
            ))}
          </select>
        </label>
        <label className="field">
          Handoff provider alias
          <input aria-label="Handoff provider" value={providerAlias} onChange={(event) => setProviderAlias(event.target.value)} />
        </label>
        <label className="field">
          Handoff job ref
          <input aria-label="Handoff job ref" value={jobRef} onChange={(event) => setJobRef(event.target.value)} />
        </label>
        <label className="field">
          Handoff payload ref
          <input aria-label="Handoff payload ref" value={payloadRef} onChange={(event) => setPayloadRef(event.target.value)} />
        </label>
        <label className="field">
          Handoff callback SecretRef
          <input aria-label="Handoff callback URL SecretRef" value={callbackUrlSecretRef} onChange={(event) => setCallbackUrlSecretRef(event.target.value)} />
        </label>
        <label className="field">
          Handoff signature SecretRef
          <input aria-label="Handoff callback signature SecretRef" value={callbackSignatureSecretRef} onChange={(event) => setCallbackSignatureSecretRef(event.target.value)} />
        </label>
      </div>
      <p className="subtle">Provider profiles are metadata-only handoff guides. Vendor API/OAuth, job mapping, and endpoint ownership remain owner/provider decisions; callback and dispatch material must stay SecretRef-only.</p>
      <div className="inline-actions">
        <label className="checkbox-inline">
          <input type="checkbox" checked={legalHold} onChange={(event) => setLegalHold(event.target.checked)} />
          Legal hold
        </label>
        <button className="btn" type="submit" disabled={isCreating}>
          {isCreating ? "Recording" : "Create handoff"}
        </button>
        {validationError !== null && <span className="form-alert red" role="alert">{validationError}</span>}
        {hasError && <span className="form-alert red" role="alert">Handoff request failed</span>}
      </div>
    </form>
  );
}

function IntegrationHandoffList({
  handoffs,
  isError,
  canDispatch,
  dispatchingHandoffId,
  dispatchErrorHandoffId,
  onDispatch,
  canRecordReceipt,
  recordingHandoffId,
  receiptErrorHandoffId,
  onRecordReceipt,
}: {
  handoffs: readonly IntegrationHandoff[];
  isError: boolean;
  canDispatch: boolean;
  dispatchingHandoffId: string | null;
  dispatchErrorHandoffId: string | null;
  onDispatch: (handoff: IntegrationHandoff, draft: IntegrationHandoffDispatchDraft) => void;
  canRecordReceipt: boolean;
  recordingHandoffId: string | null;
  receiptErrorHandoffId: string | null;
  onRecordReceipt: (handoff: IntegrationHandoff, draft: IntegrationHandoffReceiptDraft) => void;
}): JSX.Element {
  const [receiptFormHandoffId, setReceiptFormHandoffId] = useState<string | null>(null);
  const [dispatchFormHandoffId, setDispatchFormHandoffId] = useState<string | null>(null);

  if (isError) {
    return (
      <div className="ops-alert-empty" role="status">
        <strong>Handoff ledger unavailable</strong>
        <span className="subtle">Existing RPA handoff evidence could not be loaded.</span>
      </div>
    );
  }
  if (handoffs.length === 0) {
    return (
      <div className="ops-alert-empty" role="status">
        <strong>No handoff requests recorded</strong>
        <span className="subtle">External RPA completion is not inferred without a receipt.</span>
      </div>
    );
  }
  return (
    <ul className="ops-alert-list">
      {handoffs.map((handoff) => (
        <li key={handoff.handoff_id}>
          <div className="ops-alert-main">
            <div className="ops-alert-badges">
              <span className={`badge ${handoffTone(handoff.status)}`}>{handoff.status}</span>
              <span className="subtle">{handoff.provider_alias}</span>
            </div>
            <strong>{handoff.job_ref}</strong>
            <span className="subtle">payload {handoff.payload_ref}</span>
            <span className="subtle">{formatDateTime(handoff.requested_at)} by {handoff.requested_by}</span>
            {handoff.latest_receipt_id !== null && (
              <span className="subtle">receipt {handoff.latest_receipt_id} / external job {handoff.external_job_id ?? "pending"}</span>
            )}
          </div>
          <div className="inline-actions">
            {canDispatch && isDispatchable(handoff) && (
              <button
                className="linklike"
                type="button"
                onClick={() => setDispatchFormHandoffId((current) => (current === handoff.handoff_id ? null : handoff.handoff_id))}
              >
                {dispatchFormHandoffId === handoff.handoff_id ? "Hide dispatch" : "Dispatch"}
              </button>
            )}
            {canRecordReceipt && (
              <button
                className="linklike"
                type="button"
                onClick={() => setReceiptFormHandoffId((current) => (current === handoff.handoff_id ? null : handoff.handoff_id))}
              >
                {receiptFormHandoffId === handoff.handoff_id ? "Hide receipt" : "Record receipt"}
              </button>
            )}
            {dispatchErrorHandoffId === handoff.handoff_id && <span className="form-alert red" role="alert">Dispatch failed</span>}
            {receiptErrorHandoffId === handoff.handoff_id && <span className="form-alert red" role="alert">Receipt failed</span>}
          </div>
          {dispatchFormHandoffId === handoff.handoff_id && (
            <IntegrationHandoffDispatchForm
              handoff={handoff}
              isDispatching={dispatchingHandoffId === handoff.handoff_id}
              onDispatch={onDispatch}
            />
          )}
          {receiptFormHandoffId === handoff.handoff_id && (
            <IntegrationHandoffReceiptForm
              handoff={handoff}
              isRecording={recordingHandoffId === handoff.handoff_id}
              onRecord={onRecordReceipt}
            />
          )}
        </li>
      ))}
    </ul>
  );
}

function IntegrationHandoffDispatchForm({
  handoff,
  isDispatching,
  onDispatch,
}: {
  handoff: IntegrationHandoff;
  isDispatching: boolean;
  onDispatch: (handoff: IntegrationHandoff, draft: IntegrationHandoffDispatchDraft) => void;
}): JSX.Element {
  const providerProfile = profileForProviderAlias(handoff.provider_alias);
  const [endpointSecretRef, setEndpointSecretRef] = useState(providerProfile.dispatchEndpointSecretRef);
  const [allowedHosts, setAllowedHosts] = useState(providerProfile.allowedHosts);
  const [maxAttempts, setMaxAttempts] = useState(3);
  const [legalHold, setLegalHold] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const endpoint = endpointSecretRef.trim();
    const hosts = allowedHosts
      .split(",")
      .map((host) => host.trim().toLowerCase())
      .filter((host) => host.length > 0);
    if (!endpoint.startsWith("secret://")) {
      setValidationError("Dispatch endpoint must be a SecretRef.");
      return;
    }
    if (hosts.length === 0 || hosts.some((host) => host.includes("/") || host.includes(":") || host === "localhost")) {
      setValidationError("Allowed hosts must be public host names.");
      return;
    }
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 20) {
      setValidationError("Max attempts must be between 1 and 20.");
      return;
    }
    setValidationError(null);
    onDispatch(handoff, { endpointSecretRef: endpoint, allowedHosts: hosts, maxAttempts, legalHold });
  }

  return (
    <form className="ops-webhook-form nested-form" onSubmit={submit}>
      <div className="form-grid ops-webhook-grid">
        <label className="field">
          Dispatch endpoint SecretRef
          <input aria-label={`Dispatch endpoint SecretRef for ${handoff.handoff_id}`} value={endpointSecretRef} onChange={(event) => setEndpointSecretRef(event.target.value)} />
        </label>
        <label className="field">
          Allowed hosts
          <input aria-label={`Dispatch allowed hosts for ${handoff.handoff_id}`} value={allowedHosts} onChange={(event) => setAllowedHosts(event.target.value)} />
        </label>
        <label className="field">
          Max attempts
          <input aria-label={`Dispatch max attempts for ${handoff.handoff_id}`} type="number" min={1} max={20} value={maxAttempts} onChange={(event) => setMaxAttempts(Number(event.target.value))} />
        </label>
      </div>
      <div className="inline-actions">
        <label className="checkbox-inline">
          <input type="checkbox" checked={legalHold} onChange={(event) => setLegalHold(event.target.checked)} />
          Legal hold
        </label>
        <button className="btn" type="submit" disabled={isDispatching}>
          {isDispatching ? "Dispatching" : "Queue dispatch"}
        </button>
        {validationError !== null && <span className="form-alert red" role="alert">{validationError}</span>}
      </div>
    </form>
  );
}

function IntegrationHandoffReceiptForm({
  handoff,
  isRecording,
  onRecord,
}: {
  handoff: IntegrationHandoff;
  isRecording: boolean;
  onRecord: (handoff: IntegrationHandoff, draft: IntegrationHandoffReceiptDraft) => void;
}): JSX.Element {
  const [externalJobId, setExternalJobId] = useState(handoff.external_job_id ?? "job-0001");
  const [status, setStatus] = useState<IntegrationHandoffReceiptStatus>("completed");
  const [receiptId, setReceiptId] = useState(handoff.latest_receipt_id ?? "receipt-0001");
  const [errorCode, setErrorCode] = useState("");
  const [legalHold, setLegalHold] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const externalJob = externalJobId.trim();
    const receipt = receiptId.trim();
    const error = errorCode.trim();
    if (externalJob.length === 0 || receipt.length === 0) {
      setValidationError("External job id and receipt id are required.");
      return;
    }
    if (status === "failed" && error.length === 0) {
      setValidationError("Failed handoffs require an error code.");
      return;
    }
    setValidationError(null);
    onRecord(handoff, {
      externalJobId: externalJob,
      status,
      receiptId: receipt,
      errorCode: error.length === 0 ? null : error,
      legalHold,
    });
  }

  return (
    <form className="ops-webhook-form" onSubmit={submit}>
      <div className="form-grid ops-webhook-grid">
        <label className="field">
          Handoff external job id
          <input aria-label="External RPA job id" value={externalJobId} onChange={(event) => setExternalJobId(event.target.value)} />
        </label>
        <label className="field">
          Handoff receipt status
          <select aria-label="Handoff receipt status" value={status} onChange={(event) => setStatus(event.target.value as IntegrationHandoffReceiptStatus)}>
            <option value="accepted">accepted</option>
            <option value="completed">completed</option>
            <option value="failed">failed</option>
            <option value="cancelled">cancelled</option>
          </select>
        </label>
        <label className="field">
          Handoff receipt id
          <input aria-label="Handoff receipt id" value={receiptId} onChange={(event) => setReceiptId(event.target.value)} />
        </label>
        <label className="field">
          Handoff error code
          <input aria-label="Handoff error code" value={errorCode} onChange={(event) => setErrorCode(event.target.value)} />
        </label>
      </div>
      <div className="inline-actions">
        <label className="checkbox-inline">
          <input type="checkbox" checked={legalHold} onChange={(event) => setLegalHold(event.target.checked)} />
          Legal hold
        </label>
        <button className="btn" type="submit" disabled={isRecording}>
          {isRecording ? "Recording" : "Save receipt"}
        </button>
        {validationError !== null && <span className="form-alert red" role="alert">{validationError}</span>}
      </div>
    </form>
  );
}

function handoffTone(status: IntegrationHandoff["status"]): "green" | "amber" | "red" | "blue" {
  if (status === "completed") return "green";
  if (status === "failed" || status === "cancelled") return "red";
  if (status === "deferred") return "amber";
  return "blue";
}

function isDispatchable(handoff: IntegrationHandoff): boolean {
  return handoff.status === "deferred" || handoff.status === "failed";
}

function profileForProviderAlias(providerAlias: string): HandoffProviderProfile {
  const normalized = providerAlias.trim().toLowerCase();
  return HANDOFF_PROVIDER_PROFILES.find((profile) =>
    normalized === profile.alias.toLowerCase() ||
    normalized === profile.id ||
    normalized.startsWith(`${profile.id}-`),
  ) ?? DEFAULT_HANDOFF_PROVIDER_PROFILE;
}
