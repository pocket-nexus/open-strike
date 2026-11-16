// Bytes and text without the platform's helpers: the game's runtime (QuickJS in the engine) has no TextDecoder, no
// btoa and no Buffer. Base64 is how files travel on the host channel (docs/MAPS.md "Importing in the game"): an
// engine that has native base64 (`__host_base64_decode` / `__host_base64_encode`, the "Files" change) does it, a few
// megabytes a slice; without it, it is done here, 64 K characters a slice. Either way a frame never waits for a whole
// WAD.

/** Latin-1 text of `bytes[from..to)`: one character per byte (GoldSrc names and entity text). */
export function latin1(bytes: Uint8Array, from = 0, to = bytes.length): string {
  let out = "";
  for (let i = from; i < to; i += 4096) out += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(to, i + 4096)) as unknown as number[]);
  return out;
}

/** UTF-8 bytes of a string. */
export function utf8(s: string): Uint8Array {
  const out = new Uint8Array(s.length * 3);
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c >= 0xd800 && c < 0xdc00 && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d < 0xe000) { c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00); i++; }
    }
    if (c < 0x80) out[n++] = c;
    else if (c < 0x800) { out[n++] = 0xc0 | (c >> 6); out[n++] = 0x80 | (c & 63); }
    else if (c < 0x10000) { out[n++] = 0xe0 | (c >> 12); out[n++] = 0x80 | ((c >> 6) & 63); out[n++] = 0x80 | (c & 63); }
    else { out[n++] = 0xf0 | (c >> 18); out[n++] = 0x80 | ((c >> 12) & 63); out[n++] = 0x80 | ((c >> 6) & 63); out[n++] = 0x80 | (c & 63); }
  }
  return out.slice(0, n);
}

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const VALUE = new Int16Array(128).fill(-1);
for (let i = 0; i < 64; i++) VALUE[ALPHABET.charCodeAt(i)] = i;
VALUE[45] = 62; VALUE[95] = 63;           // (and the URL-safe alphabet's "-" and "_")
const ALPHABET_CODES = Uint8Array.from(ALPHABET, (c) => c.charCodeAt(0));

/** Characters of base64 handled between two yields, in script and natively. */
const SLICE = 1 << 16;
const NATIVE_SLICE = 1 << 20;
const natives = globalThis as { __host_base64_encode?: (bytes: Uint8Array) => string; __host_base64_decode?: (text: string) => Uint8Array };

/**
 * Decodes base64 (padding and whitespace allowed), a slice at a time: yields the fraction done between slices and
 * returns the bytes. Throws on a character that is not base64.
 */
export function* fromBase64(text: string): Generator<number, Uint8Array> {
  const decode = natives.__host_base64_decode;
  if (decode && /^[A-Za-z0-9+/]*={0,2}$/.test(text.slice(-8))) {
    // (Slices of a multiple of 4 characters decode on their own; only the last has the padding.)
    const parts: Uint8Array[] = [];
    let total = 0;
    for (let at = 0; at < text.length; at += NATIVE_SLICE) {
      const part = decode(text.slice(at, at + NATIVE_SLICE));
      parts.push(part);
      total += part.length;
      if (at + NATIVE_SLICE < text.length) yield (at + NATIVE_SLICE) / text.length;
    }
    if (parts.length === 1) return parts[0]!;
    const out = new Uint8Array(total);
    let n = 0;
    for (const p of parts) { out.set(p, n); n += p.length; }
    return out;
  }
  const out = new Uint8Array(Math.floor((text.length * 3) / 4) + 3);
  let n = 0, buf = 0, bits = 0;
  const len = text.length;
  for (let at = 0; at < len; at += SLICE) {
    const end = Math.min(len, at + SLICE);
    let i = at;
    // Four characters to three bytes while they are plain base64 (all of it but the padding, as the app sends it).
    if (bits === 0) {
      for (; i + 3 < end; i += 4) {
        const a = text.charCodeAt(i), b = text.charCodeAt(i + 1), c = text.charCodeAt(i + 2), d = text.charCodeAt(i + 3);
        const v = ((a | b | c | d) & 0xff80) === 0 ? (VALUE[a]! << 18) | (VALUE[b]! << 12) | (VALUE[c]! << 6) | VALUE[d]! : -1;
        if (v < 0) break;
        out[n] = v >> 16; out[n + 1] = (v >> 8) & 255; out[n + 2] = v & 255;
        n += 3;
      }
    }
    for (; i < end; i++) {
      const c = text.charCodeAt(i);
      const v = c < 128 ? VALUE[c]! : -1;
      if (v < 0) {
        if (c === 61 || c === 32 || c === 10 || c === 13 || c === 9) continue;     // = and whitespace
        throw new Error(`base64: unexpected character ${JSON.stringify(text[i])} at ${i}`);
      }
      buf = ((buf << 6) | v) & 0xffffff;
      bits += 6;
      if (bits >= 8) { bits -= 8; out[n++] = (buf >> bits) & 255; }
    }
    if (end < len) yield end / len;
  }
  return out.slice(0, n);
}

/** Bytes as base64 (with padding), a slice at a time: yields the fraction done, returns the text. */
export function* toBase64(bytes: Uint8Array): Generator<number, string> {
  const parts: string[] = [];
  const encode = natives.__host_base64_encode;
  if (encode) {
    const step = (NATIVE_SLICE / 4) * 3;
    for (let at = 0; at < bytes.length; at += step) {
      parts.push(encode(bytes.subarray(at, Math.min(bytes.length, at + step))));
      if (at + step < bytes.length) yield (at + step) / bytes.length;
    }
    return parts.join("");
  }
  const step = (SLICE / 4) * 3;            // (a multiple of 3: only the last slice pads)
  const codes = new Uint8Array((step / 3) * 4);
  const A = ALPHABET_CODES;
  for (let at = 0; at < bytes.length; at += step) {
    const end = Math.min(bytes.length, at + step);
    let n = 0;
    let i = at;
    for (; i + 2 < end; i += 3) {
      const v = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
      codes[n] = A[v >> 18]!; codes[n + 1] = A[(v >> 12) & 63]!; codes[n + 2] = A[(v >> 6) & 63]!; codes[n + 3] = A[v & 63]!;
      n += 4;
    }
    if (i < end) {
      const a = bytes[i]!, b = i + 1 < end ? bytes[i + 1]! : 0;
      codes[n++] = A[a >> 2]!;
      codes[n++] = A[((a & 3) << 4) | (b >> 4)]!;
      codes[n++] = i + 1 < end ? A[(b & 15) << 2]! : 61;
      codes[n++] = 61;
    }
    parts.push(latin1(codes, 0, n));
    if (end < bytes.length) yield end / bytes.length;
  }
  return parts.join("");
}

/** Runs a generator to its end and returns what it returns (the same work, all at once: tools, tests). */
export function drain<R>(g: Generator<unknown, R>): R {
  for (;;) {
    const r = g.next();
    if (r.done) return r.value;
  }
}
