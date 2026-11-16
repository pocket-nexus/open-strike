// A map's hash (docs/MAPS.md): SHA-256, in hex, of its collision data: the positions as little-endian float32,
// then the indices as little-endian uint32. A room names its map by id and hash, so everyone in it stands on the
// same floor. Plain TypeScript (the game's runtime has no crypto); the importer may use this function or any
// SHA-256 over the same bytes.

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** SHA-256 a piece at a time (`update` as often as needed, then `hex`): a long input need not be hashed in one go. */
export class Sha256 {
  private readonly h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  private readonly w = new Uint32Array(64);
  private readonly block = new Uint8Array(64);
  private filled = 0;
  private length = 0;

  update(bytes: Uint8Array): this {
    let i = 0;
    this.length += bytes.length;
    if (this.filled) {
      const take = Math.min(64 - this.filled, bytes.length);
      this.block.set(bytes.subarray(0, take), this.filled);
      this.filled += take;
      i = take;
      if (this.filled < 64) return this;
      this.compress(this.block, 0);
      this.filled = 0;
    }
    for (; i + 64 <= bytes.length; i += 64) this.compress(bytes, i);
    if (i < bytes.length) {
      this.block.set(bytes.subarray(i));
      this.filled = bytes.length - i;
    }
    return this;
  }

  /** The digest, lower-case hex. (The hash is done with: no more `update`.) */
  hex(): string {
    const bits = this.length * 8;
    const tail = new Uint8Array(this.filled < 56 ? 64 - this.filled : 128 - this.filled);
    tail[0] = 0x80;
    const k = tail.length;
    tail[k - 4] = (bits >>> 24) & 255; tail[k - 3] = (bits >>> 16) & 255; tail[k - 2] = (bits >>> 8) & 255; tail[k - 1] = bits & 255;
    tail[k - 5] = Math.floor(bits / 2 ** 32) & 255;
    this.update(tail);
    let out = "";
    for (let i = 0; i < 8; i++) out += (this.h[i]! >>> 0).toString(16).padStart(8, "0");
    return out;
  }

  private compress(data: Uint8Array, o: number): void {
    const w = this.w, h = this.h;
    for (let i = 0; i < 16; i++) w[i] = (data[o + i * 4]! << 24) | (data[o + i * 4 + 1]! << 16) | (data[o + i * 4 + 2]! << 8) | data[o + i * 4 + 3]!;
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15]!, b = w[i - 2]!;
      w[i] = (w[i - 16]! + (((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3)) + w[i - 7]! + (((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10))) | 0;
    }
    let a = h[0]!, b = h[1]!, c = h[2]!, d = h[3]!, e = h[4]!, f = h[5]!, g = h[6]!, hh = h[7]!;
    for (let i = 0; i < 64; i++) {
      const t1 = (hh + (((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7))) + ((e & f) ^ (~e & g)) + K[i]! + w[i]!) | 0;
      const t2 = ((((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10))) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h[0] = (h[0]! + a) | 0; h[1] = (h[1]! + b) | 0; h[2] = (h[2]! + c) | 0; h[3] = (h[3]! + d) | 0; h[4] = (h[4]! + e) | 0; h[5] = (h[5]! + f) | 0; h[6] = (h[6]! + g) | 0; h[7] = (h[7]! + hh) | 0;
  }
}

export function sha256(bytes: Uint8Array): string {
  return new Sha256().update(bytes).hex();
}

/** The bytes a map's hash is taken of: the positions as little-endian float32, then the indices as little-endian uint32. */
export function collisionBytes(positions: ArrayLike<number>, indices: ArrayLike<number>): Uint8Array {
  const bytes = new Uint8Array(positions.length * 4 + indices.length * 4);
  const view = new DataView(bytes.buffer);
  for (let k = 0; k < positions.length; k++) view.setFloat32(k * 4, positions[k]!, true);
  const base = positions.length * 4;
  for (let k = 0; k < indices.length; k++) view.setUint32(base + k * 4, indices[k]!, true);
  return bytes;
}

/** The hash of a map's collision data. */
export function collisionHash(positions: ArrayLike<number>, indices: ArrayLike<number>): string {
  return sha256(collisionBytes(positions, indices));
}
