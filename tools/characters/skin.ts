// The clothed body as one skinned mesh: every part's cloth (the layers marked `skin` in operator.ts) put in the bind
// pose (skeleton.ts) and meshed as one surface, so the shirt runs into the sleeves and the trousers into the legs
// with no seam; then each vertex is given to the joints that move it.
//
// The weights come from the parts themselves: a vertex belongs to the joints whose parts it lies on (its distance to
// each part's shapes in the bind pose), only among a joint and its skeleton neighbours (a thigh never pulls the
// other leg's cloth), and they are smoothed over the surface, so a bend spreads over the cloth about the joint as the
// joints' balls of cloth share it. Cloth hidden inside rigid gear (the shirt under the plate carrier) is left out
// where it moves with that gear's part alone; near a joint it stays, since there the gear and the cloth part ways.
import { JOINTS, type JointName, type PartName } from "../../src/character/rig.ts";
import { type Buf, mesh } from "./mesh.ts";
import type { PartDef } from "./operator.ts";
import { type Frame, type Sdf, type V3, at, blend, box, toWorld, union } from "./sdf.ts";
import { bindPose, neighbours } from "./skeleton.ts";

/** A skinned mesh: four joints (indices into `JOINTS`) and their weights for every vertex. */
export interface Skinned extends Buf { joints: number[]; weights: number[] }

export interface SkinOptions {
  /** Triangle size of each material (millimetres). */
  cell: Record<string, number>;
  /** How far the simplified surface may be from the sculpted one (millimetres). */
  tolerance: number;
  /** How fast a joint's hold falls off with distance from its part (millimetres). */
  reach?: number;
  /** Passes of smoothing over the surface. */
  smooth?: number;
}

type Bound = Exclude<PartName, "hand_r" | "hand_l">;

/** A shape that is only worked out near its box: outside it, the distance to the box (never more than the shape's). */
function bounded(f: Sdf, lo: V3, hi: V3): Sdf {
  const c: V3 = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
  const b = box(c, [(hi[0] - lo[0]) / 2, (hi[1] - lo[1]) / 2, (hi[2] - lo[2]) / 2]);
  return (x, y, z) => { const d = b(x, y, z); return d > 6 ? d : f(x, y, z); };
}

/** A part's box in the bind pose (the box about its own box turned into place). */
function placedBox(f: Frame, p: PartDef): [V3, V3] {
  const lo: V3 = [Infinity, Infinity, Infinity], hi: V3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < 8; i++) {
    const w = toWorld(f, [i & 1 ? p.max[0] : p.min[0], i & 2 ? p.max[1] : p.min[1], i & 4 ? p.max[2] : p.min[2]]);
    for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k]!, w[k]!); hi[k] = Math.max(hi[k]!, w[k]!); }
  }
  return [lo, hi];
}

