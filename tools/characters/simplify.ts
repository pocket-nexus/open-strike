// Takes the triangles a surface does not need out of a mesh: edges are collapsed, cheapest first, while the surface
// stays within `tolerance` millimetres of where it was and its normals stay as they were (so a crease, a fold or a
// seam keeps its triangles, and a smooth stretch of cloth or a flat plate loses most of them). A collapse moves one
// end of an edge onto the other: no vertex is invented, so positions and normals stay exact.
import type { Buf } from "./mesh.ts";

export function simplify(b: Buf, tolerance: number, turn = 0.985): Buf {
  const nv = b.pos.length / 3, nf = b.idx.length / 3;
  const P = b.pos, N = b.nrm;
  const faces = Int32Array.from(b.idx);
  const alive = new Uint8Array(nf).fill(1);
  // Per vertex: its faces, its quadric (the sum of its faces' planes, by area), whether it is on an open border.
  const of: number[][] = Array.from({ length: nv }, () => []);
  const Q = new Float64Array(nv * 10);
  const plane = (a: number, c: number, d: number): [number, number, number, number, number] | null => {
    const ux = P[c * 3]! - P[a * 3]!, uy = P[c * 3 + 1]! - P[a * 3 + 1]!, uz = P[c * 3 + 2]! - P[a * 3 + 2]!;
    const vx = P[d * 3]! - P[a * 3]!, vy = P[d * 3 + 1]! - P[a * 3 + 1]!, vz = P[d * 3 + 2]! - P[a * 3 + 2]!;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz);
    if (l < 1e-12) return null;
    nx /= l; ny /= l; nz /= l;
    return [nx, ny, nz, -(nx * P[a * 3]! + ny * P[a * 3 + 1]! + nz * P[a * 3 + 2]!), l / 2];
  };
  const edgeCount = new Map<number, number>();
  const key = (a: number, c: number) => (a < c ? a * nv + c : c * nv + a);
  for (let f = 0; f < nf; f++) {
    const a = faces[f * 3]!, c = faces[f * 3 + 1]!, d = faces[f * 3 + 2]!;
    of[a]!.push(f); of[c]!.push(f); of[d]!.push(f);
    for (const [x, y] of [[a, c], [c, d], [d, a]]) edgeCount.set(key(x!, y!), (edgeCount.get(key(x!, y!)) ?? 0) + 1);
    const p = plane(a, c, d);
    if (!p) continue;
    const [nx, ny, nz, dd, w] = p;
    const q = [nx * nx, nx * ny, nx * nz, nx * dd, ny * ny, ny * nz, ny * dd, nz * nz, nz * dd, dd * dd];
    for (const v of [a, c, d]) for (let i = 0; i < 10; i++) Q[v * 10 + i]! += q[i]! * w;
  }
  const border = new Uint8Array(nv);
  for (const [k, n] of edgeCount) if (n !== 2) { border[Math.floor(k / nv)] = 1; border[k % nv] = 1; }
  const weight = new Float64Array(nv);
  for (let v = 0; v < nv; v++) for (const f of of[v]!) weight[v]! += plane(faces[f * 3]!, faces[f * 3 + 1]!, faces[f * 3 + 2]!)?.[4] ?? 0;
  // The error of moving `u` onto `v`: how far v is from u's planes (root mean square), or Infinity when the move
  // would turn a normal, fold a face over or pull a border in.
  const tol2 = tolerance * tolerance;
  const cost = (u: number, v: number): number => {
    if (border[u]) return Infinity;
    if (N[u * 3]! * N[v * 3]! + N[u * 3 + 1]! * N[v * 3 + 1]! + N[u * 3 + 2]! * N[v * 3 + 2]! < turn) return Infinity;
    const x = P[v * 3]!, y = P[v * 3 + 1]!, z = P[v * 3 + 2]!, q = u * 10, r = v * 10;
    const e = (o: number) => Q[o]! * x * x + 2 * Q[o + 1]! * x * y + 2 * Q[o + 2]! * x * z + 2 * Q[o + 3]! * x + Q[o + 4]! * y * y + 2 * Q[o + 5]! * y * z + 2 * Q[o + 6]! * y + Q[o + 7]! * z * z + 2 * Q[o + 8]! * z + Q[o + 9]!;
    const err = Math.max(0, e(q) + e(r)) / Math.max(1e-9, weight[u]! + weight[v]!);
    if (err > tol2) return Infinity;
    for (const f of of[u]!) {
      if (!alive[f]) continue;
      const a = faces[f * 3]!, c = faces[f * 3 + 1]!, d = faces[f * 3 + 2]!;
      if (a === v || c === v || d === v) continue;
      const before = plane(a, c, d);
      const after = plane(a === u ? v : a, c === u ? v : c, d === u ? v : d);
      if (!after || (before && before[0] * after[0] + before[1] * after[1] + before[2] * after[2] < 0.5)) return Infinity;
      // (And no sliver: its normal must still agree with the vertices' normals.)
      if (after[0] * N[v * 3]! + after[1] * N[v * 3 + 1]! + after[2] * N[v * 3 + 2]! < 0.3) return Infinity;
    }
    return err;
  };
  // A heap of candidate collapses (u onto v), re-priced when u's neighbourhood has changed since.
  const stamp = new Int32Array(nv);
  const heap: { c: number; u: number; v: number; s: number }[] = [];
  const push = (it: { c: number; u: number; v: number; s: number }) => {
    heap.push(it);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p]!.c <= heap[i]!.c) break;
      [heap[p], heap[i]] = [heap[i]!, heap[p]!];
      i = p;
    }
  };
  const pop = () => {
    const top = heap[0]!, last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i;
        if (l < heap.length && heap[l]!.c < heap[m]!.c) m = l;
        if (r < heap.length && heap[r]!.c < heap[m]!.c) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i]!, heap[m]!];
        i = m;
      }
    }
    return top;
  };
  const neighbours = (u: number): Set<number> => {
    const s = new Set<number>();
    for (const f of of[u]!) if (alive[f]) for (let i = 0; i < 3; i++) if (faces[f * 3 + i] !== u) s.add(faces[f * 3 + i]!);
    return s;
  };
  const offer = (u: number) => {
    let best = Infinity, to = -1;
    for (const v of neighbours(u)) { const c = cost(u, v); if (c < best) { best = c; to = v; } }
    if (to >= 0) push({ c: best, u, v: to, s: stamp[u]! });
  };
  for (let u = 0; u < nv; u++) offer(u);
  const gone = new Uint8Array(nv);
  while (heap.length) {
    const it = pop();
    if (gone[it.u] || gone[it.v] || it.s !== stamp[it.u]) continue;
    const c = cost(it.u, it.v);
    if (c === Infinity) continue;
    if (c > it.c * 1.0001 + 1e-12) { push({ ...it, c }); continue; }
    // (A collapse must leave a surface: the two ends may share exactly the two vertices across the edge.)
    const nu = neighbours(it.u), nw = neighbours(it.v);
    let shared = 0;
    for (const x of nu) if (nw.has(x)) shared++;
    if (shared !== 2) continue;
    for (const f of of[it.u]!) {
      if (!alive[f]) continue;
      const a = faces[f * 3]!, cc = faces[f * 3 + 1]!, d = faces[f * 3 + 2]!;
      if (a === it.v || cc === it.v || d === it.v) { alive[f] = 0; continue; }
      for (let i = 0; i < 3; i++) if (faces[f * 3 + i] === it.u) faces[f * 3 + i] = it.v;
      of[it.v]!.push(f);
    }
    for (let i = 0; i < 10; i++) Q[it.v * 10 + i]! += Q[it.u * 10 + i]!;
    weight[it.v]! += weight[it.u]!;
    gone[it.u] = 1;
    of[it.u] = [];
    of[it.v] = of[it.v]!.filter((f) => alive[f]);
    stamp[it.v]!++;
    offer(it.v);
    for (const x of nw) { stamp[x]!++; offer(x); }
    for (const x of nu) if (!nw.has(x) && !gone[x]) { stamp[x]!++; offer(x); }
  }
  const out: Buf = { pos: [], nrm: [], idx: [] };
  const remap = new Int32Array(nv).fill(-1);
  for (let f = 0; f < nf; f++) {
    if (!alive[f]) continue;
    for (let i = 0; i < 3; i++) {
      const v = faces[f * 3 + i]!;
      if (remap[v]! < 0) {
        remap[v] = out.pos.length / 3;
        out.pos.push(P[v * 3]!, P[v * 3 + 1]!, P[v * 3 + 2]!);
        out.nrm.push(N[v * 3]!, N[v * 3 + 1]!, N[v * 3 + 2]!);
      }
      out.idx.push(remap[v]!);
    }
  }
  return out;
}
