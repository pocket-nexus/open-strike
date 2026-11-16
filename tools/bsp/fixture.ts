// Hand-built GoldSrc files for the tests: a BSP version 30 and a WAD3 written from a description, byte by byte. The
// tests make their own maps, so no copyrighted map or texture is ever in the repository.

export type P3 = [number, number, number];

export interface FixtureTexture {
  name: string;
  width: number;
  height: number;
  /** Palette indices, rows top to bottom. In a map: given = embedded, left out = the map only names it (it is in a WAD). */
  pixels?: Uint8Array;
  /** 256 x RGB; a grey ramp when left out. */
  palette?: Uint8Array;
}

export interface FixtureFace {
  texture: string;
  /** Corners in GoldSrc units, clockwise seen from the front (GoldSrc's winding). */
  vertices: P3[];
  /** Brush model the face belongs to (0: the world). */
  model?: number;
  s?: [number, number, number, number];
  t?: [number, number, number, number];
}

export interface FixtureMap {
  entities: Record<string, string>[];
  textures: FixtureTexture[];
  faces: FixtureFace[];
  version?: number;
}

class Bytes {
  private parts: number[] = [];
  get length(): number {
    return this.parts.length;
  }
  u8(...v: number[]): this {
    for (const b of v) this.parts.push(b & 0xff);
    return this;
  }
  u16(v: number): this {
    return this.u8(v, v >> 8);
  }
  i32(v: number): this {
    return this.u8(v, v >> 8, v >> 16, v >> 24);
  }
  f32(v: number): this {
    const b = new Uint8Array(new Float32Array([v]).buffer);
    return this.u8(...b);
  }
  bytes(b: ArrayLike<number>): this {
    for (let i = 0; i < b.length; i++) this.parts.push(b[i]);
    return this;
  }
  name(s: string, length: number): this {
    for (let i = 0; i < length; i++) this.parts.push(i < s.length ? s.charCodeAt(i) : 0);
    return this;
  }
  done(): Uint8Array {
    return Uint8Array.from(this.parts);
  }
}

/** A miptex record: the header, four mip levels, the palette. Without `pixels`: the header alone (the texture is elsewhere). */
export function buildMiptex(t: FixtureTexture): Uint8Array {
  const out = new Bytes().name(t.name, 16).i32(t.width).i32(t.height);
  if (!t.pixels) return out.i32(0).i32(0).i32(0).i32(0).done();
  let at = 40;
  const mips: Uint8Array[] = [];
  for (let level = 0; level < 4; level++) {
    const w = t.width >> level, h = t.height >> level;
    const mip = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) mip[y * w + x] = t.pixels[(y << level) * t.width + (x << level)];
    mips.push(mip);
    out.i32(at);
    at += mip.length;
  }
  for (const m of mips) out.bytes(m);
  out.u16(256);
  if (t.palette) out.bytes(t.palette.subarray(0, 768));
  else for (let i = 0; i < 256; i++) out.u8(i, i, i);
  return out.u16(0).done();
}

export function buildWad(textures: FixtureTexture[]): Uint8Array {
  const records = textures.map(buildMiptex);
  const out = new Bytes().name("WAD3", 4).i32(textures.length);
  const directory = 12 + records.reduce((n, r) => n + r.length, 0);
  out.i32(directory);
  const offsets: number[] = [];
  for (const r of records) {
    offsets.push(out.length);
    out.bytes(r);
  }
  textures.forEach((t, i) => out.i32(offsets[i]).i32(records[i].length).i32(records[i].length).u8(0x43, 0, 0, 0).name(t.name, 16));
  return out.done();
}

export function entityText(entities: Record<string, string>[]): string {
  return entities.map((e) => `{\n${Object.entries(e).map(([k, v]) => `"${k}" "${v}"`).join("\n")}\n}\n`).join("");
}

/**
 * A map. Hull 0 is one node on the plane z = 0: empty above, solid below; the clip hulls are the same. Each face gets
 * its own plane, vertices and edges, and texture axes along the world axes it lies in (as an editor would give it).
 */
