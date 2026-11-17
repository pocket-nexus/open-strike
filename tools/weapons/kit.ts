// A small procedural modelling kit for OpenStrikeRT's weapon models (build.ts; from the earlier native OpenStrike, first-party).
//
// Everything is authored in millimetres in weapon space (+X right, +Y up, -Z forward; glb.ts scales to metres). A Kit
// collects triangles per glTF node ("part") and material. Every primitive is a closed solid: `mesh` welds it, turns it
// outward (signed volume), and computes vertex normals with a crease angle (flat faces across hard edges, smooth normals
// around cylinders and lofts), so the path tracer gets consistent winding and shading normals.
//
// Primitives:
//   extrude  a 2D outline (optionally with holes) along the third axis, with chamfered or rounded cap edges
//   lathe    a (t, r) profile revolved around an axis (barrels, tubes with a bore, knobs)
//   loft     super-elliptical rings joined into a skin (forearms, palms), flat or domed ends
//   tube     a loft along a path (fingers, sling loops)
//   box/cyl  chamfered box, cylinder between two points
//   rail     a Picatinny rail (dovetail bar and teeth)
// (earcut comes from the engine checkout's node_modules: this project has no dependencies of its own.)
import { pathToFileURL } from "node:url";
import { engineRequire } from "../lib/engine.ts";
const earcut = (await import(pathToFileURL(engineRequire.resolve("earcut")).href)).default as (data: ArrayLike<number>, holes?: ArrayLike<number>, dim?: number) => number[];

export type V2 = [number, number];
export type V3 = [number, number, number];

export const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const mul = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const len = (a: V3): number => Math.hypot(a[0], a[1], a[2]);
export const norm = (a: V3): V3 => {
  const l = len(a);
  return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
};
export const mix = (a: V3, b: V3, t: number): V3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
export const rad = (deg: number): number => (deg * Math.PI) / 180;
/** Any unit vector perpendicular to `d`. */
export const perp = (d: V3): V3 => norm(cross(d, Math.abs(d[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]));

/** Affine transform: columns x, y, z and translation t. */
export interface Xf {
  x: V3;
  y: V3;
  z: V3;
  t: V3;
}
export const IDENT: Xf = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1], t: [0, 0, 0] };
export const xfDir = (m: Xf, v: V3): V3 => [m.x[0] * v[0] + m.y[0] * v[1] + m.z[0] * v[2], m.x[1] * v[0] + m.y[1] * v[1] + m.z[1] * v[2], m.x[2] * v[0] + m.y[2] * v[1] + m.z[2] * v[2]];
export const xfPt = (m: Xf, p: V3): V3 => add(xfDir(m, p), m.t);
export const xfMul = (a: Xf, b: Xf): Xf => ({ x: xfDir(a, b.x), y: xfDir(a, b.y), z: xfDir(a, b.z), t: xfPt(a, b.t) });
export const compose = (...m: Xf[]): Xf => m.reduce(xfMul);
export const translate = (x: number, y: number, z: number): Xf => ({ ...IDENT, t: [x, y, z] });
export const scaling = (x: number, y: number, z: number): Xf => ({ x: [x, 0, 0], y: [0, y, 0], z: [0, 0, z], t: [0, 0, 0] });
export function rotAxis(axis: V3, deg: number): Xf {
  const [x, y, z] = norm(axis);
  const c = Math.cos(rad(deg)), s = Math.sin(rad(deg)), k = 1 - c;
  return { x: [c + x * x * k, y * x * k + z * s, z * x * k - y * s], y: [x * y * k - z * s, c + y * y * k, z * y * k + x * s], z: [x * z * k + y * s, y * z * k - x * s, c + z * z * k], t: [0, 0, 0] };
}
export const rotX = (deg: number): Xf => rotAxis([1, 0, 0], deg);
export const rotY = (deg: number): Xf => rotAxis([0, 1, 0], deg);
export const rotZ = (deg: number): Xf => rotAxis([0, 0, 1], deg);
/** Rotation about `axis` through `pivot`. */
export const rotAbout = (pivot: V3, axis: V3, deg: number): Xf => compose(translate(...pivot), rotAxis(axis, deg), translate(-pivot[0], -pivot[1], -pivot[2]));
/** Frame with origin `o` and axes x, y, z (need not be orthonormal). */
export const basis = (o: V3, x: V3, y: V3, z: V3): Xf => ({ x, y, z, t: o });
export const rotDir = (v: V3, axis: V3, deg: number): V3 => xfDir(rotAxis(axis, deg), v);

