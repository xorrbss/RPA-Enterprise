/**
 * 단위 테스트 — VaultSecretStoreBoundary (fake SecretStore + fake audit writer).
 *
 * 증명:
 *  - 매트릭스 ALLOW: 허용된 (identity,purpose) 각각 allow.
 *  - 매트릭스 DENY(SECRET_ACCESS_DENIED): 금지 쌍은 deny + store.resolve 미호출.
 *  - allow 시 감사가 store.resolve **이전**에 기록(호출 순서 단언) + payload 에 시크릿 미포함.
 *  - 감사 append 실패 시 resolveAuthorized fail-closed(throw) + store.resolve 미호출.
 *
 * 실행: tsx test/vault-secret-store-boundary.unit.ts
 */
import type { PlainSecret, SecretRef, SecretStore } from "../../ts/core-types";
import {
  SECURITY_AUDIT_PAYLOAD_SCHEMA_REF,
  type AuditedSecurityDecision,
  type AuthenticatedPrincipal,
  type DurableSecurityAuditDecisionWriter,
  type ImmutableAuditLogRecord,
  type PrincipalId,
  type SecretAccessRequest,
  type SecurityAuditDecisionAppendInput,
  type TenantId,
} from "../../ts/security-middleware-contract";
import {
  ClaimRuntimeIdentityResolver,
  SecretAccessDeniedError,
  VaultSecretStoreBoundary,
  type RuntimeIdentity,
} from "../src/secrets/vault-secret-store-boundary";

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const TENANT = "00000000-0000-0000-0000-0000000000a1" as TenantId;
const SECRET_VALUE = "RESOLVED-PLAINTEXT-DO-NOT-LOG";

/** 공유 호출 로그(순서 단언). */
type Event = { kind: "audit"; input: SecurityAuditDecisionAppendInput } | { kind: "resolve"; ref: string };

function principal(identity: string | undefined): AuthenticatedPrincipal {
  return {
    subjectId: "svc-1" as PrincipalId,
    tenantId: TENANT,
    roles: ["admin"],
    source: "jwt",
    claims: identity === undefined ? {} : { runtime_identity: identity },
  };
}

function request(identity: string | undefined, purpose: SecretAccessRequest["purpose"], ref: string): SecretAccessRequest {
  return { principal: principal(identity), ref: ref as SecretRef, purpose };
}

class FakeSecretStore implements SecretStore {
  resolved: string[] = [];
  constructor(private readonly log?: Event[]) {}
  async resolve(ref: SecretRef): Promise<PlainSecret> {
    this.resolved.push(String(ref));
    this.log?.push({ kind: "resolve", ref: String(ref) });
    return SECRET_VALUE as PlainSecret;
  }
}

class FakeAuditWriter implements DurableSecurityAuditDecisionWriter {
  inputs: SecurityAuditDecisionAppendInput[] = [];
  constructor(
    private readonly log?: Event[],
    private readonly failOnAppend = false,
  ) {}
  async recordDecision<TDecision>(
    input: SecurityAuditDecisionAppendInput,
    decision: TDecision,
  ): Promise<AuditedSecurityDecision<TDecision>> {
    this.inputs.push(input);
    this.log?.push({ kind: "audit", input });
    if (this.failOnAppend) throw new Error("audit backend unavailable (fail-closed)");
    const auditRecord: ImmutableAuditLogRecord = {
      ...input,
      sequence: this.inputs.length,
      previousHash: "GENESIS",
      hash: `sha256:fake-${this.inputs.length}`,
    };
    return { decision, auditRecord };
  }
}

function makeBoundary(store: SecretStore, audit: DurableSecurityAuditDecisionWriter): VaultSecretStoreBoundary {
  return new VaultSecretStoreBoundary({
    store,
    audit,
    identityResolver: new ClaimRuntimeIdentityResolver(),
    clock: () => new Date("2026-06-16T00:00:00.000Z"),
  });
}

// 매트릭스(D8-A12) — 테스트 기대값(SSoT 미러).
const ALLOW_PAIRS: ReadonlyArray<[RuntimeIdentity, SecretAccessRequest["purpose"]]> = [
  ["api", "resume_token_hmac"],
  ["api", "browser_session"],
  ["runtime-worker", "resume_token_hmac"],
  ["runtime-worker", "executor"],
  ["runtime-worker", "browser_session"],
  ["browser-worker", "executor"],
  ["browser-worker", "browser_session"],
  ["llm-gateway", "gateway_policy"],
  ["artifact-lifecycle", "object_store"],
  ["connector-runtime", "connector"],
];

const DENY_PAIRS: ReadonlyArray<[RuntimeIdentity, SecretAccessRequest["purpose"]]> = [
  ["browser-worker", "gateway_policy"],
  ["api", "executor"],
  ["llm-gateway", "object_store"],
  ["llm-gateway", "browser_session"], // 세션키는 게이트웨이와 격리
  ["artifact-lifecycle", "executor"],
  ["artifact-lifecycle", "browser_session"],
  ["runtime-worker", "gateway_policy"],
  ["connector-runtime", "resume_token_hmac"],
];

