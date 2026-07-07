export interface SloEvidenceRecordDraft {
  readonly evidenceRef: string;
  readonly summary: string;
  readonly expiresAt: string;
  readonly sloDashboard: string;
  readonly severityModel: string;
  readonly oncallRota: string;
  readonly raciRef: string;
  readonly supportHours: string;
}

export interface BackupEvidenceRecordDraft {
  readonly evidenceRef: string;
  readonly summary: string;
  readonly expiresAt: string;
  readonly backupPolicyRef: string;
  readonly restoreScope: string;
  readonly restoreCompletedAt: string;
  readonly rtoMinutes: number;
  readonly rpoMinutes: number;
}

export interface ExternalAlertEvidenceRecordDraft {
  readonly evidenceRef: string;
  readonly summary: string;
  readonly expiresAt: string;
  readonly channel: "teams" | "slack" | "email" | "webhook";
  readonly providerAlias: string;
  readonly receiptId: string;
  readonly receiptAt: string;
}

export interface ObservabilityEvidenceRecordDraft {
  readonly evidenceRef: string;
  readonly summary: string;
  readonly expiresAt: string;
  readonly exporter: "prometheus" | "otlp";
  readonly collectorRef: string;
  readonly dashboardRef: string;
  readonly alertRouteRef: string;
  readonly sampledAt: string;
}

export interface SupportTrainingEvidenceRecordDraft {
  readonly evidenceRef: string;
  readonly summary: string;
  readonly supportModelRef: string;
  readonly trainingCompletionRef: string;
  readonly trainedRoleCount: number;
  readonly trainedUserCount: number;
  readonly coveragePercent: number;
  readonly completedAt: string;
  readonly expiresAt: string;
}
