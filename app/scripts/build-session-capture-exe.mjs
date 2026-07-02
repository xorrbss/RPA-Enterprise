#!/usr/bin/env node
/**
 * 세션 등록 도우미 단일 실행파일 빌드 (Node SEA — single executable application).
 *
 * 목적: 운영자 PC(저장소·Node.js 없음)에서 "다운로드 → 실행 → 로그인" 3단계로 세션 등록이 완주되도록
 * session-capture-helper CLI 를 실행파일 하나로 패키징한다(감사 session-capture-cli-cliff 근본 해소).
 *
 * 파이프라인: esbuild(단일 CJS 번들, 엔트리 session-capture-helper-main) → SEA blob 생성
 *   (node --experimental-sea-config) → node 실행파일 복사 → postject 로 blob 주입 → 무인자 smoke
 *   (USAGE + exit 2 — Chrome 없이 임베드 런타임 자가검증) → SHA-256 출력(배포 무결성 공지용).
 *
 * 번들 경계: 브라우저 계층은 capture-chrome-session(puppeteer-core 직결)이라 Stagehand/LLM SDK/pino 가
 *   그래프에 없다. ws 의 선택적 native 가속(bufferutil/utf-8-validate)은 external — 실행 시 모듈 부재를
 *   ws 가 try/catch 로 감지해 순수 JS 구현으로 폴백한다(기능 등가).
 *
 * 실행: npm --prefix app run build:session-capture-exe   (app 의존성 설치 필요)
 * 산출: app/dist/session-capture/rpa-session-capture.exe
 * 주의: SEA 는 크로스컴파일이 없다 — 배포 대상 OS/아키텍처(운영자 PC=Windows x64)에서 빌드한다.
 *   코드 서명은 인증서 오너의 비-코드 절차 — docs/staging-deploy-runbook.md '세션 등록 도우미' 절 참고.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(appDir, "dist", "session-capture");
const bundlePath = join(outDir, "session-capture-helper.cjs");
const seaConfigPath = join(outDir, "sea-config.json");
const blobPath = join(outDir, "sea-prep.blob");
const exeName = process.platform === "win32" ? "rpa-session-capture.exe" : "rpa-session-capture";
const exePath = join(outDir, exeName);

const nodeMajor = Number(process.versions.node.split(".")[0]);
if (Number.isNaN(nodeMajor) || nodeMajor < 22) {
  console.error(`Node ${process.versions.node} 미지원 — SEA 빌드는 Node 22+(CI 핀 24) 필요.`);
  process.exit(1);
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

// 1) esbuild — 단일 CJS 번들(SEA 는 CJS 엔트리만 수용).
const { build } = await import("esbuild");
await build({
  absWorkingDir: appDir,
  entryPoints: [join(appDir, "src", "browser-helper", "session-capture-helper-main.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: `node${nodeMajor}`,
  outfile: bundlePath,
  external: ["bufferutil", "utf-8-validate"], // ws 선택적 native 가속 — 부재 시 ws 순수 JS 폴백(try/catch)
  legalComments: "none",
  logLevel: "info",
});

// 2) SEA 준비 blob 생성.
writeFileSync(
  seaConfigPath,
  JSON.stringify({ main: bundlePath, output: blobPath, disableExperimentalSEAWarning: true }, null, 2),
);
runOrDie(process.execPath, ["--experimental-sea-config", seaConfigPath], "SEA blob 생성");

// 3) node 실행파일 복사 → postject 주입.
copyFileSync(process.execPath, exePath);
const { inject } = await import("postject");
await inject(exePath, "NODE_SEA_BLOB", readFileSync(blobPath), {
  sentinelFuse: "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
});

// 4) 무인자 smoke — 임베드 런타임이 뜨고 USAGE + exit 2 로 종료해야 한다(Chrome/네트워크 불요).
const smoke = spawnSync(exePath, [], {
  encoding: "utf8",
  env: { ...process.env, RPA_OPERATOR_TOKEN: "" },
  timeout: 60_000,
});
if (smoke.status !== 2 || !`${smoke.stderr ?? ""}`.includes("사용법")) {
  console.error(
    `smoke 실패 — 기대(exit 2 + USAGE), 실제 exit=${String(smoke.status)} stderr=${(smoke.stderr ?? "").slice(0, 500)}`,
  );
  process.exit(1);
}

// 5) 배포 무결성 해시(사내 공유 게시 시 공지) + 결과 요약.
const sha256 = createHash("sha256").update(readFileSync(exePath)).digest("hex");
const sizeMb = (statSync(exePath).size / (1024 * 1024)).toFixed(1);
console.log("");
console.log(`✓ 세션 등록 도우미 빌드 완료: ${exePath}`);
console.log(`  size=${sizeMb}MB sha256=${sha256}`);
console.log("  배포·코드 서명 절차: docs/staging-deploy-runbook.md '세션 등록 도우미' 절 참고");

function runOrDie(cmd, args, label) {
  const res = spawnSync(cmd, args, { stdio: "inherit", cwd: appDir });
  if (res.status !== 0) {
    console.error(`${label} 실패 (exit ${String(res.status)})`);
    process.exit(1);
  }
}