export interface MaterialDef {
  /** Linear base colour. */
  color: [number, number, number];
  metallic: number;
  roughness: number;
}

export interface Buf {
  pos: number[];
  nrm: number[];
  idx: number[];
}

export type Plane = "zy" | "xy" | "xz";
export type Cap = "flat" | "round" | "none";
export interface Ring {
  /** Centre. */
  c: V3;
  /** Semi-axes (vectors). */
  a: V3;
  b: V3;
  /** Superellipse exponent (2 = ellipse, larger = boxier). */
  e?: number;
}

export interface ExtrudeOpts {
  /** The outline's plane: "zy" = side profile [z, y] extruded along x (default); "xy" = section [x, y] along z; "xz" = plan [x, z] along y. */
  plane?: Plane;
  from: number;
  to: number;
  /** Chamfer of the cap edges (both, or [from, to]). */
  bevel?: number | [number, number];
  /** Bevel steps (1 = flat chamfer, 3 = rounded). */
  round?: number;
  holes?: V2[][];
  crease?: number;
}

const area2 = (p: V2[]): number => {
  let a = 0;
  for (let i = 0; i < p.length; i++) {
    const q = p[(i + 1) % p.length];
    a += p[i][0] * q[1] - q[0] * p[i][1];
  }
  return a / 2;
};

function cleanPoly(p: V2[]): V2[] {
  const out: V2[] = [];
  for (const q of p) {
    const l = out[out.length - 1];
    if (!l || Math.hypot(q[0] - l[0], q[1] - l[1]) > 1e-6) out.push([q[0], q[1]]);
  }
  if (out.length > 1 && Math.hypot(out[0][0] - out[out.length - 1][0], out[0][1] - out[out.length - 1][1]) < 1e-6) out.pop();
  return out;
}

/** Inset of a CCW polygon by `d` (mitred, same vertex count). */
export function insetPoly(p: V2[], d: number): V2[] {
  if (d === 0) return p;
  const n = p.length;
  const out: V2[] = [];
  for (let i = 0; i < n; i++) {
    const a = p[(i - 1 + n) % n], b = p[i], c = p[(i + 1) % n];
    let e1: V2 = [b[0] - a[0], b[1] - a[1]], e2: V2 = [c[0] - b[0], c[1] - b[1]];
    const l1 = Math.hypot(e1[0], e1[1]) || 1, l2 = Math.hypot(e2[0], e2[1]) || 1;
    e1 = [e1[0] / l1, e1[1] / l1];
    e2 = [e2[0] / l2, e2[1] / l2];
    const n1: V2 = [-e1[1], e1[0]], n2: V2 = [-e2[1], e2[0]];
    const k = Math.max(1 + n1[0] * n2[0] + n1[1] * n2[1], 0.35);
    out.push([b[0] + ((n1[0] + n2[0]) / k) * d, b[1] + ((n1[1] + n2[1]) / k) * d]);
  }
  return out;
}

/** Rectangle [u0, u1] x [v0, v1] with its corners cut by `c` (a V2[] outline). */
export function rect(u0: number, u1: number, v0: number, v1: number, c = 0): V2[] {
  if (u0 > u1) [u0, u1] = [u1, u0];
  if (v0 > v1) [v0, v1] = [v1, v0];
  c = Math.min(c, (u1 - u0) / 2 - 1e-3, (v1 - v0) / 2 - 1e-3);
  if (c <= 0) return [[u0, v0], [u1, v0], [u1, v1], [u0, v1]];
  return [[u0 + c, v0], [u1 - c, v0], [u1, v0 + c], [u1, v1 - c], [u1 - c, v1], [u0 + c, v1], [u0, v1 - c], [u0, v0 + c]];
}

