// A minimal PNG writer: 8-bit, no interlace. GoldSrc textures are palettised, so they are written as palette PNGs:
// the pixels stay exactly what they were and the files stay small. Plain TypeScript (deflate.ts), so the game can
// write them; the reader that checks them is the tools' (tools/bsp/png.ts).
import { zlibDeflateSteps } from "./deflate.ts";

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c >>> 0;
}

export function crc32(bytes: Uint8Array, crc = 0xffffffff): number {
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return crc >>> 0;
}

export const SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, (crc32(out.subarray(4, 8 + data.length)) ^ 0xffffffff) >>> 0);
  return out;
}

function* assemble(width: number, height: number, colorType: number, extra: Uint8Array[], rows: Uint8Array): Generator<number, Uint8Array> {
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = 8;
  header[9] = colorType;
  const parts = [SIGNATURE, chunk("IHDR", header), ...extra, chunk("IDAT", yield* zlibDeflateSteps(rows)), chunk("IEND", new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Scanlines with filter type 0 (none) in front of each. */
function unfiltered(pixels: Uint8Array, stride: number, height: number): Uint8Array {
  const rows = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) rows.set(pixels.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  return rows;
}

/**
 * A palette PNG. `palette` is 256 x RGB. `transparent`: that palette index is fully transparent (a tRNS chunk), every
 * other one opaque.
 */
export function encodeIndexedPng(width: number, height: number, pixels: Uint8Array, palette: Uint8Array, transparent?: number): Uint8Array {
  return run(encodeIndexedPngSteps(width, height, pixels, palette, transparent));
}

/** `encodeIndexedPng` a slice at a time (yields the fraction done). */
export function* encodeIndexedPngSteps(width: number, height: number, pixels: Uint8Array, palette: Uint8Array, transparent?: number): Generator<number, Uint8Array> {
  if (pixels.length !== width * height) throw new Error(`png: ${pixels.length} pixels for ${width} x ${height}`);
  const extra = [chunk("PLTE", palette.subarray(0, 768))];
  if (transparent !== undefined) {
    const alpha = new Uint8Array(transparent + 1).fill(255);
    alpha[transparent] = 0;
    extra.push(chunk("tRNS", alpha));
  }
  return yield* assemble(width, height, 3, extra, unfiltered(pixels, width, height));
}

/** An RGBA PNG. */
export function encodeRgbaPng(width: number, height: number, rgba: Uint8Array): Uint8Array {
  if (rgba.length !== width * height * 4) throw new Error(`png: ${rgba.length} bytes for ${width} x ${height} RGBA`);
  return run(assemble(width, height, 6, [], unfiltered(rgba, width * 4, height)));
}

function run<R>(g: Generator<unknown, R>): R {
  for (;;) {
    const r = g.next();
    if (r.done) return r.value;
  }
}
