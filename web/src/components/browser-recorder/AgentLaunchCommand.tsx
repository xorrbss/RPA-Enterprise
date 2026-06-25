import { useMemo, useState } from "react";

import type { BrowserRecordingSession } from "../../api/types";
import { agentApiBase, psQuote } from "./helpers";

export function AgentLaunchCommand({
  siteId,
  session,
}: {
  siteId: string;
  session: BrowserRecordingSession;
}): JSX.Element | null {
  const [copied, setCopied] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const command = useMemo(() => {
    const apiBase = agentApiBase();
    return [
      `$env:RPA_OPERATOR_TOKEN=${psQuote("<paste operator JWT>")}`,
      `npm --prefix app run record:browser -- --api ${psQuote(apiBase)} --site ${psQuote(siteId)} --recording ${psQuote(session.recording_session_id)} --start-url ${psQuote(session.start_url)}`,
    ].join("\n");
  }, [session.recording_session_id, session.start_url, siteId]);

  if (session.status !== "recording") return null;

  const copy = async (): Promise<void> => {
    const clipboard = globalThis.navigator?.clipboard;
    if (clipboard?.writeText !== undefined) await clipboard.writeText(command);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="browser-recorder-agent">
      <div>
        <strong>내 PC 브라우저 녹화 도우미</strong>
        <span className="badge blue">내 PC Chrome</span>
      </div>
      <p className="subtle">
        업무 담당자 PC에서 실행하면 녹화에 필요한 권한은 PC 안에서만 쓰이고,
        대상 웹페이지에는 전달되지 않습니다.
      </p>
      <details className="developer-details" open={commandOpen}>
        <summary
          onClick={(event) => {
            event.preventDefault();
            setCommandOpen((open) => !open);
          }}
        >
          고급 실행 정보 보기
        </summary>
        {commandOpen && (
          <pre>
            <code>{command}</code>
          </pre>
        )}
      </details>
      <button className="btn" type="button" onClick={() => void copy()}>
        {copied ? "복사됨" : "실행 명령 복사"}
      </button>
    </div>
  );
}
