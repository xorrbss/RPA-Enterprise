/**
 * deriveAssetRefs 단위 테스트 (AUD-1) — 실행: tsx test/asset-refs.unit.ts.
 * IR 의 assets[] → assetRefs(key→SecretRef). 문자열 IR 은 parse, 비문자/빈 키는 필터, 부재/null 은 {}.
 */
import { deriveAssetRefs } from "../src/runtime/asset-refs";

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}
const keys = (r: Record<string, string>): string => Object.keys(r).sort().join(",");

function main(): void {
  // 1) assets[] → key=ref (identity 매핑).
  {
    const r = deriveAssetRefs({ assets: ["login.username", "login.password"] });
    check("assets[] → key→ref(identity)", keys(r) === "login.password,login.username" && r["login.password"] === "login.password");
  }
  // 2) 문자열 IR 은 JSON.parse.
  {
    const r = deriveAssetRefs('{"assets":["a","b"]}');
    check("string IR → parsed → {a,b}", keys(r) === "a,b" && r.a === "a");
  }
  // 3) assets 부재 → {}.
  check("no assets → {}", keys(deriveAssetRefs({})) === "");
  // 4) null/undefined IR → {} (throw 아님).
  check("null IR → {}", keys(deriveAssetRefs(null)) === "");
  check("undefined IR → {}", keys(deriveAssetRefs(undefined)) === "");
  // 5) 비문자·빈 키 필터(조용한 오염 금지 — 유효 키만).
  {
    const r = deriveAssetRefs({ assets: ["valid", "", 123, null, "valid2"] as unknown[] });
    check("filters non-string/empty keys", keys(r) === "valid,valid2");
  }
  // 6) assets 가 배열 아님 → {}.
  check("assets non-array → {}", keys(deriveAssetRefs({ assets: "login.password" })) === "");
  // 7) 위험 키(__proto__/constructor/prototype) 무시 + null-proto(상속 멤버 미노출) — ASSET-02 프로토타입 오염 차단.
  {
    const r = deriveAssetRefs({ assets: ["ok", "__proto__", "constructor", "prototype", "ok2"] });
    check("dangerous keys(__proto__/constructor/prototype) skipped", keys(r) === "ok,ok2", keys(r));
    const probe = r as Record<string, unknown>;
    check("null-proto: constructor lookup → undefined(미바인딩 가드 우회 차단)", probe["constructor"] === undefined);
    check("null-proto: toString lookup → undefined", probe["toString"] === undefined);
  }

  if (failures > 0) {
    console.error(`\nFAIL: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nPASS: asset-refs unit green (AUD-1)");
  process.exit(0);
}

main();
