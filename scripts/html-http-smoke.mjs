#!/usr/bin/env node
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

class FakeElement {
  constructor(id) {
    this.id = id;
    this.attributes = new Map();
    this.children = new Map();
    this.classList = new FakeClassList();
    this.dataset = {};
    this.hidden = false;
    this.offsetParent = {};
    this.style = {};
    this.textContent = "";
    this.value = "";
    this._innerHTML = "";
  }

  get innerHTML() {
    return this._innerHTML;
  }

  set innerHTML(value) {
    this._innerHTML = String(value);
  }

  addEventListener() {}
  appendChild() {}
  closest(selector) {
    if (selector === "[data-view-target]" && this.dataset.viewTarget) return this;
    if (selector === "[data-filter]" && this.dataset.filter) return this;
    if (selector === "[data-action]" && this.dataset.action) return this;
    return null;
  }
  focus() {}
  remove() {}

  querySelector(selector) {
    if (!this.children.has(selector)) this.children.set(selector, new FakeElement(`${this.id}:${selector}`));
    return this.children.get(selector);
  }

  querySelectorAll() {
    return [];
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }
}

class FakeClassList {
  constructor() {
    this.values = new Set();
  }

  add(...names) {
    for (const name of names) this.values.add(name);
  }

  remove(...names) {
    for (const name of names) this.values.delete(name);
  }

  contains(name) {
    return this.values.has(name);
  }

  toggle(name, force) {
    const on = force ?? !this.values.has(name);
    if (on) this.values.add(name);
    else this.values.delete(name);
    return on;
  }
}

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const htmlFile = join(ROOT, "rpa_enterprise_console.html");
const html = readFileSync(htmlFile, "utf8");
const failures = [];
const viewSpecs = extractViewSpecs(html);

checkInlineScripts(html);

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (request.method !== "GET") {
    response.writeHead(405, { allow: "GET" });
    response.end("method not allowed");
    return;
  }

  if (url.pathname !== "/" && url.pathname !== "/rpa_enterprise_console.html") {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("not found");
    return;
  }

  response.writeHead(200, {
    "cache-control": "no-store",
    "content-type": "text/html; charset=utf-8",
  });
  response.end(html);
});

const baseUrl = await listen(server);

try {
  const response = await fetch(`${baseUrl}/rpa_enterprise_console.html#openGate`);
  const servedHtml = await response.text();

  if (response.status !== 200) failures.push(`expected HTTP 200, got ${response.status}`);
  if (!/^text\/html;\s*charset=utf-8/i.test(response.headers.get("content-type") ?? "")) {
    failures.push("missing text/html; charset=utf-8 response header");
  }
  if (!servedHtml.includes("Product-open")) failures.push("served console is missing Product-open copy");
  if (!servedHtml.includes("data-view-target=\"openGate\"")) failures.push("served console is missing openGate nav target");
  for (const forbidden of backendCallPatterns()) {
    if (forbidden.pattern.test(servedHtml)) failures.push(`served console must not call ${forbidden.name}`);
  }
  runRouteSmoke(servedHtml);

  const notFound = await fetch(`${baseUrl}/not-a-contract-artifact`);
  if (notFound.status !== 404) failures.push(`expected HTTP 404 for unknown path, got ${notFound.status}`);
} finally {
  await close(server);
}

if (failures.length > 0) {
  console.error(`html http smoke: ${failures.length} failed`);
  for (const failure of failures) console.error(`FAIL: ${failure}`);
  process.exit(1);
}

console.log(`html http smoke: standalone console served and verified at ${baseUrl}`);
console.log(`html http smoke: hash routes=${viewSpecs.map(([key]) => `#${key}`).join(", ")}`);
console.log("html http smoke: network guard=fetch/XMLHttpRequest/WebSocket/EventSource/sendBeacon/import absent");

function checkInlineScripts(source) {
  const scripts = source.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi);
  let count = 0;
  for (const match of scripts) {
    count += 1;
    try {
      new vm.Script(match[1], { filename: `rpa_enterprise_console.html:inline-${count}.js` });
    } catch (error) {
      failures.push(`inline script ${count} syntax error: ${error.message}`);
    }
  }
  if (count === 0) failures.push("missing inline script");
}

