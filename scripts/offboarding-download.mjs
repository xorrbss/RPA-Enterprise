#!/usr/bin/env node
/**
 * 오프보딩 데이터 패키지 다운로드 도우미.
 *
 * 왜 있나: 오프보딩하는 테넌트는 자신의 업무 원문(runs.params, human task payload/result, redacted artifact 본문)을
 *   돌려받을 권리가 있다(설계 docs/rpa-offboarding-data-export-deletion-design-2026-07-03.md §5 O1). 서버는 경계
 *   (RLS/RBAC/fail-closed audit)만 제공하고, "패키지"는 admin 토큰 소유자가 이 스크립트로 클라이언트 측에서 조립한다
 *   (서버측 zip 패키징은 새 민감 저장물을 만들어 lifecycle 을 자기증식시키므로 기각 — 설계 §5 O1).
 *
 * 의존성 없음: Node 18+ 내장 fetch 만 사용 → `npm install` 없이 어느 배포 셸에서도 실행된다(mint-operator-token 선례).
 *
 * 사용:
 *   RPA_OPERATOR_TOKEN=<admin JWT> \
 *     node scripts/offboarding-download.mjs --api <http(s)://host:port> --out <dir> [--from <ISO>] [--to <ISO>] [--limit <n>]
 *
 * 산출물(--out 디렉터리):
 *   offboarding-metadata.csv  — metadata export(사람이 읽는 목록; artifact 목록의 출처)
 *   runs.jsonl                — runs 원문(run_id/scenario/created_at/params) — 기계 재수입용 JSON Lines
 *   human_tasks.jsonl         — human task 원문(payload/result/result_schema/payload_ref)
 *   artifacts/<id>__<name>    — artifact 본문(redacted/not_required 만 — 서버 RLS 게이트가 강제)
 *   manifest.json             — 건수/실패 목록(부분 실패는 조용히 넘어가지 않는다)
 *
 * 종료 코드: 0=전량 성공(빈 테넌트 포함 — 0건도 정상 상태로 명시 보고) / 1=부분 실패(artifact 다운로드 실패 잔존)
 *   / 2=구성·요청 오류(토큰 부재, API 오류 등). 진단은 stderr, 산출물은 --out 디렉터리에만 쓴다.
 */
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";

// process.exit() 금지: fetch 직후 즉시 종료는 Windows 에서 undici teardown 경쟁으로 libuv assert(0xC0000409)를
// 일으켜 종료 코드가 깨진다 — exitCode 를 설정하고 자연 drain 한다(capture helper 선례 교훈).
class CliFailure extends Error {}

function fail(lines) {
  console.error(["FAIL:", ...lines.map((line) => `  ${line}`)].join("\n"));
  process.exitCode = 2;
  throw new CliFailure("offboarding-download failed");
}

function printUsage() {
  console.error(
    [
      "Usage: RPA_OPERATOR_TOKEN=<admin JWT> node scripts/offboarding-download.mjs --api <base> --out <dir> [options]",
      "",
      "Required:",
      "  --api <base>      API 서버 베이스 URL(예: https://rpa.example.com 또는 http://localhost:8080).",
      "                    스크립트가 /v1/... 경로를 덧붙인다.",
      "  --out <dir>       산출물 디렉터리(없으면 생성).",
      "",
      "Options:",
      "  --from <ISO>      created_at 하한(포함, ISO-8601). 미지정 시 전체.",
      "  --to <ISO>        created_at 상한(포함, ISO-8601). 미지정 시 전체.",
      "  --limit <n>       원문 JSONL 페이지 크기(기본 1000, 서버 상한 5000).",
      "  --help, -h        이 도움말.",
      "",
      "Environment:",
      "  RPA_OPERATOR_TOKEN  admin 역할 JWT(tenant_data.export 권한). 필수. 토큰은 출력하지 않는다.",
    ].join("\n"),
  );
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") return { help: true };
    if (!arg.startsWith("--")) fail([`unexpected argument: ${arg}`, "run with --help for usage."]);
    const key = arg.slice(2);
    const known = ["api", "out", "from", "to", "limit"];
    if (!known.includes(key)) fail([`unknown option: ${arg}`, "run with --help for usage."]);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) fail([`option ${arg} requires a value.`]);
    out[key] = value;
    i += 1;
  }
  return out;
}

