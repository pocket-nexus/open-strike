// zlib (RFC 1950) around DEFLATE (RFC 1951), in plain TypeScript: what PNG's image data is. The game's runtime has no
// zlib. LZ77 over a 32 KiB window with hash chains, then one block of the fixed Huffman codes: no code tables to build
// or write, which keeps it quick in an interpreter; palette textures compress to about what zlib's level 1 makes of
// them.

const LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];

const reverse = (code: number, bits: number): number => {
  let r = 0;
  for (let i = 0; i < bits; i++) { r = (r << 1) | (code & 1); code >>= 1; }
  return r;
};

// The fixed literal/length code (RFC 1951 3.2.6), bit-reversed for an LSB-first writer: code and length per symbol.
const LIT_CODE = new Uint16Array(288), LIT_BITS = new Uint8Array(288);
for (let s = 0; s < 288; s++) {
  const [code, bits] = s < 144 ? [0x30 + s, 8] : s < 256 ? [0x190 + s - 144, 9] : s < 280 ? [s - 256, 7] : [0xc0 + s - 280, 8];
  LIT_CODE[s] = reverse(code, bits);
  LIT_BITS[s] = bits;
}
const DIST_CODE = new Uint8Array(30);
for (let d = 0; d < 30; d++) DIST_CODE[d] = reverse(d, 5);
// Length 3..258 -> its symbol's index (0..28); distance 1..32768 -> its code (0..29).
const LENGTH_INDEX = new Uint8Array(259);
for (let i = 0; i < 29; i++) for (let l = LENGTH_BASE[i]!; l < (LENGTH_BASE[i + 1] ?? 259); l++) LENGTH_INDEX[l] = i;
LENGTH_INDEX[258] = 28;
const DIST_INDEX = new Uint8Array(32769);
for (let i = 0; i < 30; i++) for (let d = DIST_BASE[i]!; d < (DIST_BASE[i + 1] ?? 32769); d++) DIST_INDEX[d] = i;

const WINDOW = 32768, HASH_BITS = 15, MAX_CHAIN = 24, GOOD = 32, MAX_MATCH = 258;

/** The bytes compressed in the zlib format (`inflateSync` of Node reads them back). */
export function zlibDeflate(data: Uint8Array): Uint8Array {
  const g = zlibDeflateSteps(data);
  for (;;) {
    const r = g.next();
    if (r.done) return r.value;
  }
}

/** `zlibDeflate` a slice at a time: yields the fraction of the input done every 8 KiB or so. */
export function* zlibDeflateSteps(data: Uint8Array): Generator<number, Uint8Array> {
  const n = data.length;
  let out = new Uint8Array(Math.max(64, (n >> 1) + 64));
  let pos = 0, bitBuf = 0, bitCount = 0;
  const put = (bits: number, count: number) => {
    bitBuf |= bits << bitCount;
    bitCount += count;
    while (bitCount >= 8) {
      if (pos >= out.length) { const grown = new Uint8Array(out.length * 2); grown.set(out); out = grown; }
      out[pos++] = bitBuf & 255;
      bitBuf >>>= 8;
      bitCount -= 8;
    }
  };
  out[pos++] = 0x78; out[pos++] = 0x01;           // deflate, 32 KiB window, "fastest" (no dictionary)
  put(1, 1); put(1, 2);                           // the final block, fixed codes

  const head = new Int32Array(1 << HASH_BITS).fill(-1);
  const prev = new Int32Array(WINDOW);
  const hashAt = (i: number) => (((data[i]! << 10) ^ (data[i + 1]! << 5) ^ data[i + 2]!) & ((1 << HASH_BITS) - 1));
  const insert = (i: number) => {
    const h = hashAt(i);
    prev[i & (WINDOW - 1)] = head[h]!;
    head[h] = i;
  };
  let i = 0, mark = 8192;
  while (i < n) {
    if (i >= mark) { mark = i + 8192; yield i / n; }
    let bestLen = 0, bestDist = 0;
    if (i + 2 < n) {
      const h = hashAt(i);
      let cand = head[h]!;
      prev[i & (WINDOW - 1)] = cand;
      head[h] = i;
      const limit = Math.min(MAX_MATCH, n - i);
      for (let chain = 0; cand >= 0 && i - cand <= WINDOW && chain < MAX_CHAIN; chain++) {
        if (data[cand + bestLen] === data[i + bestLen]) {
          let l = 0;
          while (l < limit && data[cand + l] === data[i + l]) l++;
          if (l > bestLen) {
            bestLen = l;
            bestDist = i - cand;
            if (l >= limit || l >= GOOD) break;
          }
        }
        const next = prev[cand & (WINDOW - 1)]!;
        if (next >= cand) break;
        cand = next;
      }
    }
    if (bestLen >= 3) {
      const li = LENGTH_INDEX[bestLen]!, sym = 257 + li;
      put(LIT_CODE[sym]!, LIT_BITS[sym]!);
      if (LENGTH_EXTRA[li]) put(bestLen - LENGTH_BASE[li]!, LENGTH_EXTRA[li]!);
      const di = DIST_INDEX[bestDist]!;
      put(DIST_CODE[di]!, 5);
      if (DIST_EXTRA[di]) put(bestDist - DIST_BASE[di]!, DIST_EXTRA[di]!);
      // The positions inside the match go into the chains too (short matches only: long ones are runs).
      const end = i + bestLen;
      if (bestLen <= 32) for (let k = i + 1; k < end && k + 2 < n; k++) insert(k);
      i = end;
    } else {
      put(LIT_CODE[data[i]!]!, LIT_BITS[data[i]!]!);
      i++;
    }
  }
  put(LIT_CODE[256]!, LIT_BITS[256]!);
  if (bitCount > 0) put(0, 8 - bitCount);
  // Adler-32 of the data, big-endian.
  let a = 1, b = 0;
  for (let k = 0; k < n; ) {
    const end = Math.min(n, k + 3800);
    for (; k < end; k++) { a += data[k]!; b += a; }
    a %= 65521; b %= 65521;
  }
  const result = new Uint8Array(pos + 4);
  result.set(out.subarray(0, pos));
  result[pos] = (b >>> 8) & 255; result[pos + 1] = b & 255; result[pos + 2] = (a >>> 8) & 255; result[pos + 3] = a & 255;
  return result;
}
