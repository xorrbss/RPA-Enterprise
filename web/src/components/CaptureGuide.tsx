import { useState } from "react";

import { ConfirmDialog } from "./ConfirmDialog";
import type { SiteItem } from "../api/types";

// 운영자-로컬 세션 등록 안내 (P3.3) — 운영 환경에선 서버가 로그인 창을 띄울 수 없어, 운영자 본인 PC 에서
// 캡처 도구(capture-agent)를 실행해 로그인 세션을 등록한다. 본 모달은 그 명령을 안내·복사한다.
//
// 보안: 토큰은 **절대 화면/명령에 임베드하지 않는다**(플레이스홀더만). 운영자가 본인 운영자 토큰을 환경변수
//   RPA_OPERATOR_TOKEN 으로 전달한다. 자격증명(아이디/비밀번호)은 로그인 창에 직접 입력 — 캡처 도구를 거치지 않는다.

/** 콘솔 baseUrl(상대 "/api" 또는 절대 URL)을 운영자 PC 가 직접 칠 절대 API 베이스로 해소(main.tsx 구성 미러). */
function resolveApiBase(): string {
  const raw = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "/api";
  return raw.startsWith("http") ? raw : `${window.location.origin}${raw}`;
}

export function CaptureGuide({ site, onClose }: { site: SiteItem; onClose: () => void }): JSX.Element {
  const [copied, setCopied] = useState(false);
  const name = site.name ?? site.site_profile_id.slice(0, 8);
  const command = `RPA_OPERATOR_TOKEN=<본인 운영자 토큰> capture-agent --api ${resolveApiBase()} --site ${site.site_profile_id}`;

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false); // 클립보드 미허용 환경 — 사용자가 직접 선택·복사(아래 코드 블록).
    }
  }

  return (
    <ConfirmDialog title={`운영자 PC에서 세션 등록 — ${name}`} hideConfirm cancelLabel="닫기" onConfirm={onClose} onCancel={onClose}>
      <div style={{ display: "grid", gap: 12, fontSize: 13, lineHeight: 1.5 }}>
        <p style={{ margin: 0 }}>
          운영 환경에서는 운영자 본인 PC에서 캡처 도구를 실행해 로그인 세션을 등록합니다. 아래 명령을 실행하면 로그인 창이 열리며,
          창에서 직접 로그인하시면(아이디·비밀번호·OTP는 이 도구를 거치지 않습니다) 세션이 안전하게 저장되어 이후 자동 실행이 재사용합니다.
        </p>
        <pre
          style={{
            margin: 0,
            padding: "10px 12px",
            background: "var(--bg, #0d1117)",
            border: "1px solid var(--line)",
            borderRadius: "var(--radius)",
            overflowX: "auto",
            fontSize: 12,
            whiteSpace: "pre-wrap",
            wordBreak: "break-all",
          }}
        >
          <code>{command}</code>
        </pre>
        <p style={{ margin: 0, color: "var(--warn, #b8860b)", fontWeight: 600 }}>
          ⚠ 보안: 토큰은 본인 운영자 토큰을 환경변수(RPA_OPERATOR_TOKEN)로 전달하세요. 화면이나 명령줄에 토큰을 직접 적지 마세요.
        </p>
        <div>
          <button className="btn" type="button" onClick={() => void copy()}>
            {copied ? "복사됨 ✓" : "명령 복사"}
          </button>
        </div>
      </div>
    </ConfirmDialog>
  );
}
