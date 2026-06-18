import { mergeExtractOutputs, recordsFromExtractOutput } from "../src/runtime/extract-result-merge";

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` -- ${detail}` : ""}`);
  }
}

function notice(seq: number): Record<string, unknown> {
  return {
    SEQ: seq,
    BBSCTT_ID: `bbs-${seq}`,
    title: `Notice ${seq}`,
    author: "Samsung",
  };
}

async function main(): Promise<void> {
  {
    const page1 = { rows: Array.from({ length: 20 }, (_, index) => notice(index + 1)) };
    const page2 = { records: Array.from({ length: 14 }, (_, index) => notice(index + 20)) };
    const merged = mergeExtractOutputs([page1, page2], { naturalKeys: ["SEQ"] });
    check("merge: Samsung-like 20+14 with one repeated SEQ dedupes to 33", merged.records.length === 33, `records=${merged.records.length}`);
    check("merge: duplicate count tracks repeated page boundary row", merged.duplicateCount === 1, `dupes=${merged.duplicateCount}`);
    check("merge: preserves first-page order", (merged.records[0] as { SEQ?: unknown }).SEQ === 1 && (merged.records[19] as { SEQ?: unknown }).SEQ === 20);
  }

  {
    const nested = { grid: { data: [notice(1), notice(2)] }, paging: { totalCount: 2 } };
    const records = recordsFromExtractOutput(nested);
    check("records: reads nested grid.data arrays", records.length === 2 && (records[1] as { SEQ?: unknown }).SEQ === 2);
  }

  {
    const merged = mergeExtractOutputs([
      { items: [{ b: 2, a: 1 }] },
      { rows: [{ a: 1, b: 2 }] },
    ]);
    check("merge: stable JSON fallback dedupes key-order-only duplicates", merged.records.length === 1 && merged.duplicateCount === 1);
  }

  if (failures > 0) {
    console.error(`\nFAIL: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nPASS: extract result merge unit green");
  process.exit(0);
}

main().catch((e) => {
  console.error("extract-result-merge unit fatal:", e);
  process.exit(1);
});