/** 서버 csvRow(전 셀 인용, "" 이스케이프) 형식의 섹션형 CSV 파서 — 인용 내 개행/쉼표 안전. */
function parseCsv(text) {
  const body = text.startsWith("\uFEFF") ? text.slice(1) : text;
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;
  let cellStarted = false;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (inQuotes) {
      if (ch === '"') {
        if (body[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      cellStarted = true;
      continue;
    }
    if (ch === ",") {
      row.push(cell);
      cell = "";
      cellStarted = false;
      continue;
    }
    if (ch === "\n") {
      if (cellStarted || cell.length > 0 || row.length > 0) {
        row.push(cell);
        rows.push(row);
      } else {
        rows.push([]); // 빈 줄 = 섹션 구분자
      }
      row = [];
      cell = "";
      cellStarted = false;
      continue;
    }
    if (ch === "\r") continue;
    cell += ch;
    cellStarted = true;
  }
  if (cellStarted || cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

/** 섹션형 CSV 에서 이름이 일치하는 섹션의 데이터 행을 헤더 키 기반 객체로 반환. */
function csvSectionObjects(rows, sectionName) {
  const items = [];
  let inSection = false;
  let header = null;
  for (const row of rows) {
    if (row.length >= 2 && row[0] === "section") {
      inSection = row[1] === sectionName;
      header = null;
      continue;
    }
    if (!inSection || row.length === 0) continue;
    if (header === null) {
      header = row;
      continue;
    }
    const obj = {};
    for (let i = 0; i < header.length; i += 1) obj[header[i]] = row[i] ?? "";
    items.push(obj);
  }
  return items;
}

function sanitizeArtifactFilename(filename) {
  if (typeof filename !== "string" || filename.length === 0) return "artifact.bin";
  // 서버 formula guard 가 붙인 선행 ' 제거 + 경로/제어문자 무해화.
  const cleaned = filename.replace(/^'/, "").replace(/[\\/:*?"<>|\x00-\x1f\x7f]+/g, "_").trim();
  if (cleaned.length === 0 || cleaned === "." || cleaned === "..") return "artifact.bin";
  return cleaned.slice(0, 100);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help === true) {
    printUsage();
    return;
  }
  if (typeof fetch !== "function") {
    fail(["Node 18+ 가 필요합니다(내장 fetch)."]);
  }
  const token = process.env.RPA_OPERATOR_TOKEN ?? "";
  if (token.length === 0) {
    fail([
      "RPA_OPERATOR_TOKEN environment variable is required (fail-closed).",
      "admin 역할(tenant_data.export 권한) JWT 를 넣으세요(scripts/mint-operator-token.mjs 또는 IdP 발급).",
    ]);
  }
  const api = args.api;
  if (api === undefined || !/^https?:\/\//.test(api)) {
    fail(["--api <base> is required and must start with http:// or https://.", "run with --help for usage."]);
  }
  const base = api.replace(/\/+$/, "");
  const outDir = args.out;
  if (outDir === undefined || outDir.length === 0) {
    fail(["--out <dir> is required.", "run with --help for usage."]);
  }
  for (const key of ["from", "to"]) {
    if (args[key] !== undefined && Number.isNaN(Date.parse(args[key]))) {
      fail([`--${key} must be an ISO-8601 timestamp, got "${args[key]}".`]);
    }
  }
  if (args.limit !== undefined && !/^\d+$/.test(args.limit)) {
    fail([`--limit must be a positive integer, got "${args.limit}".`]);
  }
  const limit = args.limit ?? "1000";

  mkdirSync(outDir, { recursive: true });
  mkdirSync(join(outDir, "artifacts"), { recursive: true });

  const rangeParams = new URLSearchParams();
  if (args.from !== undefined) rangeParams.set("created_at_from", args.from);
  if (args.to !== undefined) rangeParams.set("created_at_to", args.to);

  const headers = { authorization: `Bearer ${token}` };

  async function get(path, params) {
    const search = params !== undefined && [...params.keys()].length > 0 ? `?${params.toString()}` : "";
    const url = `${base}${path}${search}`;
    let res;
    try {
      res = await fetch(url, { headers });
    } catch (err) {
      fail([`request failed: GET ${url}`, err instanceof Error ? err.message : String(err)]);
    }
    return res;
  }

  async function requireOk(res, what) {
    if (res.ok) return res;
    const body = await res.text().catch(() => "");
    fail([`${what} -> HTTP ${res.status}`, body.slice(0, 500)]);
    return res; // unreachable (fail throws)
  }

  // ① metadata CSV — 사람이 읽는 목록 + artifact 본문 목록의 출처.
  console.error(`[1/3] metadata export 내려받는 중... (${base})`);
  const metadataRes = await requireOk(await get("/v1/offboarding/export", rangeParams), "offboarding metadata export");
  const metadataCsv = await metadataRes.text();
  writeFileSync(join(outDir, "offboarding-metadata.csv"), metadataCsv, "utf8");

  // ② 원문 JSONL — keyset 커서(x-next-cursor 헤더) 순회.
  const counts = { runs: 0, human_tasks: 0 };
  for (const section of ["runs", "human_tasks"]) {
    const file = join(outDir, `${section}.jsonl`);
    writeFileSync(file, "", "utf8"); // 빈 테넌트도 파일은 남긴다(0건 명시).
    let cursor = null;
    let pages = 0;
    for (;;) {
      const params = new URLSearchParams(rangeParams);
      params.set("section", section);
      params.set("limit", limit);
      if (cursor !== null) params.set("cursor", cursor);
      const res = await requireOk(await get("/v1/offboarding/export/raw", params), `raw export (${section})`);
      const body = await res.text();
      if (body.length > 0) {
        appendFileSync(file, body, "utf8");
        counts[section] += body.split("\n").filter((line) => line.length > 0).length;
      }
      const next = res.headers.get("x-next-cursor");
      pages += 1;
      if (next === null || next.length === 0) break;
      if (pages > 100000) fail([`raw export (${section}) exceeded 100000 pages — aborting (server cursor bug?).`]);
      cursor = next;
    }
    console.error(`[2/3] ${section}.jsonl — ${counts[section]}건`);
  }

  // ③ artifact 본문 — metadata CSV 의 artifacts 섹션(redacted/not_required·미삭제·비격리만)을 목록으로 blob 재사용.
  const artifactRows = csvSectionObjects(parseCsv(metadataCsv), "artifacts");
  let downloaded = 0;
  const failures = [];
  for (const row of artifactRows) {
    const id = row.artifact_id;
    if (typeof id !== "string" || id.length === 0) {
      failures.push({ artifact_id: String(id ?? ""), status: 0, detail: "missing artifact_id in metadata CSV" });
      continue;
    }
    const res = await get(`/v1/artifacts/${encodeURIComponent(id)}/blob`, undefined);
    if (!res.ok) {
      failures.push({ artifact_id: id, status: res.status });
      console.error(`  FAIL artifact ${id} -> HTTP ${res.status}`);
      continue;
    }
    const bytes = Buffer.from(await res.arrayBuffer());
    writeFileSync(join(outDir, "artifacts", `${id}__${sanitizeArtifactFilename(row.filename)}`), bytes);
    downloaded += 1;
  }
  console.error(`[3/3] artifacts — ${downloaded}/${artifactRows.length}건 저장${failures.length > 0 ? `, 실패 ${failures.length}건` : ""}`);

  const manifest = {
    schema_ref: "offboarding-download-manifest@1",
    generated_at: new Date().toISOString(),
    api: base,
    created_at_from: args.from ?? null,
    created_at_to: args.to ?? null,
    counts: {
      runs: counts.runs,
      human_tasks: counts.human_tasks,
      artifacts_listed: artifactRows.length,
      artifacts_downloaded: downloaded,
      artifacts_failed: failures.length,
    },
    // 부분 실패를 조용히 넘어가지 않는다 — 실패 목록을 남기고 비-0 종료.
    failures,
  };
  writeFileSync(join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  const total = counts.runs + counts.human_tasks + artifactRows.length;
  if (total === 0) {
    console.error("완료: 반출 대상 0건(빈 테넌트) — manifest.json 에 0건으로 기록했습니다.");
  } else {
    console.error(`완료: runs ${counts.runs} · human_tasks ${counts.human_tasks} · artifacts ${downloaded}/${artifactRows.length} → ${outDir}`);
  }
  if (failures.length > 0) {
    console.error(`FAIL: artifact ${failures.length}건 다운로드 실패 — manifest.json 의 failures 를 확인하세요.`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  if (!(err instanceof CliFailure)) {
    console.error("FAIL: offboarding download threw:", err);
    process.exitCode = 2;
  }
});