function runRouteSmoke(source) {
  const script = getSingleInlineScript(source);
  if (!script) return;

  const harness = createDomHarness("#openGate");
  const context = vm.createContext({
    console,
    document: harness.document,
    location: harness.location,
    window: harness.window,
    setTimeout: (fn) => {
      if (typeof fn === "function") fn();
      return 0;
    },
    clearTimeout: () => {},
  });
  context.window.window = context.window;
  context.window.document = context.document;
  context.window.location = context.location;

  try {
    new vm.Script(script, { filename: "rpa_enterprise_console.html:runtime.js" }).runInContext(context);
  } catch (error) {
    failures.push(`inline runtime smoke failed during bootstrap: ${error.message}`);
    return;
  }

  if (typeof context.renderView !== "function") failures.push("renderView is not available for route smoke");
  if (typeof context.viewFromHash !== "function") failures.push("viewFromHash is not available for route smoke");
  if (typeof context.renderView !== "function" || typeof context.viewFromHash !== "function") return;

  const openGateTitle = titleFor("openGate");
  if (openGateTitle) {
    expectRoute(harness, "openGate", openGateTitle, "initial deep link #openGate");
    if (!harness.content.innerHTML.includes('data-state-evidence="ui-smoke"')) {
      failures.push("route #openGate is missing ui-smoke state evidence");
    }
  }

  for (const [key, title] of viewSpecs) {
    try {
      harness.location.hash = `#${key}`;
    } catch (error) {
      failures.push(`route #${key} failed to render from hashchange: ${error.message}`);
      continue;
    }

    expectRoute(harness, key, title, `hashchange #${key}`);
  }

  harness.location.hash = "#not-a-view";
  const dashboardTitle = titleFor("dashboard");
  if (dashboardTitle) expectRoute(harness, "dashboard", dashboardTitle, "invalid hash fallback");

  harness.location.hash = "#openGate";
  const workitemsTitle = titleFor("workitems");
  const workitemsNav = harness.navItems.find((item) => item.dataset.viewTarget === "workitems");
  if (!workitemsNav) {
    failures.push("missing workitems nav target for click route smoke");
  } else if (workitemsTitle) {
    try {
      harness.dispatchDocumentClick(workitemsNav);
      if (harness.location.hash !== "#workitems") {
        failures.push(`workitems click expected location.hash #workitems, got ${harness.location.hash || "(empty)"}`);
      }
      expectRoute(harness, "workitems", workitemsTitle, "nav click Product-open to workitems");
    } catch (error) {
      failures.push(`workitems nav click failed: ${error.message}`);
    }
  }

  if (context.viewFromHash() !== "workitems") {
    failures.push("viewFromHash did not reflect clicked workitems route");
  }
}

function expectRoute(harness, key, title, reason) {
  if (harness.pageTitle.textContent !== title) {
    failures.push(`${reason} expected title "${title}", got "${harness.pageTitle.textContent}"`);
  }
  if (!harness.content.innerHTML.trim()) failures.push(`${reason} rendered empty content`);

  const activeTargets = harness.navItems
    .filter((item) => item.classList.contains("active"))
    .map((item) => item.dataset.viewTarget);
  if (activeTargets.length !== 1 || activeTargets[0] !== key) {
    failures.push(`${reason} active nav mismatch: ${activeTargets.join(",") || "(none)"}`);
  }
}

function getSingleInlineScript(source) {
  const scripts = [...source.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)];
  if (scripts.length !== 1) {
    failures.push(`expected 1 inline script for runtime smoke, got ${scripts.length}`);
    return null;
  }
  return scripts[0][1];
}

