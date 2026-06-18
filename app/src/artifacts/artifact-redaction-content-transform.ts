import { deflateSync } from "node:zlib";

import { ContentRedactionTransform, UnredactableContentError } from "./content-redaction-transform";
import type {
  ArtifactContentTransform,
  ArtifactContentTransformMeta,
} from "./s3-artifact-redactor";

export class ArtifactRedactionContentTransform implements ArtifactContentTransform {
  constructor(private readonly textTransform: ArtifactContentTransform = new ContentRedactionTransform()) {}

  async transform(
    bytes: Uint8Array,
    meta: ArtifactContentTransformMeta,
  ): Promise<{ kind: "redacted"; bytes: Uint8Array } | { kind: "not_required"; reason: string }> {
    const captureMasked = captureMaskedVisualKind(meta.type);
    if (captureMasked === "image") {
      return { kind: "redacted", bytes };
    }
    if (captureMasked === "video") {
      if (!hasVideoSignature(bytes)) {
        throw new UnredactableContentError("capture-masked video missing video signature");
      }
      return { kind: "redacted", bytes };
    }
    const media = classifyMedia(bytes, meta.type);
    if (media === "image") {
      return { kind: "redacted", bytes: redactedVisualPlaceholderPng() };
    }
    if (media === "video") {
      throw new UnredactableContentError(
        "video artifact media redaction requires a stream/frame redaction port and is not auto-redactable",
      );
    }
    return this.textTransform.transform(bytes, meta);
  }
}

export function redactedVisualPlaceholderPng(): Uint8Array {
  return PLACEHOLDER_PNG_BYTES;
}

function captureMaskedVisualKind(type: string | undefined): "image" | "video" | undefined {
  const normalized = (type ?? "").toLowerCase();
  if (normalized === "screenshot_masked") return "image";
  if (normalized === "video_masked") return "video";
  return undefined;
}

function classifyMedia(bytes: Uint8Array, type: string | undefined): "image" | "video" | "text_or_unknown" {
  const normalized = (type ?? "").toLowerCase();
  if (/\b(video|mp4|webm|mov|avi|mkv)\b/.test(normalized)) return "video";
  if (/\b(screenshot|image|png|jpeg|jpg|gif|webp|bmp|tiff|vlm_input)\b/.test(normalized)) return "image";
  if (hasImageSignature(bytes)) return "image";
  if (hasVideoSignature(bytes)) return "video";
  return "text_or_unknown";
}

function hasImageSignature(bytes: Uint8Array): boolean {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return true;
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return true;
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return true;
  if (
    bytes.length >= 12 &&
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return true;
  }
  return false;
}

function hasVideoSignature(bytes: Uint8Array): boolean {
  if (
    bytes.length >= 12 &&
    bytes[4] === 0x66 &&
    bytes[5] === 0x74 &&
    bytes[6] === 0x79 &&
    bytes[7] === 0x70
  ) {
    return true;
  }
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x1a &&
    bytes[1] === 0x45 &&
    bytes[2] === 0xdf &&
    bytes[3] === 0xa3
  ) {
    return true;
  }
  return false;
}

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  if (bytes.length < prefix.length) return false;
  return prefix.every((value, index) => bytes[index] === value);
}

let crcTable: Uint32Array | undefined;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PLACEHOLDER_PNG_BYTES = makeRedactedPlaceholderPng(320, 180);

function makeRedactedPlaceholderPng(width: number, height: number): Uint8Array {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  const barTop = Math.floor(height * 0.36);
  const barHeight = Math.max(12, Math.floor(height * 0.08));
  const barLeft = Math.floor(width * 0.2);
  const barRight = Math.floor(width * 0.8);

  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (width * 4 + 1);
    raw[rowStart] = 0;
    for (let x = 0; x < width; x += 1) {
      const stripe = Math.floor((x + y) / 18) % 2 === 0;
      let r = stripe ? 232 : 244;
      let g = stripe ? 235 : 247;
      let b = stripe ? 240 : 250;
      const inPrimaryBar = x >= barLeft && x <= barRight && y >= barTop && y < barTop + barHeight;
      const inSecondaryBar =
        x >= Math.floor(width * 0.28) &&
        x <= Math.floor(width * 0.72) &&
        y >= barTop + barHeight + 16 &&
        y < barTop + barHeight * 2 + 16;
      const inAccent =
        x >= Math.floor(width * 0.08) &&
        x <= Math.floor(width * 0.92) &&
        y >= Math.floor(height * 0.18) &&
        y < Math.floor(height * 0.22);
      if (inPrimaryBar || inSecondaryBar) {
        r = 27;
        g = 31;
        b = 40;
      } else if (inAccent) {
        r = 170;
        g = 44;
        b = 57;
      }
      const offset = rowStart + 1 + x * 4;
      raw[offset] = r;
      raw[offset + 1] = g;
      raw[offset + 2] = b;
      raw[offset + 3] = 255;
    }
  }

  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", Buffer.concat([u32(width), u32(height), Buffer.from([8, 6, 0, 0, 0])])),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const body = Buffer.concat([typeBytes, Buffer.from(data)]);
  return Buffer.concat([u32(data.byteLength), body, u32(crc32(body))]);
}

function u32(value: number): Buffer {
  const out = Buffer.alloc(4);
  out.writeUInt32BE(value >>> 0, 0);
  return out;
}

function crc32(bytes: Uint8Array): number {
  const table = crcTable ?? buildCrcTable();
  crcTable = table;
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function buildCrcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
}