/** The skinned body by material, and what of each part is gear (rigid), for culling. */
export function skinBody(defs: Record<Bound, PartDef>, o: SkinOptions): Map<string, Skinned> {
  const bind = bindPose();
  const reach = o.reach ?? 14, passes = o.smooth ?? 6;
  const placed = (part: Bound, s: Sdf): Sdf => { const [lo, hi] = placedBox(bind[part], defs[part]); return bounded(at(bind[part], s), lo, hi); };
  const isJoint = (p: string): p is JointName => (JOINTS as string[]).includes(p);

  // The cloth by material, and each joint's part as a whole (for the weights), and each part's gear (for culling).
  const cloth = new Map<string, { shapes: Sdf[]; lo: V3; hi: V3 }>();
  const whole = new Map<JointName, Sdf>();
  const gear = new Map<Bound, Sdf>();
  for (const part of Object.keys(bind) as Bound[]) {
    const def = defs[part];
    const [lo, hi] = placedBox(bind[part], def);
    for (const l of def.layers.filter((l) => l.skin)) {
      if (!isJoint(part)) throw new Error(`${part}: cloth of the skinned body on a part that is not a joint of SKELETON`);
      const c = cloth.get(l.mat) ?? { shapes: [], lo: [Infinity, Infinity, Infinity], hi: [-Infinity, -Infinity, -Infinity] };
      c.shapes.push(placed(part, l.shape));
      for (let k = 0; k < 3; k++) { c.lo[k] = Math.min(c.lo[k]!, lo[k]!); c.hi[k] = Math.max(c.hi[k]!, hi[k]!); }
      cloth.set(l.mat, c);
    }
    if (isJoint(part)) whole.set(part, placed(part, union(...def.layers.map((l) => l.shape))));
    const rigid = def.layers.filter((l) => !l.skin);
    if (rigid.length) gear.set(part, placed(part, union(...rigid.map((l) => l.shape))));
  }

  const near = neighbours();
  const out = new Map<string, Skinned>();
  const mats = [...cloth.keys()];
  for (const mat of mats) {
    const c = cloth.get(mat)!;
    // (Where two parts' cloth meet it is pressed together like clay.)
    const shape = blend(8, ...c.shapes);
    const cell = o.cell[mat] ?? 8;
    const b: Buf = { pos: [], nrm: [], idx: [] };
    mesh(shape, { min: c.lo, max: c.hi, cell, detail: Math.min(1, cell / 4), tolerance: o.tolerance }, b);
    const nv = b.pos.length / 3;

    // The weights: each joint's hold on the vertex falls off with its distance from the joint's part, among the
    // part the vertex lies on and that part's neighbours in the skeleton.
    const W = new Float64Array(nv * JOINTS.length);
    for (let v = 0; v < nv; v++) {
      const x = b.pos[v * 3]!, y = b.pos[v * 3 + 1]!, z = b.pos[v * 3 + 2]!;
      const d = JOINTS.map((j) => whole.get(j)!(x, y, z));
      let owner = 0;
      for (let j = 1; j < d.length; j++) if (d[j]! < d[owner]!) owner = j;
      const cands = [owner, ...near[JOINTS[owner]!].map((n) => JOINTS.indexOf(n))];
      for (const j of cands) W[v * JOINTS.length + j] = Math.exp(-(d[j]! - d[owner]!) / reach);
    }
    // Smoothed over the surface: each pass, a vertex takes half its neighbours' mean.
    const adj: Set<number>[] = Array.from({ length: nv }, () => new Set());
    for (let t = 0; t < b.idx.length; t += 3) for (let k = 0; k < 3; k++) { const a = b.idx[t + k]!, n = b.idx[t + ((k + 1) % 3)]!; adj[a]!.add(n); adj[n]!.add(a); }
    const J = JOINTS.length;
    for (let s = 0; s < passes; s++) {
      const next = new Float64Array(W.length);
      for (let v = 0; v < nv; v++) {
        let sum = 0;
        for (let j = 0; j < J; j++) sum += W[v * J + j]!;
        const ns = [...adj[v]!];
        for (let j = 0; j < J; j++) {
          let m = 0;
          for (const n of ns) { let sn = 0; for (let k = 0; k < J; k++) sn += W[n * J + k]!; m += W[n * J + j]! / (sn || 1); }
          next[v * J + j] = 0.5 * (W[v * J + j]! / (sum || 1)) + 0.5 * (ns.length ? m / ns.length : W[v * J + j]! / (sum || 1));
        }
      }
      W.set(next);
    }
    // The four strongest, summing to one.
    const joints: number[] = [], weights: number[] = [];
    const hold = new Float64Array(nv * J);
    for (let v = 0; v < nv; v++) {
      const order = [...Array(J).keys()].sort((p, q) => W[v * J + q]! - W[v * J + p]!).slice(0, 4);
      let sum = 0;
      for (const j of order) sum += W[v * J + j]! < 0.01 ? 0 : W[v * J + j]!;
      for (const j of order) {
        const w = W[v * J + j]! < 0.01 ? 0 : W[v * J + j]! / sum;
        joints.push(j);
        weights.push(w);
        hold[v * J + j] = w;
      }
    }

    // Cloth inside gear, or inside another cloth, moving with that one part alone: out.
    const others = mats.filter((m) => m !== mat).map((m) => blend(8, ...cloth.get(m)!.shapes));
    const hidden = new Uint8Array(nv);
    for (let v = 0; v < nv; v++) {
      const x = b.pos[v * 3]!, y = b.pos[v * 3 + 1]!, z = b.pos[v * 3 + 2]!;
      if (others.some((s) => s(x, y, z) < -1.5)) { hidden[v] = 1; continue; }
      for (const [part, g] of gear) {
        const j = JOINTS.indexOf(part as JointName);
        if (j >= 0 && hold[v * J + j]! > 0.97 && g(x, y, z) < -1.5) { hidden[v] = 1; break; }
      }
    }
    const s: Skinned = { pos: [], nrm: [], idx: [], joints: [], weights: [] };
    const remap = new Int32Array(nv).fill(-1);
    for (let t = 0; t < b.idx.length; t += 3) {
      const tri = [b.idx[t]!, b.idx[t + 1]!, b.idx[t + 2]!];
      if (tri.every((v) => hidden[v])) continue;
      for (const v of tri) {
        if (remap[v]! < 0) {
          remap[v] = s.pos.length / 3;
          s.pos.push(b.pos[v * 3]!, b.pos[v * 3 + 1]!, b.pos[v * 3 + 2]!);
          s.nrm.push(b.nrm[v * 3]!, b.nrm[v * 3 + 1]!, b.nrm[v * 3 + 2]!);
          for (let k = 0; k < 4; k++) { s.joints.push(joints[v * 4 + k]!); s.weights.push(weights[v * 4 + k]!); }
        }
        s.idx.push(remap[v]!);
      }
    }
    out.set(mat, s);
  }
  return out;
}