function backendCallPatterns() {
  return [
    { name: "fetch()", pattern: /\bfetch\s*\(/ },
    { name: "XMLHttpRequest", pattern: /\bXMLHttpRequest\b/ },
    { name: "WebSocket", pattern: /\bnew\s+WebSocket\s*\(|\bWebSocket\s*\(/ },
    { name: "EventSource", pattern: /\bnew\s+EventSource\s*\(|\bEventSource\s*\(/ },
    { name: "navigator.sendBeacon()", pattern: /\bnavigator\.sendBeacon\s*\(/ },
    { name: "axios", pattern: /\baxios\s*\./ },
    { name: "dynamic import()", pattern: /\bimport\s*\(/ },
  ];
}

function createDomHarness(initialHash = "") {
  const elements = new Map();
  const listeners = new Map();
  const navItems = viewSpecs.map(([key]) => {
    const item = new FakeElement(`nav:${key}`);
    item.dataset.viewTarget = key;
    return item;
  });

  const document = {
    activeElement: null,
    addEventListener: (type, handler) => addListener("document", type, handler),
    getElementById: (id) => getElement(id),
    querySelectorAll: (selector) => {
      if (selector === "[data-view-target]") return navItems;
      if (selector === "svg.lucide") return [];
      if (selector === "[data-filter]" || selector === "[data-run-row]") return [];
      return [];
    },
  };
  const location = {};
  let hashValue = normalizeHash(initialHash);
  Object.defineProperty(location, "hash", {
    get: () => hashValue,
    set: (value) => {
      const next = normalizeHash(value);
      if (next === hashValue) return;
      const oldHash = hashValue;
      hashValue = next;
      dispatch("window", "hashchange", {
        oldURL: `http://127.0.0.1/rpa_enterprise_console.html${oldHash}`,
        newURL: `http://127.0.0.1/rpa_enterprise_console.html${hashValue}`,
      });
    },
  });
  const window = {
    addEventListener: (type, handler) => addListener("window", type, handler),
    scrollTo: () => {},
    lucide: null,
  };

  const content = getElement("content");
  content.innerHTML = "<section>dashboard shell</section>";
  const pageTitle = getElement("pageTitle");
  const pageSubtitle = getElement("pageSubtitle");

  return {
    content,
    dispatchDocumentClick: (target) => dispatch("document", "click", { target }),
    document,
    location,
    navItems,
    pageSubtitle,
    pageTitle,
    window,
  };

  function getElement(id) {
    if (!elements.has(id)) elements.set(id, new FakeElement(id));
    return elements.get(id);
  }

  function addListener(scope, type, handler) {
    const key = `${scope}:${type}`;
    if (!listeners.has(key)) listeners.set(key, []);
    listeners.get(key).push(handler);
  }

  function dispatch(scope, type, event) {
    for (const handler of listeners.get(`${scope}:${type}`) ?? []) handler(event);
  }
}

function extractViewSpecs(source) {
  const match = source.match(/const\s+viewMeta\s*=\s*\{([\s\S]*?)\n\s*\};/);
  if (!match) {
    failures.push("missing viewMeta object");
    return [];
  }

  const specs = [...match[1].matchAll(/^\s*([A-Za-z][\w$]*):\s*\[\s*"([^"]+)"/gm)]
    .map((entry) => [entry[1], entry[2]]);
  if (specs.length === 0) failures.push("viewMeta has no route entries");
  return specs;
}

function titleFor(key) {
  const spec = viewSpecs.find(([view]) => view === key);
  if (!spec) failures.push(`missing route title for ${key}`);
  return spec?.[1] ?? null;
}

function normalizeHash(value) {
  const text = String(value ?? "");
  if (!text) return "";
  return text.startsWith("#") ? text : `#${text}`;
}

function listen(instance) {
  return new Promise((resolve, reject) => {
    instance.once("error", reject);
    instance.listen(0, "127.0.0.1", () => {
      const address = instance.address();
      if (!address || typeof address === "string") {
        reject(new Error("unexpected server address"));
        return;
      }
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function close(instance) {
  return new Promise((resolve, reject) => {
    instance.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