/** A stadium / rounded-rectangle outline (corner radius r, `n` segments per corner). */
export function roundRect(u0: number, u1: number, v0: number, v1: number, r: number, n = 3): V2[] {
  if (u0 > u1) [u0, u1] = [u1, u0];
  if (v0 > v1) [v0, v1] = [v1, v0];
  r = Math.min(r, (u1 - u0) / 2, (v1 - v0) / 2);
  const out: V2[] = [];
  const corners: [number, number, number][] = [[u1 - r, v0 + r, -90], [u1 - r, v1 - r, 0], [u0 + r, v1 - r, 90], [u0 + r, v0 + r, 180]];
  for (const [cu, cv, a0] of corners) for (let i = 0; i <= n; i++) out.push([cu + r * Math.cos(rad(a0 + (90 * i) / n)), cv + r * Math.sin(rad(a0 + (90 * i) / n))]);
  return cleanPoly(out);
}

/** Circle outline. */
export function circle(cu: number, cv: number, r: number, n = 12, phase = 0): V2[] {
  return Array.from({ length: n }, (_, i) => [cu + r * Math.cos(rad(phase) + (2 * Math.PI * i) / n), cv + r * Math.sin(rad(phase) + (2 * Math.PI * i) / n)] as V2);
}

/** Rounds the interior corners of a 3D polyline (quadratic arcs of `steps` segments, cut length `r`). */
export function roundPath(pts: V3[], r: number | number[], steps = 2): V3[] {
  const out: V3[] = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i], a = pts[i - 1], b = pts[i + 1];
    const ri = Array.isArray(r) ? r[i] : r;
    const d = Math.min(ri, 0.45 * len(sub(a, p)), 0.45 * len(sub(b, p)));
    if (d <= 1e-6) {
      out.push(p);
      continue;
    }
    const p1 = add(p, mul(norm(sub(a, p)), d)), p2 = add(p, mul(norm(sub(b, p)), d));
    for (let k = 0; k <= steps; k++) {
      const t = k / steps;
      out.push(add(add(mul(p1, (1 - t) * (1 - t)), mul(p, 2 * t * (1 - t))), mul(p2, t * t)));
    }
  }
  out.push(pts[pts.length - 1]);
  return out;
}

/** Rounds the corners of a 2D outline listed in `which` (all when omitted): arcs of `steps` segments, cut length r. */
export function roundCorners(p: V2[], r: number | number[], steps = 2, which?: number[]): V2[] {
  const n = p.length;
  const out: V2[] = [];
  for (let i = 0; i < n; i++) {
    const ri = Array.isArray(r) ? r[i] ?? 0 : r;
    if (ri <= 0 || (which && !which.includes(i))) {
      out.push(p[i]);
      continue;
    }
    const a = p[(i - 1 + n) % n], b = p[i], c = p[(i + 1) % n];
    const la = Math.hypot(a[0] - b[0], a[1] - b[1]), lc = Math.hypot(c[0] - b[0], c[1] - b[1]);
    const d = Math.min(ri, 0.45 * la, 0.45 * lc);
    const p1: V2 = [b[0] + ((a[0] - b[0]) / la) * d, b[1] + ((a[1] - b[1]) / la) * d];
    const p2: V2 = [b[0] + ((c[0] - b[0]) / lc) * d, b[1] + ((c[1] - b[1]) / lc) * d];
    for (let k = 0; k <= steps; k++) {
      const t = k / steps;
      out.push([p1[0] * (1 - t) * (1 - t) + b[0] * 2 * t * (1 - t) + p2[0] * t * t, p1[1] * (1 - t) * (1 - t) + b[1] * 2 * t * (1 - t) + p2[1] * t * t]);
    }
  }
  return cleanPoly(out);
}

/**
 * earcut drops collinear vertices along hole bridges (aligned slots), which leaves T-junctions, and can return
 * zero-area triangles. Triangles are split at any vertex lying inside one of their edges; zero-area ones are removed.
 */
function fixDegenerate(flat: number[], t: number[]): number[] {
  const n = flat.length / 2;
  const tris: number[][] = [];
  for (let i = 0; i < t.length; i += 3) tris.push([t[i], t[i + 1], t[i + 2]]);
  const X = (i: number) => flat[i * 2], Y = (i: number) => flat[i * 2 + 1];
  const area = (a: number, b: number, c: number) => (X(b) - X(a)) * (Y(c) - Y(a)) - (X(c) - X(a)) * (Y(b) - Y(a));
  for (let i = 0; i < tris.length && tris.length < 20000; i++) {
    const tr = tris[i];
    split: for (let e = 0; e < 3; e++) {
      const p = tr[e], q = tr[(e + 1) % 3], r = tr[(e + 2) % 3];
      const dx = X(q) - X(p), dy = Y(q) - Y(p);
      const l2 = dx * dx + dy * dy;
      if (l2 < 1e-12) continue;
      for (let m = 0; m < n; m++) {
        if (m === p || m === q || m === r) continue;
        const mx = X(m) - X(p), my = Y(m) - Y(p);
        const along = mx * dx + my * dy;
        if (along <= 1e-9 || along >= l2 - 1e-9) continue;
        if (Math.abs(mx * dy - my * dx) > 1e-6 * Math.sqrt(l2)) continue;
        tris.splice(i, 1, [p, m, r], [m, q, r]);
        i--;
        break split;
      }
    }
  }
  return tris.filter(([a, b, c]) => Math.abs(area(a, b, c)) > 1e-9).flat();
}

