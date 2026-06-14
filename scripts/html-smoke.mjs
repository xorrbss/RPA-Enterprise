#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const html = readFileSync(join(ROOT, "rpa_enterprise_console.html"), "utf8");
const failures = [];
const viewSpecs = extractViewSpecs(html);
const viewKeys = viewSpecs.map(([key]) => key);
const requiredRouteKeys = ["dashboard", "openGate", "workitems"];

const requiredText = [
  "<!doctype html>",
  "id=\"content\"",
  "route-progress",
  "const viewMeta",
  "const views",
  "function viewFromHash",
  "hashchange",
  "function emptyState",
  "function errorState",
  "data-view-target",
  "data-state-evidence=\"loading\"",
  "data-state-evidence=\"empty\"",
  "data-state-evidence=\"error\"",
  "백엔드 호출 없음",
];

const navTargets = [...html.matchAll(/data-view-target="([^"]+)"/g)].map((match) => match[1]);
const uniqueNavTargets = [...new Set(navTargets)];

for (const needle of requiredText) {
  if (!html.includes(needle)) failures.push(`missing ${needle}`);
}

for (const [key, title] of viewSpecs) {
  if (!new RegExp(`\\n\\s*${key}:\\s*\\(\\)\\s*=>`).test(html)) failures.push(`missing view renderer ${key}`);
  if (!html.includes(`data-view-target="${key}"`)) failures.push(`missing nav target ${key}`);
  if (!html.includes(`${key}: ["${title}"`)) failures.push(`missing viewMeta title for ${key}`);
}

for (const key of requiredRouteKeys) {
  if (!viewKeys.includes(key)) failures.push(`missing required route ${key}`);
}

if (uniqueNavTargets.length !== viewKeys.length) {
  failures.push(`expected ${viewKeys.length} unique nav targets, got ${uniqueNavTargets.length}`);
}

for (const target of uniqueNavTargets) {
  if (!viewKeys.includes(target)) failures.push(`unexpected nav target ${target}`);
}

for (const forbidden of backendCallPatterns()) {
  if (forbidden.pattern.test(html)) failures.push(`standalone mockup must not call ${forbidden.name}`);
}

for (const [index, line] of html.split(/\r?\n/).entries()) {
  if (line.startsWith("<<<<<<<") || line === "=======" || line.startsWith(">>>>>>>")) {
    failures.push(`unresolved merge conflict marker at line ${index + 1}`);
  }
}

if (failures.length > 0) {
  console.error(`html smoke: ${failures.length} failed`);
  for (const failure of failures) console.error(`FAIL: ${failure}`);
  process.exit(1);
}

console.log(`html smoke: standalone console structure is present (${viewKeys.length} views)`);
console.log(`html smoke: routes=${viewKeys.join(", ")}`);
console.log("html smoke: state evidence=route-progress/loading, empty-state, error-state; backend calls=none");

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
