// A gloved hand and its forearm, sculpted from the joints of a pose: the first-person arms on every weapon
// (tools/weapons/arms.ts gives the pose) and the hands of the soldiers seen in the world (operator.ts).
//
// The glove is a tactical one: a knit back with a moulded knuckle bar and pads on the fingers, a suede palm, a strap
// at the wrist. Hand space (millimetres): x towards the thumb, y out of the back of the hand, z from the wrist to the
// knuckles. A left hand is the same shape in a mirrored frame.
import { type Frame, type Sdf, type V3, add, at, blend, both, box, capsule, cut, displaced, ellipsoid, folds, frame, grown, len, mix, mul, norm, profile, ramp, sub, toWorld, torus, union } from "./sdf.ts";
import { type Buf, mesh } from "./mesh.ts";

export interface HandShape {
  side: "R" | "L";
  /** Hand space in the model's space: origin at the wrist, x to the thumb, y out of the back, z to the knuckles. */
  frame: Frame;
  /** 1 = a large gloved hand. */
  scale: number;
  /** Index, middle, ring, little: knuckle, middle joint, end joint, tip (hand space). */
  fingers: V3[][];
  /** The thumb: where it leaves the palm, knuckle, end joint, tip (hand space). */
  thumb: [V3, V3, V3, V3];
}

/** Finger radii at the knuckle (index..little); they taper to the tip. */
const RADIUS = [10.4, 10.6, 10.0, 9.0];

export interface HandOptions {
  /** Triangle size, millimetres (first person: about 2; in the world: 4). */
  cell: number;
  /** Where the forearm ends (model space), for a first-person arm; without it only the glove's cuff is made. */
  elbow?: V3;
  /** How far the simplified surface may be from the sculpted one, millimetres (default 0.15). */
  tolerance?: number;
  /** A watch on the cuff. */
  watch?: boolean;
}

/** Layers of one arm by material name. */
export type Layers = Map<string, Buf>;

function inHand(h: HandShape, a: Sdf): Sdf {
  const k = h.scale;
  const f = at(h.frame, (x, y, z) => a(x / k, y / k, z / k) * k);
  return f;
}

/** The glove as shapes in hand space. */
function glove(h: HandShape) {
  const fingerOf = (i: number, grow = 0, from = 0): Sdf => {
    const j = h.fingers[i]!, r = RADIUS[i]! + grow;
    const tip = add(j[3]!, mul(norm(sub(j[3]!, j[2]!)), -r * 0.62));
    const seg = [capsule(j[0]!, j[1]!, r, r * 0.93), capsule(j[1]!, j[2]!, r * 0.93, r * 0.85), capsule(j[2]!, tip, r * 0.85, r * 0.74)];
    return blend(3, ...seg.slice(from));
  };
  const fingers = union(...h.fingers.map((_, i) => fingerOf(i)));
  // The palm: a metacarpal to every knuckle from the heel of the hand, the heel, and the two pads.
  const meta = h.fingers.map((j, i) => capsule([j[0]![0] * 0.55, 0, 8], add(j[0]!, [0, -0.5, -4]), 15, RADIUS[i]! + 1.6));
  const palm = blend(13, ...meta, ellipsoid([0, -2, 20], [33, 16.5, 24]), ellipsoid([-25, -7, 36], [14, 12.5, 30]));
  // The thumb: a broad ball at its root, two short phalanges.
  const [cmc, mcp, ip, tip] = h.thumb;
  const end = add(tip, mul(norm(sub(tip, ip)), -7));
  const thumb = blend(5, capsule(mix(cmc, mcp, 0.25), mcp, 15.5, 13), capsule(mcp, ip, 12.8, 11.4), capsule(ip, end, 11.4, 9.6));
  const web = ellipsoid(mix([14, -6, 30], mcp, 0.35), [19, 13.5, 27]);
  // The wrist, along the hand's own axis: short, round at its end (the forearm's gauntlet takes over there).
  const back = frame([0, 0, 0], [0, 0, -1], [0, 1, 0]);
  const cuff = blend(10, at(back, profile([{ y: -22, rx: 33, rz: 17 }, { y: 0, rx: 30.5, rz: 19.5 }, { y: 14, rx: 30, rz: 20.5 }])), ellipsoid([0, 0, -12], [29.5, 20.5, 20]));
  const body = blend(9, blend(4, fingers, palm), thumb, web, cuff);
  // (A knit's texture: in the normals only.)
  const main = displaced(body, (x, y, z) => 0.15 * Math.sin(z * 2.6) * Math.sin(x * 2.6));

  // The suede palm: the palm side of the palm and of the thumb's root, a little proud of the knit.
  const suede = both(grown(blend(9, palm, web, capsule(mix(cmc, mcp, 0.25), mcp, 15.5, 13)), 1.1), (x, y, z) => Math.max(y + 3, 6 - z), 2);

  // The moulded parts: a knuckle bar, a pad on each finger's first phalanx, a panel on the back, the strap and its tab.
  const k0 = h.fingers[0]![0]!, k3 = h.fingers[3]![0]!;
  const lift = (p: V3, d: number): V3 => [p[0], p[1] + d, p[2]];
  const bar = blend(4, ...h.fingers.map((j, i) => ellipsoid(lift(add(j[0]!, [0, 0, -3]), RADIUS[i]! * 0.72), [RADIUS[i]! * 0.95, 4.6, 9.5])), capsule(lift(add(k0, [0, 0, -5]), 6.5), lift(add(k3, [0, 0, -5]), 5.5), 4.2));
  const pads = union(...h.fingers.map((j, i) => {
    const a = mix(j[0]!, j[1]!, 0.3), b = mix(j[0]!, j[1]!, 0.8);
    const along = norm(sub(j[1]!, j[0]!));
    const up = norm(sub([0, 1, 0], mul(along, along[1])));
    return both(capsule(add(a, mul(up, RADIUS[i]! * 0.5)), add(b, mul(up, RADIUS[i]! * 0.46)), RADIUS[i]! * 0.72), grown(fingerOf(i), 1.6), 0.8);
  }));
  const panel = both(grown(body, 1.8), box([2, 16, 44], [25, 14, 19], 7), 1.2);
  const strap = both(grown(cuff, 2.2), box([0, 0, -6], [60, 60, 7.5], 1.5), 1);
  const tab = both(grown(cuff, 4.2), box([8, 30, -6], [15, 30, 5.5], 2), 0.8);
  const shell = union(bar, pads, panel, strap, tab);
  return { body, main, suede, shell, cuff };
}

