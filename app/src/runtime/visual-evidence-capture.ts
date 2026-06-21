/**
 * 시각 증거 capture primitive — Page.captureScreenshot + sensitive-DOM 마스크 주입/복원(masked_on_failure)
 * + 마스크 주입 스크립트 상수, 공유 VisualEvidenceError. 분해 전 visual-evidence.ts 내부였음(CLAUDE.md #7).
 * CdpSession 외 의존 없는 leaf(visual-evidence.ts 가 captureScreenshotPng/VisualEvidenceError import).
 */
import type { CdpSession } from "../executor/cdp-session";

export class VisualEvidenceError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(cause instanceof Error ? `${message}: ${cause.message}` : message);
    this.name = "VisualEvidenceError";
  }
}

export async function captureScreenshotPng(session: CdpSession): Promise<Uint8Array> {
  await applyCaptureMask(session);
  let response: { data?: unknown };
  let restoreError: unknown;
  try {
    response = await session.sendCDP<{ data?: unknown }>("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: true,
    });
  } finally {
    try {
      await clearCaptureMask(session);
    } catch (err) {
      restoreError = err;
    }
  }
  if (restoreError !== undefined) {
    throw new VisualEvidenceError("visual evidence mask restore failed closed", restoreError);
  }
  if (typeof response.data !== "string" || response.data.length === 0) {
    throw new VisualEvidenceError("visual evidence screenshot response missing Page.captureScreenshot data");
  }
  const bytes = new Uint8Array(Buffer.from(response.data, "base64"));
  if (bytes.byteLength === 0) {
    throw new VisualEvidenceError("visual evidence screenshot bytes are empty");
  }
  return bytes;
}

async function applyCaptureMask(session: CdpSession): Promise<void> {
  const response = await session.sendCDP<{ exceptionDetails?: unknown; result?: { value?: unknown } }>("Runtime.evaluate", {
    expression: VISUAL_EVIDENCE_MASK_APPLY_SCRIPT,
    awaitPromise: true,
    returnByValue: true,
  });
  if (response.exceptionDetails !== undefined) {
    throw new VisualEvidenceError("visual evidence mask injection failed closed");
  }
  const value = response.result?.value;
  if (typeof value === "object" && value !== null && "skippedFrames" in value) {
    const skippedFrames = (value as { skippedFrames?: unknown }).skippedFrames;
    if (typeof skippedFrames === "number" && skippedFrames > 0) {
      throw new VisualEvidenceError("visual evidence mask skipped inaccessible frames");
    }
  }
}

async function clearCaptureMask(session: CdpSession): Promise<void> {
  const response = await session.sendCDP<{ exceptionDetails?: unknown }>("Runtime.evaluate", {
    expression: VISUAL_EVIDENCE_MASK_CLEAR_SCRIPT,
    awaitPromise: true,
    returnByValue: true,
  });
  if (response.exceptionDetails !== undefined) {
    throw new VisualEvidenceError("visual evidence mask cleanup failed closed");
  }
}

