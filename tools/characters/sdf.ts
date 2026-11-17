// Signed distance fields for sculpting characters in code: a shape is a function of a point (millimetres) that gives
// the distance to its surface, negative inside. Shapes are combined (unions that blend like clay, cuts, shells) and
// then meshed (mesh.ts). Distances may be underestimates (a stretched or displaced shape), never large overestimates:
// the mesher skips space by them.
export type V3 = [number, number, number];
export type Sdf = (x: number, y: number, z: number) => number;

/** A frame: an origin and three unit axes at right angles. */
export interface Frame { o: V3; x: V3; y: V3; z: V3 }

export const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const mul = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const len = (a: V3): number => Math.hypot(a[0], a[1], a[2]);
export const norm = (a: V3): V3 => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
export const mix = (a: V3, b: V3, t: number): V3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
export const rad = (deg: number): number => (deg * Math.PI) / 180;
const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);

/** A frame at `o` whose y axis is `y` and whose z axis is as near `zHint` as that allows. */
export function frame(o: V3, y: V3, zHint: V3 = [0, 0, 1]): Frame {
  const yy = norm(y);
  let x = cross(yy, zHint);
  if (len(x) < 1e-6) x = cross(yy, [1, 0, 0]);
  x = norm(x);
  return { o, x, y: yy, z: cross(x, yy) };
}
/** A frame turned about an axis through its origin (degrees). */
export function turned(f: Frame, axis: V3, deg: number): Frame {
  const a = norm(axis), c = Math.cos(rad(deg)), s = Math.sin(rad(deg));
  const r = (v: V3): V3 => add(add(mul(v, c), mul(cross(a, v), s)), mul(a, dot(a, v) * (1 - c)));
  return { o: f.o, x: r(f.x), y: r(f.y), z: r(f.z) };
}
export const IDENT: Frame = { o: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
/** The identity frame at `o`, turned about X, then Y, then Z (degrees). */
export function placed(o: V3, rx = 0, ry = 0, rz = 0): Frame {
  let f: Frame = { ...IDENT, o };
  if (rx) f = turned(f, [1, 0, 0], rx);
  if (ry) f = turned(f, [0, 1, 0], ry);
  if (rz) f = turned(f, [0, 0, 1], rz);
  return f;
}
export const toWorld = (f: Frame, p: V3): V3 => [f.o[0] + f.x[0] * p[0] + f.y[0] * p[1] + f.z[0] * p[2], f.o[1] + f.x[1] * p[0] + f.y[1] * p[1] + f.z[1] * p[2], f.o[2] + f.x[2] * p[0] + f.y[2] * p[1] + f.z[2] * p[2]];

// ---- shapes ----

export const sphere = (c: V3, r: number): Sdf => (x, y, z) => Math.hypot(x - c[0], y - c[1], z - c[2]) - r;

/** An ellipsoid (an underestimate away from it, exact on it). */
export function ellipsoid(c: V3, r: V3): Sdf {
  const m = Math.min(r[0], r[1], r[2]);
  return (x, y, z) => {
    const px = (x - c[0]) / r[0], py = (y - c[1]) / r[1], pz = (z - c[2]) / r[2];
    const k = Math.hypot(px, py, pz);
    return (k - 1) * m;
  };
}

/** A capsule, or with two radii a cone with round ends. */
export function capsule(a: V3, b: V3, r1: number, r2 = r1): Sdf {
  const bx = b[0] - a[0], by = b[1] - a[1], bz = b[2] - a[2];
  const l2 = bx * bx + by * by + bz * bz;
  if (l2 < 1e-9) return sphere(a, Math.max(r1, r2));
  if (r1 === r2) {
    return (x, y, z) => {
      const px = x - a[0], py = y - a[1], pz = z - a[2];
      const t = clamp((px * bx + py * by + pz * bz) / l2, 0, 1);
      return Math.hypot(px - bx * t, py - by * t, pz - bz * t) - r1;
    };
  }
  const rr = r1 - r2, a2 = l2 - rr * rr, il2 = 1 / l2;
  if (a2 <= 0) return r1 > r2 ? sphere(a, r1) : sphere(b, r2);
  return (x, y, z) => {
    const px = x - a[0], py = y - a[1], pz = z - a[2];
    const yy = px * bx + py * by + pz * bz, zz = yy - l2;
    const qx = px * l2 - bx * yy, qy = py * l2 - by * yy, qz = pz * l2 - bz * yy;
    const x2 = qx * qx + qy * qy + qz * qz, y2 = yy * yy * l2, z2 = zz * zz * l2;
    const k = Math.sign(rr) * rr * rr * x2;
    if (Math.sign(zz) * a2 * z2 > k) return Math.sqrt(x2 + z2) * il2 - r2;
    if (Math.sign(yy) * a2 * y2 < k) return Math.sqrt(x2 + y2) * il2 - r1;
    return (Math.sqrt(x2 * a2 * il2) + yy * rr) * il2 - r1;
  };
}

/** A box about `c` with half sizes `h`, its edges rounded by `r`. */
export function box(c: V3, h: V3, r = 0): Sdf {
  const hx = h[0] - r, hy = h[1] - r, hz = h[2] - r;
  return (x, y, z) => {
    const qx = Math.abs(x - c[0]) - hx, qy = Math.abs(y - c[1]) - hy, qz = Math.abs(z - c[2]) - hz;
    return Math.hypot(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qy, qz), 0) - r;
  };
}

