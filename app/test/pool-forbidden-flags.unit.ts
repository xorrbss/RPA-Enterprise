/**
 * 단위 — DG-3 buildPoolForbiddenFlags: 워커가 미서비스 풀의 pool:<key> flag 를 forbiddenFlags 로 산출.
 * 실행: tsx test/pool-forbidden-flags.unit.ts
 */
import { buildPoolForbiddenFlags, poolFlagFor } from "../src/worker/pool-forbidden-flags";
import type { PgPool } from "../src/db/pool";

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

// worker_pools 등록 풀을 반환하는 가짜 pool(쿼리 1종만 사용).
function fakePool(registeredPoolKeys: readonly string[]): PgPool {
  return fakePoolRows(registeredPoolKeys.map((pool_key) => ({ pool_key, status: "active" })));
}

function fakePoolRows(rows: readonly { pool_key: string; status: string }[]): PgPool {
  return {
    query: async () => ({ rows }),
  } as unknown as PgPool;
}

async function main(): Promise<void> {
  check("poolFlagFor prefixes pool:", poolFlagFor("sensitive") === "pool:sensitive");

  // 풀 미등록 + served 기본('default') → forbidden 없음(기존 배포 무변경 호환)
  const noPools = await buildPoolForbiddenFlags(fakePool([]), [])();
  check("풀 미등록 → forbid 없음", noPools.length === 0, JSON.stringify(noPools));

  // 기본 워커(served=['default']): 등록 풀 pa,pb 를 forbid, default 는 서비스
  const defaultWorker = await buildPoolForbiddenFlags(fakePool(["pa", "pb"]), [])();
  check(
    "기본 워커 → forbid pool:pa,pool:pb (not pool:default)",
    defaultWorker.includes("pool:pa") && defaultWorker.includes("pool:pb") && !defaultWorker.includes("pool:default"),
    JSON.stringify(defaultWorker),
  );

  // 전용 워커(served=['pa']): default 와 pb 를 forbid, pa 만 서비스
  const paWorker = await buildPoolForbiddenFlags(fakePool(["pa", "pb"]), ["pa"])();
  check(
    "전용 워커 pa → forbid pool:default,pool:pb (not pool:pa)",
    paWorker.includes("pool:default") && paWorker.includes("pool:pb") && !paWorker.includes("pool:pa"),
    JSON.stringify(paWorker),
  );

  // 다중 서비스(served=['pa','default']): pb 만 forbid
  const multi = await buildPoolForbiddenFlags(fakePool(["pa", "pb"]), ["pa", "default"])();
  check("다중 서비스 pa+default → forbid pool:pb 만", multi.length === 1 && multi[0] === "pool:pb", JSON.stringify(multi));

  const drained = await buildPoolForbiddenFlags(fakePoolRows([{ pool_key: "pa", status: "draining" }]), ["pa"])();
  check("draining 풀은 served 여도 forbid pool:pa", drained.includes("pool:pa"), JSON.stringify(drained));

  if (failures > 0) {
    console.error(`\nFAIL: ${failures} pool-forbidden-flags check(s) failed`);
    process.exit(1);
  }
  console.log("\nPASS: pool-forbidden-flags unit green");
}

main().catch((err) => {
  console.error("unit fatal:", err);
  process.exit(1);
});
