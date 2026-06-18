/**
 * Manual smoke for the visual evidence video encoder command.
 *
 * Usage:
 *   VISUAL_EVIDENCE_FFMPEG_PATH=/path/to/ffmpeg npm --prefix app run smoke:video-recorder
 *
 * This is intentionally not part of test:unit. It validates that the configured ffmpeg binary can turn
 * screenshot-frame PNGs into a non-empty WebM using the same codec flags as PgScreenshotFrameVideoRecorder.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { deflateSync } from "node:zlib";

const execFileAsync = promisify(execFile);

const ffmpegPath = process.env.VISUAL_EVIDENCE_FFMPEG_PATH ?? process.env.FFMPEG_PATH ?? "ffmpeg";
const tempDir = await mkdtemp(join(tmpdir(), "rpa-video-smoke-"));

try {
  await writeFile(join(tempDir, "frame-000001.png"), pngRgba(4, 4, [42, 74, 128, 255]));
  await writeFile(join(tempDir, "frame-000002.png"), pngRgba(4, 4, [222, 89, 64, 255]));
  const outputPath = join(tempDir, "run.webm");
  await execFileAsync(
    ffmpegPath,
    [
      "-loglevel",
      "error",
      "-y",
      "-framerate",
      "1",
      "-start_number",
      "1",
      "-i",
      join(tempDir, "frame-%06d.png"),
      "-c:v",
      "libvpx-vp9",
      "-pix_fmt",
      "yuv420p",
      "-an",
      outputPath,
    ],
    { maxBuffer: 1024 * 1024 },
  );
  const bytes = await readFile(outputPath);
  if (bytes.byteLength === 0 || !hasWebmSignature(bytes)) {
    throw new Error(`ffmpeg smoke produced invalid WebM bytes (${bytes.byteLength} bytes)`);
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  console.log(`PASS: video recorder ffmpeg smoke produced ${bytes.byteLength} WebM bytes sha256=${sha256}`);
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

function hasWebmSignature(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3;
}

function pngRgba(width: number, height: number, rgba: readonly [number, number, number, number]): Buffer {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (width * 4 + 1);
    raw[rowStart] = 0;
    for (let x = 0; x < width; x += 1) {
      const offset = rowStart + 1 + x * 4;
      raw[offset] = rgba[0];
      raw[offset + 1] = rgba[1];
      raw[offset + 2] = rgba[2];
      raw[offset + 3] = rgba[3];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.byteLength, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0);
  return Buffer.concat([length, typeBytes, data, crc]);
}

var crcTable: Uint32Array | undefined;

function crc32(bytes: Uint8Array): number {
  const table = getCrcTable();
  let c = 0xffffffff;
  for (const byte of bytes) {
    c = table[(c ^ byte) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function getCrcTable(): Uint32Array {
  if (crcTable !== undefined) return crcTable;
  crcTable = new Uint32Array(256).map((_unused, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    return c >>> 0;
  });
  return crcTable;
}