const VISUAL_EVIDENCE_MASK_APPLY_SCRIPT = String.raw`
(() => {
  const KEY = "__rpaVisualEvidenceMask";
  const prior = window[KEY];
  if (prior && typeof prior.restore === "function") prior.restore();

  const originals = [];
  const sensitiveAttr = /(password|passwd|secret|token|otp|api[-_ ]?key|authorization|credential|ssn|rrn|resident|passport|account|iban|card|credit|email|phone|tel)/i;
  const replacements = [
    [/\bAuthorization\s*:\s*\S[^\r\n]*/gi, "Authorization: [REDACTED:credential]"],
    [/\bBearer\s+\S[^\r\n]*/gi, "Bearer [REDACTED:credential]"],
    [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "[REDACTED:pii:email]"],
    [/\b\d{6}-\d{7}\b/g, "[REDACTED:pii:rrn]"],
    [/\b(?:\d[ -]?){12,18}\d\b/g, "[REDACTED:pii:number]"],
    [/(?<![\d(])(?<!\d[ -])(?:\+?\d{1,3}[ -])?\(?\d{2,4}\)?[ -]\d{3,4}[ -]?\d{4}(?![ -]?\d)/g, "[REDACTED:pii:phone]"],
  ];

  function maskText(value) {
    let out = value;
    for (const [pattern, label] of replacements) out = out.replace(pattern, label);
    return out;
  }

  function attrText(el) {
    return [
      el.getAttribute("type"),
      el.getAttribute("name"),
      el.getAttribute("id"),
      el.getAttribute("autocomplete"),
      el.getAttribute("aria-label"),
      el.getAttribute("placeholder"),
      el.getAttribute("data-rpa-sensitive"),
    ].filter(Boolean).join(" ");
  }

  const styles = [];
  const visitedRoots = new WeakSet();
  let maskedFields = 0;
  let maskedTextNodes = 0;
  let maskedShadowRoots = 0;
  let maskedFrames = 0;
  let maskedCrossOriginFrames = 0;
  let skippedFrames = 0;

  function installStyle(root) {
    const ownerDocument = root.nodeType === 9 ? root : (root.ownerDocument || document);
    const style = ownerDocument.createElement("style");
    style.id = "__rpa_visual_evidence_mask_style";
    style.textContent = [
      "input[type='password'], input[type='email'], input[type='tel'],",
      "input[autocomplete*='cc-'], input[autocomplete*='password'], input[autocomplete*='one-time-code'],",
      "textarea[data-rpa-sensitive], [data-rpa-sensitive='true'], [contenteditable='true'][data-rpa-sensitive='true'] {",
      "  color: transparent !important; caret-color: transparent !important;",
      "  text-shadow: none !important; background: #111827 !important;",
      "  border-color: #111827 !important;",
      "}",
      "input::placeholder, textarea::placeholder { color: transparent !important; }",
    ].join("\n");
    const target = root.nodeType === 11 ? root : ownerDocument.documentElement;
    if (target) {
      target.appendChild(style);
      styles.push(style);
    }
  }

  function maskFieldsIn(root) {
    const fields = root.querySelectorAll("input, textarea, [contenteditable='true']");
    for (const el of fields) {
      const input = el;
      const type = (input.getAttribute("type") || "").toLowerCase();
      const sensitive = type === "password" || type === "email" || type === "tel" || sensitiveAttr.test(attrText(input));
      if (!sensitive) continue;
      if ("value" in input && typeof input.value === "string") {
        originals.push({ node: input, prop: "value", value: input.value });
        input.value = input.value.length > 0 ? "[REDACTED]" : "";
        maskedFields += 1;
      } else {
        originals.push({ node: input, prop: "textContent", value: input.textContent });
        input.textContent = input.textContent && input.textContent.length > 0 ? "[REDACTED]" : "";
        maskedFields += 1;
      }
    }
  }

  function maskTextNodesIn(root) {
    const doc = root.nodeType === 9 ? root : (root.ownerDocument || document);
    const walkerRoot = root.nodeType === 9 ? (root.body || root.documentElement) : root;
    if (!walkerRoot) return;
    const walker = doc.createTreeWalker(walkerRoot, 4, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent) return 2;
        if (/^(SCRIPT|STYLE|NOSCRIPT|TEXTAREA)$/i.test(parent.tagName)) return 2;
        const value = node.nodeValue || "";
        return maskText(value) !== value ? 1 : 3;
      },
    });
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      originals.push({ node, prop: "nodeValue", value: node.nodeValue });
      node.nodeValue = maskText(node.nodeValue || "");
      maskedTextNodes += 1;
    }
  }

  function maskFrameElement(frame) {
    originals.push({ node: frame, prop: "styleAttribute", value: frame.getAttribute("style") });
    frame.style.visibility = "hidden";
    frame.style.background = "#111827";
    frame.style.borderColor = "#111827";
    maskedCrossOriginFrames += 1;
  }

  function visitRoot(root, isShadowRoot) {
    if (!root || visitedRoots.has(root) || typeof root.querySelectorAll !== "function") return;
    visitedRoots.add(root);
    installStyle(root);
    maskFieldsIn(root);
    maskTextNodesIn(root);
    if (isShadowRoot) maskedShadowRoots += 1;

    for (const el of root.querySelectorAll("*")) {
      if (el.shadowRoot) visitRoot(el.shadowRoot, true);
    }
    for (const frame of root.querySelectorAll("iframe, frame")) {
      try {
        const frameDocument = frame.contentDocument;
        if (frameDocument && frameDocument.documentElement) {
          visitRoot(frameDocument, false);
          maskedFrames += 1;
        } else {
          maskFrameElement(frame);
        }
      } catch {
        try {
          maskFrameElement(frame);
        } catch {
          skippedFrames += 1;
        }
      }
    }
  }

  visitRoot(document, false);

  window[KEY] = {
    maskedFields,
    maskedTextNodes,
    maskedShadowRoots,
    maskedFrames,
    maskedCrossOriginFrames,
    skippedFrames,
    restore() {
      for (let i = originals.length - 1; i >= 0; i -= 1) {
        const item = originals[i];
        if (item.prop === "styleAttribute") {
          if (item.value === null) item.node.removeAttribute("style");
          else item.node.setAttribute("style", item.value);
        } else {
          item.node[item.prop] = item.value;
        }
      }
      for (let i = styles.length - 1; i >= 0; i -= 1) styles[i].remove();
      delete window[KEY];
    },
  };

  return { maskedFields, maskedTextNodes, maskedShadowRoots, maskedFrames, maskedCrossOriginFrames, skippedFrames };
})()
`;

const VISUAL_EVIDENCE_MASK_CLEAR_SCRIPT = String.raw`
(() => {
  const KEY = "__rpaVisualEvidenceMask";
  const state = window[KEY];
  if (state && typeof state.restore === "function") {
    state.restore();
    return { restored: true };
  }
  return { restored: false };
})()
`;
