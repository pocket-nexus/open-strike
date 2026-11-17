// Turns a signed distance field into triangles (surface nets): one vertex in every grid cell the surface crosses,
// pulled onto the surface, with the field's gradient as its normal. The normal is taken at a finer scale than the
// grid (`detail`), so folds and seams smaller than a cell still shade.
import type { Sdf, V3 } from "./sdf.ts";
import { simplify } from "./simplify.ts";

export interface Buf { pos: number[]; nrm: number[]; idx: number[] }

export interface MeshOptions {
  /** The box to look in (millimetres). Generous is fine: empty space is skipped. */
  min: V3; max: V3;
  /** The size of a grid cell: the size of the triangles. */
  cell: number;
  /** The scale the normals are measured at (default: a third of a cell). */
  detail?: number;
  /** Takes out the triangles the surface does not need, keeping it within this many millimetres (simplify.ts). */
  tolerance?: number;
  /** Leaves out triangles whose corners are all hidden (inside other layers). */
  hidden?: (x: number, y: number, z: number) => boolean;
}

/** Meshes `f` and appends the triangles to `out`. Returns how many it added. */
export function mesh(f: Sdf, o: MeshOptions, out: Buf): number {
  if (!o.tolerance) return nets(f, o, out);
  const raw: Buf = { pos: [], nrm: [], idx: [] };
  nets(f, o, raw);
  const s = simplify(raw, o.tolerance);
  const base = out.pos.length / 3;
  for (const v of s.pos) out.pos.push(v);
  for (const v of s.nrm) out.nrm.push(v);
  for (const i of s.idx) out.idx.push(base + i);
  return s.idx.length / 3;
}

