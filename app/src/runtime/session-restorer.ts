/**
 * Production SessionRestorer.
 *
 * This adapter verifies the signed resume token and proves that a reusable
 * browser session exists for the run target. It deliberately does not return
 * `restored`: the current persisted session contract stores cookies only, not a
 * URL/page-state snapshot that could prove exact `pageStateRef` equality.
 */
import type { ResumeTokenCodec, SessionRestoreInput, SessionRestoreResult, SessionRestorer } from "../../../ts/runtime-contract";
import { withTenantTx, type PgPool } from "../db/pool";
import { sessionKey, type BrowserSessionStore } from "./browser-session-store";

export interface PgSessionRestorerDeps {
  readonly pool: PgPool;
  readonly resumeTokenCodec: ResumeTokenCodec;
  readonly sessionStore: BrowserSessionStore;
}

interface RunTarget {
  readonly siteProfileId: string;
  readonly browserIdentityId: string;
}

export class PgSessionRestorer implements SessionRestorer {
  constructor(private readonly deps: PgSessionRestorerDeps) {}

  async restoreSession(input: SessionRestoreInput): Promise<SessionRestoreResult> {
    const verified = await this.deps.resumeTokenCodec.verify(input.token).catch((error: unknown): SessionRestoreResult => ({
      kind: "terminal_failure",
      reason: safeReason(error, "resume token verification failed"),
    }));
    if (verified.kind === "terminal_failure") return verified;
    if (verified.kind === "expired" || verified.kind === "invalid") {
      return { kind: "invalid_token", code: verified.code, reason: verified.reason };
    }
    if (verified.kind !== "valid") {
      return { kind: "terminal_failure", reason: "unexpected resume token verification result" };
    }
    if (
      String(verified.token.runId) !== String(input.runId) ||
      verified.token.resumeNodeId !== input.resumeNodeId ||
      verified.token.pageStateRef !== input.expectedPageStateRef
    ) {
      return {
        kind: "invalid_token",
        code: "IR_EXPRESSION_RUNTIME",
        reason: "resume token envelope does not match requested run resume intent",
      };
    }

    const target = await this.resolveRunTarget(input);
    if (target === null) {
      return { kind: "terminal_failure", reason: "run target is unavailable for session restore" };
    }

    const bundle = await this.deps.sessionStore
      .load(sessionKey(input.tenantId, target.siteProfileId, target.browserIdentityId))
      .catch((error: unknown): SessionRestoreResult => ({
        kind: "terminal_failure",
        reason: safeReason(error, "browser session load failed"),
      }));
    if (isSessionRestoreResult(bundle)) return bundle;
    if (bundle === null) {
      return { kind: "terminal_failure", reason: "browser session is unavailable for run target" };
    }
    if (bundle.cookies.length === 0) {
      return { kind: "terminal_failure", reason: "browser session contains no cookies" };
    }

    // Product Open v1 intentionally resumes verified cookies through R19
    // login-bypass; the resumed drive revalidates page state normally.
    return {
      kind: "login_bypass",
      reason: "verified browser session cookies are available; exact page state restore is not contract-proven",
    };
  }

  private async resolveRunTarget(input: SessionRestoreInput): Promise<RunTarget | null> {
    const row = await withTenantTx(this.deps.pool, input.tenantId, async (client) => {
      const result = await client.query<{ target: unknown }>(
        `SELECT sv.ir -> 'target' AS target
           FROM runs r
           JOIN scenario_versions sv ON sv.tenant_id = r.tenant_id AND sv.id = r.scenario_version_id
          WHERE r.tenant_id = $1::uuid AND r.id = $2::uuid`,
        [input.tenantId, input.runId],
      );
      return result.rows[0] ?? null;
    });
    return parseRunTarget(row?.target);
  }
}

function parseRunTarget(value: unknown): RunTarget | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const siteProfileId = record.site_profile_id;
  const browserIdentityId = record.browser_identity_id;
  if (typeof siteProfileId !== "string" || siteProfileId.length === 0) return null;
  if (typeof browserIdentityId !== "string" || browserIdentityId.length === 0) return null;
  return { siteProfileId, browserIdentityId };
}

function isSessionRestoreResult(value: unknown): value is SessionRestoreResult {
  return typeof value === "object" && value !== null && "kind" in value;
}

function safeReason(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.length > 0 ? error.message : fallback;
}