export class Kit {
  readonly parts = new Map<string, Map<string, Buf>>();
  /** Problems found while building (open or inside-out primitives). */
  readonly warnings: string[] = [];
  private partName = "body";
  private matName = "gunmetal";
  private xf: Xf = IDENT;
  private label = "";
  private count = 0;

  /** lod 0 = first-person detail, 1 = world model (no small details, fewer segments, no bevels). */
  readonly lod: 0 | 1;
  constructor(lod: 0 | 1 = 0) {
    this.lod = lod;
  }
  get hi(): boolean {
    return this.lod === 0;
  }
  /** Radial segments for the level of detail. */
  segs(hi: number, lo = Math.max(6, Math.round(hi / 2))): number {
    return this.hi ? hi : lo;
  }
  part(name: string): this {
    this.partName = this.lod === 1 ? "body" : name;
    return this;
  }
  mat(name: string): this {
    this.matName = name;
    return this;
  }
  get material(): string {
    return this.matName;
  }
  /** Names the next primitives in warnings. */
  tag(label: string): this {
    this.label = label;
    return this;
  }
  /** Runs `fn` with the transform `m` applied (inside the current one). */
  at(m: Xf, fn: () => void): void {
    const old = this.xf;
    this.xf = xfMul(old, m);
    fn();
    this.xf = old;
  }

  /** Adds a finished mesh (already in the part's space, with its normals) to a part's material. */
  raw(part: string, mat: string, b: Buf): void {
    const keep = [this.partName, this.matName];
    this.part(part).mat(mat);
    const to = this.buf(), base = to.pos.length / 3;
    for (const v of b.pos) to.pos.push(v);
    for (const v of b.nrm) to.nrm.push(v);
    for (const i of b.idx) to.idx.push(base + i);
    this.partName = keep[0]!;
    this.matName = keep[1]!;
  }

  triangles(part?: string): number {
    let n = 0;
    for (const [name, mats] of this.parts) if (!part || part === name) for (const b of mats.values()) n += b.idx.length / 3;
    return n;
  }

  private buf(): Buf {
    let p = this.parts.get(this.partName);
    if (!p) this.parts.set(this.partName, (p = new Map()));
    let b = p.get(this.matName);
    if (!b) p.set(this.matName, (b = { pos: [], nrm: [], idx: [] }));
    return b;
  }