/**
 * Meshes a hand (and with `elbow` its forearm: the glove's gauntlet, the sleeve's cuff and the sleeve) into layers by
 * material: glove, glove_palm, glove_shell, sleeve, and hard / lens for a watch.
 */
export function sculptArm(h: HandShape, o: HandOptions, out: Layers = new Map()): Layers {
  const g = glove(h);
  const k = h.scale;
  const lo = toWorld(h.frame, [0, 0, 40 * k]);
  const pad = 150 * k;
  let min: V3 = [lo[0] - pad, lo[1] - pad, lo[2] - pad], max: V3 = [lo[0] + pad, lo[1] + pad, lo[2] + pad];
  const put = (mat: string, f: Sdf, cell: number, hidden?: Sdf[], bounds?: { min: V3; max: V3 }) => {
    if (!out.has(mat)) out.set(mat, { pos: [], nrm: [], idx: [] });
    mesh(f, { ...(bounds ?? { min, max }), cell, detail: Math.min(0.6, cell / 3), tolerance: o.tolerance ?? 0.15, hidden: hidden ? (x, y, z) => hidden.some((s) => s(x, y, z) < -0.6) : undefined }, out.get(mat)!);
  };
  const body = inHand(h, g.main), suede = inHand(h, g.suede), shell = inHand(h, g.shell);
  let arm: Sdf | null = null, sleeve: Sdf | null = null, band: Sdf | null = null, watch: Sdf | null = null, glass: Sdf | null = null;
  if (o.elbow) {
    // The forearm runs from the wrist to the elbow: the glove's gauntlet, then the sleeve with its folds.
    const L = len(sub(o.elbow, h.frame.o)) / k;
    const f: Frame = frame(h.frame.o, sub(o.elbow, h.frame.o), h.frame.y);
    const local = (a: Sdf): Sdf => at(f, (x, y, z) => a(x / k, y / k, z / k) * k);
    const gauntlet = profile([{ y: -14, rx: 29, rz: 19 }, { y: 8, rx: 30.5, rz: 21 }, { y: 40, rx: 33, rz: 25 }, { y: 74, rx: 35.5, rz: 28 }]);
    arm = local(blend(8, gauntlet, ellipsoid([0, 0, 0], [30, 24, 21])));
    const cloth = blend(6, profile([{ y: 56, rx: 37.5, rz: 31 }, { y: 66, rx: 39.5, rz: 33.5 }, { y: 86, rx: 38.5, rz: 32.5 }, { y: 150, rx: 45, rz: 40 }, { y: 240, rx: 54, rz: 49 }, { y: Math.max(260, L), rx: 60, rz: 56 }]), torus([0, 60, 0], [0, 1, 0], 33, 5));
    const creases = folds(1.7, 40, [0.2, 1, 0.1], h.side === "R" ? 1 : 2);
    sleeve = local(displaced(cloth, (x, y, z) => creases(x, y, z) * ramp(62, 100, y)));
    // The cuff's closing tab, on the back.
    band = local(both(grown(cloth, 2.2), box([4, 70, 40], [15, 7, 40], 2.5), 0.8));
    if (o.watch) {
      // A field watch over the gauntlet: the strap, the case, the glass.
      const face = frame([0, 30, 26.5], [0, 0, 1], [0, 1, 0]);
      watch = local(union(both(grown(gauntlet, 2), box([0, 30, 0], [80, 9, 80], 1.5), 1), at(face, cut(box([0, 0, 0], [18, 5, 16], 4.5), box([0, 6, 0], [14.5, 2.4, 12.5], 3.5), 0.6))));
      glass = local(at(face, box([0, 2.6, 0], [14.2, 1.4, 12.2], 3)));
    }
    for (const p of [h.frame.o, o.elbow]) for (let i = 0; i < 3; i++) { min[i] = Math.min(min[i]!, p[i]! - 70 * k); max[i] = Math.max(max[i]!, p[i]! + 70 * k); }
    min = [...min] as V3; max = [...max] as V3;
  }
  const solid = (s: Sdf | null): Sdf[] => (s ? [s] : []);
  put("glove", arm ? blend(6 * k, body, arm) : body, o.cell, [suede, shell, ...solid(sleeve)]);
  put("glove_palm", suede, o.cell * 1.15);
  put("glove_shell", shell, o.cell * 0.9, [body]);
  if (sleeve) put("sleeve", sleeve, o.cell * 2.2, [arm!]);
  if (band) put("glove_shell", band, o.cell * 1.2, [sleeve!]);
  if (watch) put("hard", watch, o.cell * 0.8, [arm!]);
  if (glass) put("lens", glass, o.cell * 0.8, [watch!]);
  return out;
}