export function buildBsp(map: FixtureMap): Uint8Array {
  const planes = new Bytes().f32(0).f32(0).f32(1).f32(0).i32(2);
  const vertices = new Bytes();
  const edges = new Bytes().u16(0).u16(0);
  const surfedges = new Bytes();
  const texinfo = new Bytes();
  const faces = new Bytes();
  const models = new Bytes();
  let planeCount = 1, vertexCount = 0, edgeCount = 1, surfedgeCount = 0, texinfoCount = 0, faceCount = 0;

  const modelCount = Math.max(0, ...map.faces.map((f) => f.model ?? 0)) + 1;
  for (let m = 0; m < modelCount; m++) {
    const own = map.faces.filter((f) => (f.model ?? 0) === m);
    const mins: P3 = [Infinity, Infinity, Infinity], maxs: P3 = [-Infinity, -Infinity, -Infinity];
    const firstFace = faceCount;
    for (const f of own) {
      // The front normal of a clockwise polygon.
      let nx = 0, ny = 0, nz = 0;
      for (let k = 0; k < f.vertices.length; k++) {
        const a = f.vertices[k], b = f.vertices[(k + 1) % f.vertices.length];
        nx -= (a[1] - b[1]) * (a[2] + b[2]);
        ny -= (a[2] - b[2]) * (a[0] + b[0]);
        nz -= (a[0] - b[0]) * (a[1] + b[1]);
      }
      const length = Math.hypot(nx, ny, nz);
      const n: P3 = [nx / length, ny / length, nz / length];
      planes.f32(n[0]).f32(n[1]).f32(n[2]).f32(n[0] * f.vertices[0][0] + n[1] * f.vertices[0][1] + n[2] * f.vertices[0][2]).i32(0);
      const ax = Math.abs(n[0]), ay = Math.abs(n[1]), az = Math.abs(n[2]);
      const s = f.s ?? (az >= ax && az >= ay ? [1, 0, 0, 0] : ax >= ay ? [0, 1, 0, 0] : [1, 0, 0, 0]);
      const t = f.t ?? (az >= ax && az >= ay ? [0, -1, 0, 0] : [0, 0, -1, 0]);
      const miptex = map.textures.findIndex((x) => x.name === f.texture);
      if (miptex < 0) throw new Error(`fixture: no texture ${f.texture}`);
      texinfo.f32(s[0]).f32(s[1]).f32(s[2]).f32(s[3]).f32(t[0]).f32(t[1]).f32(t[2]).f32(t[3]).i32(miptex).i32(0);
      const firstEdge = surfedgeCount;
      for (let k = 0; k < f.vertices.length; k++) {
        const v = f.vertices[k];
        vertices.f32(v[0]).f32(v[1]).f32(v[2]);
        for (let c = 0; c < 3; c++) {
          mins[c] = Math.min(mins[c], v[c]);
          maxs[c] = Math.max(maxs[c], v[c]);
        }
        edges.u16(vertexCount + k).u16(vertexCount + ((k + 1) % f.vertices.length));
        surfedges.i32(edgeCount + k);
      }
      vertexCount += f.vertices.length;
      edgeCount += f.vertices.length;
      surfedgeCount += f.vertices.length;
      faces.u16(planeCount++).u16(0).i32(firstEdge).u16(f.vertices.length).u16(texinfoCount++).u8(0, 255, 255, 255).i32(-1);
      faceCount++;
    }
    for (const v of [...mins, ...maxs, 0, 0, 0]) models.f32(Number.isFinite(v) ? v : 0);
    models.i32(0).i32(0).i32(0).i32(0).i32(0).i32(firstFace).i32(own.length);
  }

  const records = map.textures.map(buildMiptex);
  const textures = new Bytes().i32(records.length);
  let at = 4 + records.length * 4;
  for (const r of records) {
    textures.i32(at);
    at += r.length;
  }
  for (const r of records) textures.bytes(r);

  // One node on plane 0: in front (above z = 0) leaf 1, empty; behind it leaf 0, solid.
  const nodes = new Bytes().i32(0).u16(~1).u16(~0).bytes(new Uint8Array(16));
  const clipnodes = new Bytes().i32(0).u16(-1).u16(-2);
  const leaves = new Bytes().i32(-2).bytes(new Uint8Array(24)).i32(-1).bytes(new Uint8Array(24));

  const text = new Bytes().bytes(new TextEncoder().encode(entityText(map.entities))).u8(0);
  const lumps = [text, planes, textures, vertices, new Bytes(), nodes, texinfo, faces, new Bytes(), clipnodes, leaves, new Bytes(), edges, surfedges, models].map((l) => l.done());
  const out = new Bytes().i32(map.version ?? 30);
  let offset = 4 + 15 * 8;
  for (const l of lumps) {
    out.i32(offset).i32(l.length);
    offset += l.length + ((4 - (l.length % 4)) % 4);
  }
  for (const l of lumps) out.bytes(l).bytes(new Uint8Array((4 - (l.length % 4)) % 4));
  return out.done();
}

/** A horizontal rectangle at height z, facing up (a floor) or down (a ceiling), clockwise seen from its front. */
export function rectZ(x0: number, y0: number, x1: number, y1: number, z: number, up = true): P3[] {
  const ccwFromAbove: P3[] = [[x0, y0, z], [x1, y0, z], [x1, y1, z], [x0, y1, z]];
  return up ? ccwFromAbove.reverse() : ccwFromAbove;
}

/** A vertical rectangle from `a` to `b` on the ground plan, between z0 and z1, facing the left of a -> b. */
export function wall(a: [number, number], b: [number, number], z0: number, z1: number): P3[] {
  // Seen from the left of a -> b, a is on the right and b on the left: along the bottom to b, up, back along the top.
  return [[a[0], a[1], z0], [b[0], b[1], z0], [b[0], b[1], z1], [a[0], a[1], z1]];
}
