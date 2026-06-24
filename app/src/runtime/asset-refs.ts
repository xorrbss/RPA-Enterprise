/**
 * IR meta.assets → 자격증명 fill 의 SecretRef 바인딩(AUD-1). 시나리오가 선언한 asset 키 배열을 ctx.assetRefs
 * (key→SecretRef)로 만든다. 실행기는 act.vars(secretRef)를 이 맵으로 SecretStore 경유 해소해 LLM 미경유 fill 한다.
 *
 * dev(run-loop)와 prod(run-step-driver) 공유 — 키 도출 단일 진실원천(중복 제거). 실 SecretRef 해소·감사는
 * SecretStoreBoundary(VaultSecretStoreBoundary) 소관(executor factory 의 secrets 주입). 여기선 키 매핑만.
 */
import type { SecretRef } from "../../../ts/core-types";

// 프로토타입 오염 방지(ASSET-02): assetRefs 는 prototype 체인 없는 객체라야 lookup 이 상속 멤버(constructor/toString
//   등)를 SecretRef 로 오취급하지 않는다. 그래도 누군가 일반 객체를 넘길 수 있으니 소비측(resolveSecretForFill)은
//   hasOwnProperty 로 own-property 만 인정한다(이중 방어).
export function deriveAssetRefs(ir: unknown): Record<string, SecretRef> {
  const doc = typeof ir === "string" ? (JSON.parse(ir) as unknown) : ir;
  const assets = (doc as { assets?: unknown } | null)?.assets;
  const refs: Record<string, SecretRef> = Object.create(null) as Record<string, SecretRef>;
  if (Array.isArray(assets)) {
    for (const k of assets) {
      // 위험 키(__proto__/constructor/prototype)는 무시 — 프로토타입 오염·미바인딩 가드 우회 차단.
      if (typeof k === "string" && k.length > 0 && k !== "__proto__" && k !== "constructor" && k !== "prototype") {
        refs[k] = k as SecretRef;
      }
    }
  }
  return refs;
}