  /**
   * Adds a closed triangle mesh: welded, turned outward, with crease-angle vertex normals. `groups`: per triangle; faces
   * of the same non-zero group always share smooth normals, others when their angle is below `crease` (degrees).
   */
  mesh(pos: V3[], tris: number[], o: { crease?: number; groups?: number[]; open?: boolean } = {}): void {
    const crease = Math.cos(rad(o.crease ?? 30));
    const seen = new Map<string, number>();
    const W: V3[] = [];
    const remap = pos.map((p0) => {
      const p = xfPt(this.xf, p0);
      const key = `${Math.round(p[0] * 2000)},${Math.round(p[1] * 2000)},${Math.round(p[2] * 2000)}`;
      let i = seen.get(key);
      if (i === undefined) {
        i = W.length;
        W.push(p);
        seen.set(key, i);
      }
      return i;
    });
    const F: [number, number, number][] = [];
    const FN: V3[] = [];
    const G: number[] = [];
    for (let t = 0; t < tris.length; t += 3) {
      const a = remap[tris[t]], b = remap[tris[t + 1]], c = remap[tris[t + 2]];
      if (a === b || b === c || a === c) continue;
      const n = cross(sub(W[b], W[a]), sub(W[c], W[a]));
      if (len(n) < 1e-7) continue;
      F.push([a, b, c]);
      FN.push(norm(n));
      G.push(o.groups?.[t / 3] ?? 0);
    }
    if (!o.open) {
      // Closed? (every directed edge has its opposite)
      const edges = new Map<string, number>();
      for (const [a, b, c] of F) for (const [u, v] of [[a, b], [b, c], [c, a]]) edges.set(`${u}>${v}`, (edges.get(`${u}>${v}`) ?? 0) + 1);
      let bad = 0;
      for (const [k, n] of edges) {
        const [u, v] = k.split(">");
        if (n !== 1 || edges.get(`${v}>${u}`) !== 1) bad++;
      }
      if (bad) this.warnings.push(`${this.partName}/${this.matName} ${this.label} #${this.count}: ${bad} open or non-manifold edges (${F.length} faces, first vertex ${W[0].map((v) => v.toFixed(1))})`);
      this.count++;
      let vol = 0;
      for (const [a, b, c] of F) vol += dot(W[a], cross(W[b], W[c]));
      if (vol < 0) {
        for (let i = 0; i < F.length; i++) {
          F[i] = [F[i][0], F[i][2], F[i][1]];
          FN[i] = mul(FN[i], -1);
        }
      }
    }
    // Corner angles, vertex -> faces.
    const inc: number[][] = W.map(() => []);
    const ang: number[][] = [];
    F.forEach((f, i) => {
      const a: number[] = [];
      for (let k = 0; k < 3; k++) {
        const p = W[f[k]], q = W[f[(k + 1) % 3]], r = W[f[(k + 2) % 3]];
        a.push(Math.acos(Math.max(-1, Math.min(1, dot(norm(sub(q, p)), norm(sub(r, p)))))));
        inc[f[k]].push(i);
      }
      ang.push(a);
    });
    const buf = this.buf();
    const out = new Map<string, number>();
    F.forEach((f, i) => {
      for (let k = 0; k < 3; k++) {
        const v = f[k];
        let n: V3 = [0, 0, 0];
        for (const j of inc[v]) {
          if (j === i || (G[i] !== 0 && G[i] === G[j]) || dot(FN[i], FN[j]) >= crease) n = add(n, mul(FN[j], ang[j][F[j].indexOf(v)]));
        }
        n = norm(n);
        if (dot(n, FN[i]) < 0.2) n = FN[i];
        const key = `${v}|${Math.round(n[0] * 500)},${Math.round(n[1] * 500)},${Math.round(n[2] * 500)}`;
        let id = out.get(key);
        if (id === undefined) {
          id = buf.pos.length / 3;
          buf.pos.push(...W[v]);
          buf.nrm.push(...n);
          out.set(key, id);
        }
        buf.idx.push(id);
      }
    });
  }