function nets(f: Sdf, o: MeshOptions, out: Buf): number {
  const h = o.cell;
  const nx = Math.ceil((o.max[0] - o.min[0]) / h) + 1, ny = Math.ceil((o.max[1] - o.min[1]) / h) + 1, nz = Math.ceil((o.max[2] - o.min[2]) / h) + 1;
  const X = (i: number) => o.min[0] + i * h, Y = (j: number) => o.min[1] + j * h, Z = (k: number) => o.min[2] + k * h;
  // The field at the grid's nodes. Blocks far from the surface are filled with one value (the distance at their
  // centre is more than their half diagonal).
  const B = 4, far = (B * h * Math.sqrt(3)) / 2 + h;
  const bx = Math.ceil(nx / B), by = Math.ceil(ny / B), bz = Math.ceil(nz / B);
  const block = new Float32Array(bx * by * bz);
  for (let k = 0; k < bz; k++) for (let j = 0; j < by; j++) for (let i = 0; i < bx; i++) block[i + bx * (j + by * k)] = f(X(i * B + (B - 1) / 2), Y(j * B + (B - 1) / 2), Z(k * B + (B - 1) / 2));
  const v = new Float32Array(nx * ny * nz);
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const b = block[Math.floor(i / B) + bx * (Math.floor(j / B) + by * Math.floor(k / B))]!;
    v[i + nx * (j + ny * k)] = Math.abs(b) > far ? b : f(X(i), Y(j), Z(k));
  }
  const cells = new Int32Array((nx - 1) * (ny - 1) * (nz - 1)).fill(-1);
  const base = out.pos.length / 3;
  const P: number[] = [];
  const corner = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]];
  const edges = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
  const d = new Float32Array(8);
  for (let k = 0; k < nz - 1; k++) for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
    let mask = 0;
    for (let c = 0; c < 8; c++) {
      d[c] = v[i + corner[c]![0]! + nx * (j + corner[c]![1]! + ny * (k + corner[c]![2]!))]!;
      if (d[c]! < 0) mask |= 1 << c;
    }
    if (mask === 0 || mask === 255) continue;
    let sx = 0, sy = 0, sz = 0, n = 0;
    for (const [a, b] of edges) {
      if (d[a!]! < 0 === d[b!]! < 0) continue;
      const t = d[a!]! / (d[a!]! - d[b!]!);
      sx += corner[a!]![0]! + (corner[b!]![0]! - corner[a!]![0]!) * t;
      sy += corner[a!]![1]! + (corner[b!]![1]! - corner[a!]![1]!) * t;
      sz += corner[a!]![2]! + (corner[b!]![2]! - corner[a!]![2]!) * t;
      n++;
    }
    cells[i + (nx - 1) * (j + (ny - 1) * k)] = P.length / 3;
    P.push(X(i) + (sx / n) * h, Y(j) + (sy / n) * h, Z(k) + (sz / n) * h);
  }
  // Onto the surface (two steps along the gradient, never out of the neighbourhood), and the normals.
  const e = o.detail ?? h / 3;
  const N: number[] = new Array(P.length);
  const grad = (x: number, y: number, z: number, s: number): V3 => [f(x + s, y, z) - f(x - s, y, z), f(x, y + s, z) - f(x, y - s, z), f(x, y, z + s) - f(x, y, z - s)];
  for (let q = 0; q < P.length; q += 3) {
    let x = P[q]!, y = P[q + 1]!, z = P[q + 2]!;
    for (let it = 0; it < 2; it++) {
      const g = grad(x, y, z, h * 0.5);
      const l = Math.hypot(g[0], g[1], g[2]) || 1;
      const step = Math.max(-h * 0.5, Math.min(h * 0.5, f(x, y, z)));
      x -= (g[0] / l) * step; y -= (g[1] / l) * step; z -= (g[2] / l) * step;
    }
    P[q] = x; P[q + 1] = y; P[q + 2] = z;
    const g = grad(x, y, z, e);
    const l = Math.hypot(g[0], g[1], g[2]) || 1;
    N[q] = g[0] / l; N[q + 1] = g[1] / l; N[q + 2] = g[2] / l;
  }
  // A quad about every grid edge the surface crosses, between the four cells that share the edge.
  const tris: number[] = [];
  const cell = (i: number, j: number, k: number) => cells[i + (nx - 1) * (j + (ny - 1) * k)]!;
  const quad = (a: number, b: number, c: number, dd: number, flip: boolean) => {
    if (a < 0 || b < 0 || c < 0 || dd < 0) return;
    const l = (p: number, q: number) => Math.hypot(P[p * 3]! - P[q * 3]!, P[p * 3 + 1]! - P[q * 3 + 1]!, P[p * 3 + 2]! - P[q * 3 + 2]!);
    const t = l(a, c) <= l(b, dd) ? [a, b, c, a, c, dd] : [a, b, dd, b, c, dd];
    if (flip) for (let q = 0; q < 6; q += 3) tris.push(t[q]!, t[q + 2]!, t[q + 1]!);
    else tris.push(...t);
  };
  for (let k = 1; k < nz - 1; k++) for (let j = 1; j < ny - 1; j++) for (let i = 1; i < nx - 1; i++) {
    const a = v[i + nx * (j + ny * k)]! < 0;
    if (i < nx - 1 && a !== v[i + 1 + nx * (j + ny * k)]! < 0) quad(cell(i, j - 1, k - 1), cell(i, j, k - 1), cell(i, j, k), cell(i, j - 1, k), !a);
    if (j < ny - 1 && a !== v[i + nx * (j + 1 + ny * k)]! < 0) quad(cell(i - 1, j, k - 1), cell(i - 1, j, k), cell(i, j, k), cell(i, j, k - 1), !a);
    if (k < nz - 1 && a !== v[i + nx * (j + ny * (k + 1))]! < 0) quad(cell(i - 1, j - 1, k), cell(i, j - 1, k), cell(i, j, k), cell(i - 1, j, k), !a);
  }
  // Hidden triangles out, unused vertices out.
  const hid = o.hidden ? Array.from({ length: P.length / 3 }, (_, q) => o.hidden!(P[q * 3]!, P[q * 3 + 1]!, P[q * 3 + 2]!)) : null;
  const remap = new Int32Array(P.length / 3).fill(-1);
  let added = 0;
  for (let t = 0; t < tris.length; t += 3) {
    const a = tris[t]!, b = tris[t + 1]!, c = tris[t + 2]!;
    if (hid && hid[a] && hid[b] && hid[c]) continue;
    // (Wound so the face looks the way its normals do.)
    const ux = P[b * 3]! - P[a * 3]!, uy = P[b * 3 + 1]! - P[a * 3 + 1]!, uz = P[b * 3 + 2]! - P[a * 3 + 2]!;
    const wx = P[c * 3]! - P[a * 3]!, wy = P[c * 3 + 1]! - P[a * 3 + 1]!, wz = P[c * 3 + 2]! - P[a * 3 + 2]!;
    const facing = (uy * wz - uz * wy) * (N[a * 3]! + N[b * 3]! + N[c * 3]!) + (uz * wx - ux * wz) * (N[a * 3 + 1]! + N[b * 3 + 1]! + N[c * 3 + 1]!) + (ux * wy - uy * wx) * (N[a * 3 + 2]! + N[b * 3 + 2]! + N[c * 3 + 2]!);
    for (const q of facing >= 0 ? [a, b, c] : [a, c, b]) {
      if (remap[q]! < 0) {
        remap[q] = out.pos.length / 3 - base;
        out.pos.push(P[q * 3]!, P[q * 3 + 1]!, P[q * 3 + 2]!);
        out.nrm.push(N[q * 3]!, N[q * 3 + 1]!, N[q * 3 + 2]!);
      }
      out.idx.push(base + remap[q]!);
    }
    added++;
  }
  return added;
}
