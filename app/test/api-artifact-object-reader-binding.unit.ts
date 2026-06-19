import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ObjectRef } from "../../ts/core-types";
import { SchemeRoutingArtifactObjectReader, buildApiArtifactObjectReader } from "../src/api/artifact-object-reader-binding";
import type { ArtifactObjectReader } from "../src/api/server";

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail !== undefined ? ` -- ${detail}` : ""}`);
  }
}

class FakeReader implements ArtifactObjectReader {
  readonly refs: string[] = [];

  constructor(private readonly name: string) {}

  async get(objectRef: ObjectRef): Promise<string | null> {
    this.refs.push(String(objectRef));
    return `${this.name}:${String(objectRef)}`;
  }

  async getBytes(objectRef: ObjectRef): Promise<Uint8Array | null> {
    this.refs.push(String(objectRef));
    return new TextEncoder().encode(`${this.name}:${String(objectRef)}`);
  }
}

const fs = new FakeReader("fs");
const s3 = new FakeReader("s3");
const router = new SchemeRoutingArtifactObjectReader({ fs, s3, s3Bucket: "rpa-artifacts" });

const fileRef = "file:///var/lib/rpa/artifacts/screen.png" as ObjectRef;
check("file refs route to fs reader", await router.get(fileRef) === `fs:${fileRef}`);
check("file raw bytes route to fs reader", new TextDecoder().decode(await router.getBytes(fileRef) ?? new Uint8Array()) === `fs:${fileRef}`);
check("fs reader saw file refs", fs.refs.length === 2 && fs.refs.every((ref) => ref === fileRef), fs.refs.join(","));

const s3Ref = "s3://rpa-artifacts/run-video.webm" as ObjectRef;
check("configured s3 bucket routes to s3 reader", await router.get(s3Ref) === `s3:${s3Ref}`);
check("configured s3 bucket raw bytes route to s3 reader", new TextDecoder().decode(await router.getBytes(s3Ref) ?? new Uint8Array()) === `s3:${s3Ref}`);
check("s3 reader saw configured bucket refs", s3.refs.length === 2 && s3.refs.every((ref) => ref === s3Ref), s3.refs.join(","));

const wrongBucket = "s3://other-bucket/run-video.webm" as ObjectRef;
check("wrong s3 bucket fails closed as missing", await router.get(wrongBucket) === null);
check("wrong s3 bucket raw bytes fail closed as missing", await router.getBytes(wrongBucket) === null);

const fsOnly = new SchemeRoutingArtifactObjectReader({ fs: new FakeReader("fs-only") });
check("s3 ref without s3 reader fails closed as missing", await fsOnly.get(s3Ref) === null);
check("unknown scheme fails closed as missing", await router.get("object://legacy/ref" as ObjectRef) === null);

check("no configured reader returns undefined", (await buildApiArtifactObjectReader({})) === undefined);

const dir = mkdtempSync(join(tmpdir(), "rpa-api-artifact-reader-"));
try {
  const built = await buildApiArtifactObjectReader({ artifactDir: dir });
  check("fs-only build returns a reader", built !== undefined);
  check("fs-only build does not try to resolve s3 refs", built !== undefined && (await built.get(s3Ref)) === null);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\nFAIL: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nPASS: api artifact object reader binding unit green");
