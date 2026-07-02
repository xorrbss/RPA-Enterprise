/**
 * 무인 운영 알림 라우팅 규칙 (S4a) — env `OPS_ALERT_ROUTES` 파서.
 *
 * 왜 env 인가: 파일럿은 단일 테넌트·오너 운영이라 배포-소유 env 가 정합하고 계약(DDL) 변경이 0이 된다.
 *   테넌트별 저장형 규칙(테이블+관리 UI)은 멀티테넌트 셀프서비스가 실제 필요해질 때 별도 슬라이스(S4b)로 승격한다.
 *
 * 무엇을 하나: 운영 알림 계산기(readComputedOpsAlerts)가 만든 알림을 매칭 규칙에 따라 기존 전달 파이프라인
 *   (ops_notification_attempts → 워커 ops_notification_send → deliverOpsNotificationAttempt)으로 자동 발화한다.
 *   즉 콘솔을 열지 않아도 critical 신호가 외부로 나간다(감사 alerts-console-pull-only).
 *
 * fail-closed: 형식이 조금이라도 어긋나면 throw 하여 서버 기동을 막는다(조용한 무발화 금지).
 */

/** 자동 발화 대상 소스 — detected_at 이 행 타임스탬프에서 나와 세대(generation)가 안정적인 것만 허용한다.
 *  (멱등 키가 tenant+alert_id+detected_at+provider 이므로 detected_at 이 now() 로 흔들리면 재발화 폭주 위험.)
 *  다른 소스는 detected_at 안정성 확인 후 이 목록에 추가한다. */
export const OPS_ALERT_AUTO_FIRE_SOURCES = [
  "run_sla",
  "human_task_sla",
  "trigger_fire",
  "failure_spike",
] as const;

export type OpsAlertAutoFireSource = (typeof OPS_ALERT_AUTO_FIRE_SOURCES)[number];

export type OpsAlertRouteSeverity = "warning" | "critical";

export interface OpsAlertRoute {
  /** 생략 시 모든 자동 발화 대상 소스 매칭. 지정 시 해당 소스만. */
  readonly source?: OpsAlertAutoFireSource;
  /** 이 심각도 이상만 발화(warning 이면 warning+critical, critical 이면 critical 만). */
  readonly minSeverity: OpsAlertRouteSeverity;
  readonly providerAlias: string;
  readonly endpointSecretRef: string;
  readonly allowedHosts: readonly string[];
  readonly routePolicyRef: string;
  readonly recipientGroupRef?: string;
  readonly callbackSignatureSecretRef?: string;
}

function isSecretRef(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("secret://") && value.length > "secret://".length && value.length <= 500;
}

function requireField(record: Record<string, unknown>, key: string, index: number): unknown {
  if (!Object.prototype.hasOwnProperty.call(record, key)) {
    throw new Error(`OPS_ALERT_ROUTES[${index}] missing required field "${key}"`);
  }
  return record[key];
}

/**
 * `OPS_ALERT_ROUTES`(JSON 배열 문자열) → 검증된 규칙 배열. 미설정/빈 문자열이면 빈 배열(자동 발화 없음, 정직).
 * 형식 오류는 throw(fail-closed).
 */
export function parseOpsAlertRoutes(raw: string | undefined): OpsAlertRoute[] {
  const trimmed = raw?.trim() ?? "";
  if (trimmed.length === 0) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    throw new Error(`OPS_ALERT_ROUTES must be a JSON array: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error("OPS_ALERT_ROUTES must be a JSON array");
  }

  return parsed.map((entry, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error(`OPS_ALERT_ROUTES[${index}] must be an object`);
    }
    const record = entry as Record<string, unknown>;

    const sourceRaw = record.source;
    let source: OpsAlertAutoFireSource | undefined;
    if (sourceRaw !== undefined && sourceRaw !== null) {
      if (typeof sourceRaw !== "string" || !(OPS_ALERT_AUTO_FIRE_SOURCES as readonly string[]).includes(sourceRaw)) {
        throw new Error(
          `OPS_ALERT_ROUTES[${index}].source must be one of ${OPS_ALERT_AUTO_FIRE_SOURCES.join(", ")} (or omitted for all)`,
        );
      }
      source = sourceRaw as OpsAlertAutoFireSource;
    }

    const minSeverityRaw = requireField(record, "min_severity", index);
    if (minSeverityRaw !== "warning" && minSeverityRaw !== "critical") {
      throw new Error(`OPS_ALERT_ROUTES[${index}].min_severity must be "warning" or "critical"`);
    }

    const providerAlias = requireField(record, "provider_alias", index);
    if (typeof providerAlias !== "string" || providerAlias.length === 0 || providerAlias.length > 120) {
      throw new Error(`OPS_ALERT_ROUTES[${index}].provider_alias must be a non-empty string (<=120)`);
    }

    const endpointSecretRef = requireField(record, "endpoint_secret_ref", index);
    if (!isSecretRef(endpointSecretRef)) {
      throw new Error(`OPS_ALERT_ROUTES[${index}].endpoint_secret_ref must be a secret:// reference`);
    }

    const allowedHostsRaw = requireField(record, "allowed_hosts", index);
    if (
      !Array.isArray(allowedHostsRaw) ||
      allowedHostsRaw.length < 1 ||
      allowedHostsRaw.length > 20 ||
      !allowedHostsRaw.every((h) => typeof h === "string" && h.length > 0)
    ) {
      throw new Error(`OPS_ALERT_ROUTES[${index}].allowed_hosts must be a non-empty string array (1..20)`);
    }

    const routePolicyRef = requireField(record, "route_policy_ref", index);
    if (typeof routePolicyRef !== "string" || routePolicyRef.length === 0 || routePolicyRef.length > 200) {
      throw new Error(`OPS_ALERT_ROUTES[${index}].route_policy_ref must be a non-empty string (<=200)`);
    }

    const recipientGroupRefRaw = record.recipient_group_ref;
    let recipientGroupRef: string | undefined;
    if (recipientGroupRefRaw !== undefined && recipientGroupRefRaw !== null) {
      if (typeof recipientGroupRefRaw !== "string" || recipientGroupRefRaw.length === 0 || recipientGroupRefRaw.length > 200) {
        throw new Error(`OPS_ALERT_ROUTES[${index}].recipient_group_ref must be a non-empty string (<=200)`);
      }
      recipientGroupRef = recipientGroupRefRaw;
    }

    const callbackSignatureSecretRefRaw = record.callback_signature_secret_ref;
    let callbackSignatureSecretRef: string | undefined;
    if (callbackSignatureSecretRefRaw !== undefined && callbackSignatureSecretRefRaw !== null) {
      if (!isSecretRef(callbackSignatureSecretRefRaw)) {
        throw new Error(`OPS_ALERT_ROUTES[${index}].callback_signature_secret_ref must be a secret:// reference`);
      }
      callbackSignatureSecretRef = callbackSignatureSecretRefRaw;
    }

    return {
      ...(source !== undefined ? { source } : {}),
      minSeverity: minSeverityRaw,
      providerAlias,
      endpointSecretRef,
      allowedHosts: allowedHostsRaw as string[],
      routePolicyRef,
      ...(recipientGroupRef !== undefined ? { recipientGroupRef } : {}),
      ...(callbackSignatureSecretRef !== undefined ? { callbackSignatureSecretRef } : {}),
    };
  });
}
