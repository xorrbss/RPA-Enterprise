/**
 * 라이브 e2e 보조 — 운영 전환 준비도 패널의 "오너 증빙 폼 5종"이 실제로 게이트를 닫는지 검증한다.
 *
 * 왜 이 칸을 막는가:
 *   web 테스트는 fake 클라이언트라 서버 검증기를 못 보고(폼이 만든 본문이 거부돼도 통과),
 *   app int 테스트는 콘솔 폼이 무슨 본문을 만드는지 못 본다(직접 만든 본문만 검증).
 *   그 사이의 칸 — "폼 본문 ↔ 서버 검증기 ↔ 게이트 전이" — 이 비어 있었고, 같은 사각지대에서
 *   AI 거버넌스 증빙 결함(#459: 기본 대상 참조가 어떤 게이트도 닫지 못함)이 살아남았다.
 *   여기서 막는 5종은 운영 오픈을 직접 막는 게이트라, 오너가 실 인프라 작업을 끝낸 뒤에야
 *   "증빙을 넣었는데 안 닫힌다"를 발견하는 사태를 이 게이트가 사전에 차단한다.
 *
 * 입력값은 각 필드의 placeholder 를 쓴다(운영자가 그대로 따라 칠 현실적 값). 만료일은 폼 기본값.
 */
import type { Page } from "puppeteer-core";

/** 제출 버튼 문구 → 닫혀야 하는 게이트 id. */
const OWNER_EVIDENCE_FORMS: ReadonlyArray<readonly [string, string]> = [
  ["알림 증빙 기록", "external_alert_delivery"],
  ["백업 증빙 기록", "managed_backup_restore_drill"],
  ["SLO 증빙 기록", "slo_oncall_signoff"],
  ["관측성 증빙 기록", "observability_telemetry_wiring"],
  ["지원 증빙 기록", "support_training_completion"],
];

interface FormFillResult {
  readonly name: string;
  readonly filled: number;
  readonly submitted: boolean;
  readonly missing: boolean;
}

export async function checkOwnerEvidenceForms(
  page: Page,
  base: string,
  check: (label: string, cond: boolean, detail?: string) => void,
): Promise<void> {
  await page.goto(`${base}/#automationOps?section=readiness`, { waitUntil: "networkidle0", timeout: 30_000 });
  await page.waitForFunction(
    () => document.body.innerText.includes("운영 전환 준비 상태"),
    { timeout: 15_000 },
  );

  const before = await readGateStatuses(page);
  check(
    "준비도 오너 증빙 게이트 5종이 기록 전에는 미충족(deferred)",
    OWNER_EVIDENCE_FORMS.every(([, gate]) => before[gate] === "deferred"),
    JSON.stringify(before),
  );

  const results = await fillAndSubmitForms(page, OWNER_EVIDENCE_FORMS.map(([name]) => name));
  for (const result of results) {
    check(
      `준비도 증빙 폼 제출: ${result.name}`,
      !result.missing && result.submitted && result.filled > 0,
      result.missing ? "폼을 찾지 못함" : `채운 필드=${result.filled} 제출=${result.submitted}`,
    );
  }

  // 게이트 전이는 서버 판정이므로 API 로 확인한다(화면 문구 대신 판정 자체를 단언).
  const after = await pollUntilGatesClose(page, OWNER_EVIDENCE_FORMS.map(([, gate]) => gate));
  for (const [name, gate] of OWNER_EVIDENCE_FORMS) {
    check(
      `콘솔 증빙 기록(${name}) → 게이트 ${gate} 닫힘(pass)`,
      after[gate] === "pass",
      `status=${after[gate] ?? "없음"}`,
    );
  }
}

/** 준비도 API 게이트 상태 맵(콘솔과 같은 same-origin 프록시 + 콘솔이 쓰는 토큰). */
async function readGateStatuses(page: Page): Promise<Record<string, string>> {
  return page.evaluate(async () => {
    const token = localStorage.getItem("rpa.token") ?? "";
    const res = await fetch("/api/v1/ops/production-readiness", { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) return {};
    const body = (await res.json()) as { gates: Array<{ gate_id: string; status: string }> };
    const map: Record<string, string> = {};
    for (const gate of body.gates) map[gate.gate_id] = gate.status;
    return map;
  });
}

async function pollUntilGatesClose(page: Page, gates: readonly string[]): Promise<Record<string, string>> {
  let latest: Record<string, string> = {};
  for (let attempt = 0; attempt < 30; attempt += 1) {
    latest = await readGateStatuses(page);
    if (gates.every((gate) => latest[gate] === "pass")) return latest;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return latest;
}

/**
 * 폼별로 placeholder 값을 채우고 제출한다. select 와 만료일(type=date)은 폼 기본값을 그대로 쓴다.
 *
 * ⚠ page.evaluate 본문에서는 화살표 함수를 변수에 할당하지 않는다 — tsx(esbuild)가 이름 보존 헬퍼(__name)를
 *   주입하는데, evaluate 는 함수를 문자열로 브라우저에 넘기므로 브라우저에 그 헬퍼가 없어 ReferenceError 가 난다.
 */
async function fillAndSubmitForms(page: Page, buttonNames: readonly string[]): Promise<readonly FormFillResult[]> {
  return page.evaluate(async (names: readonly string[]) => {
    const out: Array<{ name: string; filled: number; submitted: boolean; missing: boolean }> = [];
    for (const name of names) {
      const button = Array.from(document.querySelectorAll("button")).find((item) => item.textContent?.trim() === name);
      const form = button?.closest("form") ?? null;
      if (button === undefined || form === null) {
        out.push({ name, filled: 0, submitted: false, missing: true });
        continue;
      }

      let filled = 0;
      for (const label of Array.from(form.querySelectorAll("label"))) {
        const field = label.querySelector("input");
        if (field === null || field.type === "date") continue; // 만료일 = 폼 기본값(미래)
        const placeholder = field.getAttribute("placeholder") ?? "";
        if (placeholder === "") continue;
        // React 제어 입력: 네이티브 setter 로 주입 후 이벤트 발생(field.value 직접 대입은 state 에 안 잡힌다).
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(field, placeholder);
        field.dispatchEvent(new Event("input", { bubbles: true }));
        field.dispatchEvent(new Event("change", { bubbles: true }));
        filled += 1;
      }
      await new Promise((resolve) => setTimeout(resolve, 200)); // 제어 입력 반영 대기
      const submitted = !button.disabled;
      if (submitted) button.click();
      out.push({ name, filled, submitted, missing: false });
      await new Promise((resolve) => setTimeout(resolve, 800)); // 기록 요청 왕복 대기
    }
    return out;
  }, buttonNames);
}
