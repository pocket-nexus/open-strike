// Reading PNGs back (the importer's own check, and its tests): Node's zlib. The writer is src/import/png.ts.
import { inflateSync } from "node:zlib";
import { SIGNATURE, crc32 } from "../../src/import/png.ts";

export { crc32, encodeIndexedPng, encodeRgbaPng } from "../../src/import/png.ts";

export interface DecodedPng {
  width: number;
  height: number;
  rgba: Uint8Array;
}

/** Reads a PNG this module could have written (8-bit grey, RGB, palette, grey + alpha, RGBA; no interlace); throws otherwise. */
export function decodePng(bytes: Uint8Array): DecodedPng {
  for (let i = 0; i < 8; i++) if (bytes[i] !== SIGNATURE[i]) throw new Error("png: bad signature");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width = 0, height = 0, colorType = -1;
  let palette: Uint8Array | null = null, alpha: Uint8Array | null = null;
  const data: Uint8Array[] = [];
  let ended = false;
  for (let at = 8; at + 12 <= bytes.length && !ended; ) {
    const length = view.getUint32(at);
    if (at + 12 + length > bytes.length) throw new Error("png: truncated chunk");
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    const body = bytes.subarray(at + 8, at + 8 + length);
    if (((crc32(bytes.subarray(at + 4, at + 8 + length)) ^ 0xffffffff) >>> 0) !== view.getUint32(at + 8 + length)) throw new Error(`png: bad CRC in ${type}`);
    if (type === "IHDR") {
      width = view.getUint32(at + 8);
      height = view.getUint32(at + 12);
      colorType = body[9];
      if (body[8] !== 8 || body[12] !== 0) throw new Error("png: only 8-bit, non-interlaced images");
    } else if (type === "PLTE") palette = body;
    else if (type === "tRNS") alpha = body;
    else if (type === "IDAT") data.push(body);
    else if (type === "IEND") ended = true;
    at += 12 + length;
  }
  if (!ended) throw new Error("png: no IEND");
  const channels = [1, 0, 3, 1, 2, 0, 4][colorType];
  if (!channels || !width || !height) throw new Error(`png: unsupported colour type ${colorType}`);
  if (colorType === 3 && !palette) throw new Error("png: palette image without a palette");
  const packed = new Uint8Array(data.reduce((n, d) => n + d.length, 0));
  let o = 0;
  for (const d of data) {
    packed.set(d, o);
    o += d.length;
  }
  const raw = inflateSync(packed);
  const stride = width * channels;
  if (raw.length !== (stride + 1) * height) throw new Error(`png: ${raw.length} bytes of image data, expected ${(stride + 1) * height}`);
  const px = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const row = y * stride, src = y * (stride + 1) + 1;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? px[row + x - channels] : 0;
      const b = y > 0 ? px[row - stride + x] : 0;
      const c = x >= channels && y > 0 ? px[row - stride + x - channels] : 0;
      let predicted = 0;
      if (filter === 1) predicted = a;
      else if (filter === 2) predicted = b;
      else if (filter === 3) predicted = (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        predicted = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (filter !== 0) throw new Error(`png: filter ${filter}`);
      px[row + x] = (raw[src + x] + predicted) & 0xff;
    }
  }
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    let r: number, g: number, b: number, a = 255;
    if (colorType === 3) {
      const k = px[i];
      if (k * 3 + 2 >= palette!.length) throw new Error(`png: pixel names palette entry ${k}`);
      r = palette![k * 3];
      g = palette![k * 3 + 1];
      b = palette![k * 3 + 2];
      if (alpha && k < alpha.length) a = alpha[k];
    } else if (colorType === 0 || colorType === 4) {
      r = g = b = px[i * channels];
      if (colorType === 4) a = px[i * 2 + 1];
    } else {
      r = px[i * channels];
      g = px[i * channels + 1];
      b = px[i * channels + 2];
      if (colorType === 6) a = px[i * 4 + 3];
    }
    rgba.set([r, g, b, a], i * 4);
  }
  return { width, height, rgba };
}