/** A cylinder from `a` to `b`, its rims rounded by `round`. */
export function cylinder(a: V3, b: V3, r: number, round = 0): Sdf {
  const ax = norm(sub(b, a)), L = len(sub(b, a));
  return (x, y, z) => {
    const px = x - a[0], py = y - a[1], pz = z - a[2];
    const t = px * ax[0] + py * ax[1] + pz * ax[2];
    const rd = Math.sqrt(Math.max(0, px * px + py * py + pz * pz - t * t));
    const dx = rd - r + round, dy = Math.abs(t - L / 2) - L / 2 + round;
    return Math.min(Math.max(dx, dy), 0) + Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) - round;
  };
}

/** A ring about `c` in the plane across `axis`: big radius `R`, tube radius `r`. */
export function torus(c: V3, axis: V3, R: number, r: number): Sdf {
  const n = norm(axis);
  return (x, y, z) => {
    const px = x - c[0], py = y - c[1], pz = z - c[2];
    const t = px * n[0] + py * n[1] + pz * n[2];
    const rd = Math.sqrt(Math.max(0, px * px + py * py + pz * pz - t * t));
    return Math.hypot(rd - R, t) - r;
  };
}

/** Everything behind the plane through `p` with outward normal `n`. */
export function half(p: V3, n: V3): Sdf {
  const u = norm(n), d = dot(p, u);
  return (x, y, z) => x * u[0] + y * u[1] + z * u[2] - d;
}

/** A section of a `profile`: at height y, an ellipse (n = 2) or a boxier superellipse (n > 2) about (cx, cz). */
export interface Section { y: number; rx: number; rz: number; cx?: number; cz?: number; n?: number }

/**
 * A body lofted through sections stacked along Y (limbs, torsos, boots): between sections every number is eased
 * (Catmull-Rom), the ends are flat. Blend a ball onto an end to close it round.
 */
export function profile(sections: Section[]): Sdf {
  const s = [...sections].sort((a, b) => a.y - b.y).map((q) => ({ y: q.y, rx: q.rx, rz: q.rz, cx: q.cx ?? 0, cz: q.cz ?? 0, n: q.n ?? 2 }));
  const y0 = s[0]!.y, y1 = s[s.length - 1]!.y;
  type K = "rx" | "rz" | "cx" | "cz" | "n";
  const at = (i: number) => s[clamp(i, 0, s.length - 1)]!;
  const cr = (k: K, i: number, t: number) => {
    const p0 = at(i - 1)[k], p1 = at(i)[k], p2 = at(i + 1)[k], p3 = at(i + 2)[k];
    return 0.5 * (2 * p1 + (p2 - p0) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (3 * p1 - p0 - 3 * p2 + p3) * t * t * t);
  };
  return (x, y, z) => {
    const yc = clamp(y, y0, y1);
    let i = 0;
    while (i < s.length - 2 && s[i + 1]!.y < yc) i++;
    const t = (yc - s[i]!.y) / Math.max(1e-6, s[i + 1]!.y - s[i]!.y);
    const rx = Math.max(1, cr("rx", i, t)), rz = Math.max(1, cr("rz", i, t)), n = Math.max(2, cr("n", i, t));
    const px = Math.abs(x - cr("cx", i, t)) / rx, pz = Math.abs(z - cr("cz", i, t)) / rz;
    const k = n === 2 ? Math.hypot(px, pz) : Math.pow(Math.pow(px, n) + Math.pow(pz, n), 1 / n);
    const dr = (k - 1) * Math.min(rx, rz);
    const dy = Math.max(y0 - y, y - y1);
    return dr > 0 && dy > 0 ? Math.hypot(dr, dy) : Math.max(dr, dy);
  };
}

// ---- combinations ----