async function main(): Promise<void> {
  // 1) 매트릭스 ALLOW: 허용 쌍은 authorize allow.
  for (const [identity, purpose] of ALLOW_PAIRS) {
    const boundary = makeBoundary(new FakeSecretStore(), new FakeAuditWriter());
    const d = await boundary.authorize(request(identity, purpose, `rpa/staging/${identity}/${purpose}/x`));
    check(`authorize ALLOW ${identity}/${purpose}`, d.kind === "allow", JSON.stringify(d));
  }

  // 2) 매트릭스 DENY(SECRET_ACCESS_DENIED): 금지 쌍 + store.resolve 미호출.
  for (const [identity, purpose] of DENY_PAIRS) {
    const store = new FakeSecretStore();
    const boundary = makeBoundary(store, new FakeAuditWriter());
    const d = await boundary.authorize(request(identity, purpose, `rpa/staging/x/${purpose}/x`));
    check(`authorize DENY ${identity}/${purpose}`, d.kind === "deny" && d.code === "SECRET_ACCESS_DENIED", JSON.stringify(d));

    let threw: unknown;
    try {
      await boundary.resolveAuthorized(request(identity, purpose, `rpa/staging/x/${purpose}/x`));
    } catch (e) {
      threw = e;
    }
    check(
      `resolveAuthorized DENY ${identity}/${purpose} → SecretAccessDeniedError`,
      threw instanceof SecretAccessDeniedError && threw.code === "SECRET_ACCESS_DENIED",
      String(threw),
    );
    check(`DENY ${identity}/${purpose} → store.resolve 미호출`, store.resolved.length === 0, `resolved=${store.resolved.length}`);
  }

  // 2b) 미인식 identity(claim 누락) → DENY + store.resolve 미호출.
  {
    const store = new FakeSecretStore();
    const boundary = makeBoundary(store, new FakeAuditWriter());
    const d = await boundary.authorize(request(undefined, "executor", "rpa/staging/x/executor/x"));
    check("authorize DENY 미인식 identity", d.kind === "deny" && d.code === "SECRET_ACCESS_DENIED", JSON.stringify(d));
  }

  // 3) allow 흐름: 감사가 store.resolve 이전 + payload 에 시크릿 미포함 + 반환값 정확.
  {
    const log: Event[] = [];
    const store = new FakeSecretStore(log);
    const audit = new FakeAuditWriter(log);
    const boundary = makeBoundary(store, audit);
    const req = request("runtime-worker", "resume_token_hmac", "rpa/staging/runtime-worker/resume_token_hmac/active");
    const secret = await boundary.resolveAuthorized(req);

    check("allow: 반환 PlainSecret 정확", String(secret) === SECRET_VALUE);
    check("allow: 감사 1건 기록", audit.inputs.length === 1, `count=${audit.inputs.length}`);
    check(
      "allow: 호출 순서 audit → resolve",
      log.length === 2 && log[0].kind === "audit" && log[1].kind === "resolve",
      log.map((e) => e.kind).join(","),
    );

    const input = audit.inputs[0];
    check("allow: action=secret.resolve", input.action === "secret.resolve", input.action);
    check("allow: outcome=allow", input.outcome === "allow", input.outcome);
    check("allow: failClosed=true", input.failClosed === true);
    check("allow: payloadSchemaRef=v1", input.payloadSchemaRef === SECURITY_AUDIT_PAYLOAD_SCHEMA_REF);
    const payloadText = JSON.stringify(input.payload);
    check("allow: payload 에 ref/purpose/identity 포함", /resume_token_hmac/.test(payloadText) && /runtime-worker/.test(payloadText));
    check("allow: payload 에 시크릿 값 미포함", !payloadText.includes(SECRET_VALUE), payloadText);
  }

  // 3b) deny 흐름도 감사 1건(outcome=deny) 기록.
  {
    const audit = new FakeAuditWriter();
    const boundary = makeBoundary(new FakeSecretStore(), audit);
    try {
      await boundary.resolveAuthorized(request("browser-worker", "gateway_policy", "rpa/staging/x/gateway_policy/x"));
    } catch {
      /* expected */
    }
    check("deny: 감사 1건 + outcome=deny", audit.inputs.length === 1 && audit.inputs[0].outcome === "deny", JSON.stringify(audit.inputs));
  }

  // 4) 감사 append 실패 → fail-closed: throw + store.resolve 미호출.
  {
    const store = new FakeSecretStore();
    const audit = new FakeAuditWriter(undefined, true);
    const boundary = makeBoundary(store, audit);
    let threw: unknown;
    try {
      await boundary.resolveAuthorized(request("runtime-worker", "executor", "rpa/staging/runtime-worker/executor/site"));
    } catch (e) {
      threw = e;
    }
    check("audit 실패 → resolveAuthorized throw(fail-closed)", threw !== undefined, String(threw));
    check("audit 실패 → store.resolve 미호출", store.resolved.length === 0, `resolved=${store.resolved.length}`);
  }

  console.log(`\nvault-secret-store-boundary.unit: ${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

void main();