  /** Extrudes `outline` (with `holes`) between `from` and `to` along the axis normal to `plane`. */
  extrude(outline: V2[], o: ExtrudeOpts): void {
    const plane = o.plane ?? "zy";
    const map = (u: number, v: number, w: number): V3 => (plane === "zy" ? [w, v, u] : plane === "xy" ? [u, v, w] : [u, w, v]);
    let from = o.from, to = o.to;
    let [bf, bt] = Array.isArray(o.bevel) ? o.bevel : [o.bevel ?? 0, o.bevel ?? 0];
    if (from > to) {
      [from, to] = [to, from];
      [bf, bt] = [bt, bf];
    }
    if (!this.hi) bf = bt = 0;
    const lim = (to - from) / 2 - 1e-3;
    bf = Math.min(bf, lim);
    bt = Math.min(bt, lim);
    let poly = cleanPoly(outline);
    if (area2(poly) < 0) poly.reverse();
    const holes = (o.holes ?? []).map((h) => {
      const c = cleanPoly(h);
      if (area2(c) > 0) c.reverse();
      return c;
    });
    const steps = Math.max(1, o.round ?? 1);
    // Rings: [w, inset]
    const rings: [number, number][] = [];
    if (bf > 0) for (let k = 0; k < steps; k++) rings.push([from + bf * (1 - Math.cos(rad((90 * k) / steps))), bf * (1 - Math.sin(rad((90 * k) / steps)))]);
    rings.push([from + bf, 0]);
    rings.push([to - bt, 0]);
    if (bt > 0) for (let k = steps - 1; k >= 0; k--) rings.push([to - bt * (1 - Math.cos(rad((90 * k) / steps))), bt * (1 - Math.sin(rad((90 * k) / steps)))]);
    const pos: V3[] = [];
    const tris: number[] = [];
    const n = poly.length;
    const ringPolys = rings.map(([, inset]) => insetPoly(poly, inset));
    rings.forEach(([w], r) => {
      for (const q of ringPolys[r]) pos.push(map(q[0], q[1], w));
    });
    for (let r = 0; r + 1 < rings.length; r++) {
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const a = r * n + i, b = r * n + j, c = (r + 1) * n + j, d = (r + 1) * n + i;
        tris.push(a, b, c, a, c, d);
      }
    }
    // Hole walls.
    const holeBase: number[] = [];
    for (const h of holes) {
      const base = pos.length;
      holeBase.push(base);
      for (const q of h) pos.push(map(q[0], q[1], from));
      for (const q of h) pos.push(map(q[0], q[1], to));
      const m = h.length;
      for (let i = 0; i < m; i++) {
        const j = (i + 1) % m;
        tris.push(base + i, base + j, base + m + j, base + i, base + m + j, base + m + i);
      }
    }
    // Caps.
    for (const top of [false, true]) {
      const ring = top ? rings.length - 1 : 0;
      const flat: number[] = [];
      const ids: number[] = [];
      ringPolys[ring].forEach((q, i) => {
        flat.push(q[0], q[1]);
        ids.push(ring * n + i);
      });
      const holeIdx: number[] = [];
      holes.forEach((h, k) => {
        holeIdx.push(flat.length / 2);
        h.forEach((q, i) => {
          flat.push(q[0], q[1]);
          ids.push(holeBase[k] + (top ? h.length : 0) + i);
        });
      });
      const t = fixDegenerate(flat, earcut(flat, holeIdx));
      for (let i = 0; i < t.length; i += 3) {
        const [a, b, c] = [t[i], t[i + 1], t[i + 2]];
        const s = (flat[b * 2] - flat[a * 2]) * (flat[c * 2 + 1] - flat[a * 2 + 1]) - (flat[c * 2] - flat[a * 2]) * (flat[b * 2 + 1] - flat[a * 2 + 1]);
        if ((s > 0) === top) tris.push(ids[a], ids[b], ids[c]);
        else tris.push(ids[a], ids[c], ids[b]);
      }
    }
    this.mesh(pos, tris, { crease: o.crease ?? 32 });
  }

  /** Chamfered box between two corners (`bevel` on all edges). */
  box(min: V3, max: V3, bevel = 0, o: { plane?: Plane; round?: number; crease?: number } = {}): void {
    const plane = o.plane ?? "zy";
    const b = this.hi ? bevel : 0;
    const [u, v, w] = plane === "zy" ? [2, 1, 0] : plane === "xy" ? [0, 1, 2] : [0, 2, 1];
    this.extrude(rect(min[u], max[u], min[v], max[v], b), { plane, from: Math.min(min[w], max[w]), to: Math.max(min[w], max[w]), bevel: b, round: o.round, crease: o.crease });
  }

  /**
   * Revolves a profile of [t, r] points (t along the axis, absolute; r the radius) around an axis through `at`. An open
   * profile is closed through the axis; `closed` joins the last point to the first (a tube with a bore).
   */
  lathe(profile: V2[], o: { axis?: "x" | "y" | "z"; at?: V3; segs?: number; closed?: boolean; crease?: number; phase?: number; sx?: number; sy?: number } = {}): void {
    const axis = o.axis ?? "z";
    const at = o.at ?? [0, 0, 0];
    const segs = o.segs ?? 16;
    const prof = profile.map((p) => [p[0], Math.max(0, p[1])] as V2);
    if (!o.closed) {
      if (prof[0][1] > 1e-6) prof.unshift([prof[0][0], 0]);
      if (prof[prof.length - 1][1] > 1e-6) prof.push([prof[prof.length - 1][0], 0]);
    }
    const sx = o.sx ?? 1, sy = o.sy ?? 1;
    const pos: V3[] = [];
    const tris: number[] = [];
    const groups: number[] = [];
    for (const [t, r] of prof) {
      for (let j = 0; j < segs; j++) {
        const th = rad(o.phase ?? 0) + (2 * Math.PI * j) / segs;
        const c = r * Math.cos(th) * sx, s = r * Math.sin(th) * sy;
        pos.push(axis === "z" ? [at[0] + c, at[1] + s, t] : axis === "x" ? [t, at[1] + c, at[2] + s] : [at[0] + c, t, at[2] + s]);
      }
    }
    const m = prof.length;
    const last = o.closed ? m : m - 1;
    for (let i = 0; i < last; i++) {
      const i2 = (i + 1) % m;
      for (let j = 0; j < segs; j++) {
        const j2 = (j + 1) % segs;
        const a = i * segs + j, b = i2 * segs + j, c = i2 * segs + j2, d = i * segs + j2;
        tris.push(a, b, c, a, c, d);
        groups.push(i + 1, i + 1);
      }
    }
    this.mesh(pos, tris, { crease: o.crease ?? 28, groups });
  }

  /** Cylinder from `a` to `b` (radius r, or r at a and r2 at b), with chamfered rims. */
  cyl(a: V3, b: V3, r: number, segs = 12, o: { r2?: number; bevel?: number; crease?: number; phase?: number } = {}): void {
    const d = sub(b, a), L = len(d);
    const z = norm(d), x = perp(z), y = cross(z, x);
    const r2 = o.r2 ?? r;
    const bv = this.hi ? Math.min(o.bevel ?? 0, L / 2, r, r2) : 0;
    const prof: V2[] = bv > 0 ? [[0, r - bv], [bv, r], [L - bv, r2], [L, r2 - bv]] : [[0, r], [L, r2]];
    this.at(basis(a, x, y, z), () => this.lathe(prof, { segs, crease: o.crease, phase: o.phase }));
  }

  /** Skin over rings (same segment count), with flat or domed ends. Smooth all over; flat caps stay hard. */
  loft(rings: Ring[], o: { segs?: number; cap?: [Cap, Cap]; capLen?: [number, number]; crease?: number } = {}): void {
    const segs = o.segs ?? 12;
    const cap = o.cap ?? ["flat", "flat"];
    const list: { r: Ring; g: number }[] = [];
    const scaled = (r: Ring, c: V3, s: number): Ring => ({ c, a: mul(r.a, s), b: mul(r.b, s), e: r.e });
    const capRings = (end: 0 | 1): { r: Ring; g: number }[] => {
      const r = rings[end === 0 ? 0 : rings.length - 1];
      const nb = rings[end === 0 ? 1 : rings.length - 2];
      const kind = cap[end];
      if (kind === "none") return [];
      if (kind === "flat") return [{ r: scaled(r, r.c, 0), g: end === 0 ? 2 : 3 }];
      let d = norm(cross(r.a, r.b));
      if (dot(d, sub(r.c, nb.c)) < 0) d = mul(d, -1);
      const h = o.capLen?.[end] ?? 0.9 * Math.min(len(r.a), len(r.b));
      return [35, 65, 90].map((phi) => ({ r: scaled(r, add(r.c, mul(d, h * Math.sin(rad(phi)))), phi === 90 ? 0 : Math.cos(rad(phi))), g: 1 }));
    };
    // g = the group of the band that ends at this ring.
    for (const c of capRings(0).reverse()) list.push({ r: c.r, g: 1 });
    const startCap = list.length;
    rings.forEach((r) => list.push({ r, g: 1 }));
    for (const c of capRings(1)) list.push(c);
    if (cap[0] === "flat" && startCap > 0) list[startCap].g = 2;
    const pos: V3[] = [];
    const tris: number[] = [];
    const groups: number[] = [];
    for (const { r } of list) {
      const e = 2 / (r.e ?? 2);
      for (let j = 0; j < segs; j++) {
        const th = (2 * Math.PI * j) / segs;
        const c = Math.cos(th), s = Math.sin(th);
        const cu = Math.sign(c) * Math.abs(c) ** e, sv = Math.sign(s) * Math.abs(s) ** e;
        pos.push(add(r.c, add(mul(r.a, cu), mul(r.b, sv))));
      }
    }
    for (let i = 0; i + 1 < list.length; i++) {
      for (let j = 0; j < segs; j++) {
        const j2 = (j + 1) % segs;
        const a = i * segs + j, b = (i + 1) * segs + j, c = (i + 1) * segs + j2, d = i * segs + j2;
        tris.push(a, b, c, a, c, d);
        groups.push(list[i + 1].g, list[i + 1].g);
      }
    }
    this.mesh(pos, tris, { crease: o.crease ?? 20, groups, open: cap[0] === "none" || cap[1] === "none" });
  }

  /**
   * A loft along `path`. `r(s)`: the section's radii [ra, rb] (or one radius) at arc-length fraction s in [0, 1]; `up`
   * orients the ra axis (parallel-transported along the path).
   */
  tube(path: V3[], r: number | ((s: number) => number | [number, number]), o: { segs?: number; cap?: [Cap, Cap]; capLen?: [number, number]; up?: V3; e?: number; crease?: number } = {}): void {
    const n = path.length;
    const cum = [0];
    for (let i = 1; i < n; i++) cum.push(cum[i - 1] + len(sub(path[i], path[i - 1])));
    const total = cum[n - 1] || 1;
    const tan = path.map((_, i) => norm(sub(path[Math.min(n - 1, i + 1)], path[Math.max(0, i - 1)])));
    let u = o.up ? norm(sub(o.up, mul(tan[0], dot(o.up, tan[0])))) : perp(tan[0]);
    const rings: Ring[] = [];
    for (let i = 0; i < n; i++) {
      u = norm(sub(u, mul(tan[i], dot(u, tan[i]))));
      const v = cross(tan[i], u);
      const rr = typeof r === "number" ? r : r(cum[i] / total);
      const [ra, rb] = Array.isArray(rr) ? rr : [rr, rr];
      rings.push({ c: path[i], a: mul(u, ra), b: mul(v, rb), e: o.e });
    }
    this.loft(rings, { segs: o.segs ?? 8, cap: o.cap, capLen: o.capLen, crease: o.crease });
  }

  /**
   * Picatinny rail along z from z0 to z1 (z0 > z1), centred on x = `x`, its top at `top`: a dovetail bar with teeth
   * (MIL-STD-1913 pitch); the world model gets the bar alone.
   */
  rail(z0: number, z1: number, top: number, o: { x?: number; depth?: number; roll?: number; pivot?: V2 } = {}): void {
    if (z0 < z1) [z0, z1] = [z1, z0];
    const x = o.x ?? 0;
    const depth = o.depth ?? 8;
    const build = () => {
      if (!this.hi) {
        this.extrude([[x - 7.8, top - depth], [x + 7.8, top - depth], [x + 10.6, top - 3], [x + 7.8, top], [x - 7.8, top], [x - 10.6, top - 3]], { plane: "xy", from: z1, to: z0 });
        return;
      }
      this.extrude([[x - 7.8, top - depth], [x + 7.8, top - depth], [x + 7.8, top - 5.8], [x + 10.6, top - 3.2], [x - 10.6, top - 3.2], [x - 7.8, top - 5.8]], { plane: "xy", from: z1, to: z0 });
      const pitch = 10.0076, tooth = 4.78;
      const count = Math.floor((z0 - z1 - tooth) / pitch) + 1;
      const start = z0 - (z0 - z1 - ((count - 1) * pitch + tooth)) / 2;
      const pos: V3[] = [];
      const tris: number[] = [];
      for (let i = 0; i < count; i++) {
        const za = start - i * pitch, zb = za - tooth;
        const base = pos.length;
        for (const z of [za, zb]) pos.push([x - 10.6, top - 3.5, z], [x + 10.6, top - 3.5, z], [x + 10.6, top - 2.9, z], [x + 7.9, top, z], [x - 7.9, top, z], [x - 10.6, top - 2.9, z]);
        for (let k = 0; k < 6; k++) {
          const k2 = (k + 1) % 6;
          tris.push(base + k, base + k2, base + 6 + k2, base + k, base + 6 + k2, base + 6 + k);
        }
        for (const [a, b, c] of [[0, 1, 2], [0, 2, 5], [5, 2, 3], [5, 3, 4]]) tris.push(base + a, base + c, base + b, base + 6 + a, base + 6 + b, base + 6 + c);
      }
      this.mesh(pos, tris, { crease: 20 });
    };
    if (o.roll) this.at(rotAbout([o.pivot?.[0] ?? 0, o.pivot?.[1] ?? 0, 0], [0, 0, 1], o.roll), build);
    else build();
  }
}