export const union = (...s: Sdf[]): Sdf => (s.length === 1 ? s[0]! : (x, y, z) => { let d = Infinity; for (const f of s) { const v = f(x, y, z); if (v < d) d = v; } return d; });
const smin = (a: number, b: number, k: number) => { const h = Math.max(k - Math.abs(a - b), 0) / k; return Math.min(a, b) - h * h * k * 0.25; };
/** A union whose seams are filled in over about `k` millimetres, as clay pressed together. */
export const blend = (k: number, ...s: Sdf[]): Sdf => (x, y, z) => { let d = s[0]!(x, y, z); for (let i = 1; i < s.length; i++) d = smin(d, s[i]!(x, y, z), k); return d; };
/** `a` with `b` taken out; with `k`, the cut's edge is rounded. */
export const cut = (a: Sdf, b: Sdf, k = 0): Sdf => (k > 0 ? (x, y, z) => -smin(-a(x, y, z), b(x, y, z), k) : (x, y, z) => Math.max(a(x, y, z), -b(x, y, z)));
/** What is in all of them; with `k`, the edge is rounded. */
export const both = (a: Sdf, b: Sdf, k = 0): Sdf => (k > 0 ? (x, y, z) => -smin(-a(x, y, z), -b(x, y, z), k) : (x, y, z) => Math.max(a(x, y, z), b(x, y, z)));
/** The shape grown by `r` (shrunk by a negative one). */
export const grown = (a: Sdf, r: number): Sdf => (x, y, z) => a(x, y, z) - r;
/** A skin of thickness `t` outside the surface of `a` (from `inner` to `inner + t` off it). */
export const skin = (a: Sdf, inner: number, t: number): Sdf => (x, y, z) => Math.abs(a(x, y, z) - inner - t / 2) - t / 2;
/** The shape moved along its normal by `f` millimetres (small ones: folds, weave, tread). */
export const displaced = (a: Sdf, f: Sdf): Sdf => (x, y, z) => a(x, y, z) - f(x, y, z);
/** The shape as given in `f`'s own coordinates. */
export function at(f: Frame, a: Sdf): Sdf {
  const { o, x: ax, y: ay, z: az } = f;
  return (x, y, z) => {
    const px = x - o[0], py = y - o[1], pz = z - o[2];
    return a(px * ax[0] + py * ax[1] + pz * ax[2], px * ay[0] + py * ay[1] + pz * ay[2], px * az[0] + py * az[1] + pz * az[2]);
  };
}
export const moved = (a: Sdf, d: V3): Sdf => (x, y, z) => a(x - d[0], y - d[1], z - d[2]);
/** The shape and its mirror image in the plane x = 0 (model the +X half). */
export const mirrored = (a: Sdf): Sdf => (x, y, z) => a(Math.abs(x), y, z);
/** The shape's mirror image in the plane x = 0. */
export const flipped = (a: Sdf): Sdf => (x, y, z) => a(-x, y, z);

// ---- surface detail ----

const hash = (x: number, y: number, z: number) => { const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453; return s - Math.floor(s); };
/** Smooth noise in -1..1 with features about `size` millimetres across. */
export function noise(size: number, seed = 0): Sdf {
  const f = 1 / size;
  return (x, y, z) => {
    const px = x * f + seed * 17.3, py = y * f + seed * 5.1, pz = z * f - seed * 9.7;
    const ix = Math.floor(px), iy = Math.floor(py), iz = Math.floor(pz);
    const fx = px - ix, fy = py - iy, fz = pz - iz;
    const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy), uz = fz * fz * (3 - 2 * fz);
    const l = (a: number, b: number, t: number) => a + (b - a) * t;
    const v = l(
      l(l(hash(ix, iy, iz), hash(ix + 1, iy, iz), ux), l(hash(ix, iy + 1, iz), hash(ix + 1, iy + 1, iz), ux), uy),
      l(l(hash(ix, iy, iz + 1), hash(ix + 1, iy, iz + 1), ux), l(hash(ix, iy + 1, iz + 1), hash(ix + 1, iy + 1, iz + 1), ux), uy),
      uz,
    );
    return v * 2 - 1;
  };
}
/**
 * Cloth folds: creases of about `depth` millimetres running across `across` (a unit direction), `size` apart, wandering
 * as real ones do. Add it with `displaced`.
 */
export function folds(depth: number, size: number, across: V3 = [0, 1, 0], seed = 0): Sdf {
  const n = noise(size * 3, seed), m = noise(size * 1.4, seed + 3);
  return (x, y, z) => {
    const t = (x * across[0] + y * across[1] + z * across[2]) / size + n(x, y, z) * 0.55;
    const w = 1 - Math.abs(Math.sin(t * Math.PI));
    // (Creases are narrow and their depth varies along them; between them the cloth is smooth.)
    return depth * (w * w * w * (0.6 + 0.4 * m(x, y, z)) - 0.12);
  };
}
/** 0 below `a`, 1 above `b`, eased between (for fading a detail in along a limb). */
export const ramp = (a: number, b: number, v: number): number => { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
