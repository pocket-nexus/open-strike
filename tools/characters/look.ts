// Pictures of the soldier to look at while it is sculpted (build.ts --look): the three outfits in the bind pose,
// front and back, the head, and a pose that bends every joint (shoulders, elbows, hips, knees, the waist, the neck)
// to see the cloth bend. The game's own poses are tools/shots.ts' studies.
import { JOINTS, OPERATOR_MODEL, bodyNode, partNode, type Outfit, type PartName } from "../../src/character/rig.ts";
import { quaternion } from "./gltf.ts";
import { type Frame, type V3, add, cross, dot, mul, norm, sub } from "./sdf.ts";
import { bindPose } from "./skeleton.ts";
import { type Item, studio } from "./studio.ts";

type Placed = Exclude<PartName, "hand_r" | "hand_l">;
/** Each part's parent in the bind pose's chain. */
const PARENT: Record<Placed, Placed | null> = {
  pelvis: null, chest: "pelvis", head: "chest", upper_r: "chest", upper_l: "chest", fore_r: "upper_r", fore_l: "upper_l",
  thigh_r: "pelvis", thigh_l: "pelvis", shin_r: "thigh_r", shin_l: "thigh_l", foot_r: "shin_r", foot_l: "shin_l",
};

/** `v` turned about `axis` by `deg`. */
const rot = (v: V3, axis: V3, deg: number): V3 => {
  const a = norm(axis), r = (deg * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
  return add(add(mul(v, c), mul(cross(a, v), s)), mul(a, dot(a, v) * (1 - c)));
};
const inFrame = (f: Frame, v: V3): V3 => add(add(mul(f.x, v[0]), mul(f.y, v[1])), mul(f.z, v[2]));

/** The parts' frames with each turned from the bind pose about an axis of its own (degrees), down the chain. */
export function posed(turns: Partial<Record<Placed, [V3, number]>>): Record<Placed, Frame> {
  const bind = bindPose();
  const out = {} as Record<Placed, Frame>;
  for (const p of Object.keys(PARENT) as Placed[]) {
    const parent = PARENT[p];
    // Relative to the parent in the bind pose, carried by the parent's pose.
    let f: Frame;
    if (!parent) f = { ...bind[p] };
    else {
      const pb = bind[parent], pp = out[parent];
      const local = (v: V3): V3 => [dot(v, pb.x), dot(v, pb.y), dot(v, pb.z)];
      const carry = (v: V3): V3 => inFrame(pp, local(v));
      f = { o: add(pp.o, carry(sub(bind[p].o, pb.o))), x: carry(bind[p].x), y: carry(bind[p].y), z: carry(bind[p].z) };
    }
    const t = turns[p];
    if (t) { const axis = inFrame(f, t[0]); f = { o: f.o, x: rot(f.x, axis, t[1]), y: rot(f.y, axis, t[1]), z: rot(f.z, axis, t[1]) }; }
    out[p] = f;
  }
  return out;
}

/** A soldier's models in a pose, at `at` (metres), turned `turn` (radians) about the vertical. */
export function figure(frames: Record<Placed, Frame>, outfit: Outfit, gear: PartName[], at: V3, turn = 0): Item[] {
  const c = Math.cos(turn), s = Math.sin(turn);
  const place = (p: V3): V3 => [at[0] + (p[0] * c + p[2] * s) / 1000, at[1] + p[1] / 1000, at[2] + (-p[0] * s + p[2] * c) / 1000];
  const spin = (v: V3): V3 => [v[0] * c + v[2] * s, v[1], -v[0] * s + v[2] * c];
  const world = (f: Frame): { o: V3; q: [number, number, number, number] } => ({ o: place(f.o), q: quaternion({ o: f.o, x: spin(f.x), y: spin(f.y), z: spin(f.z) }) });
  const nodes: Record<string, number[]> = {};
  for (const j of JOINTS) { const w = world(frames[j]); nodes[j] = [...w.o, ...w.q]; }
  const items: Item[] = [{ uri: OPERATOR_MODEL, nodes: [bodyNode(outfit)], animation: { nodes } }];
  for (const p of gear) {
    if (!(p in frames)) continue;
    const w = world(frames[p as Placed]);
    items.push({ uri: OPERATOR_MODEL, nodes: [partNode(p, outfit)], position: w.o, quaternion: w.q });
  }
  return items;
}

/** A pose that bends every joint: arms forward and bent, a lunge, the chest leaning and turned, the head down. */
export const BENT: Partial<Record<Placed, [V3, number]>> = {
  chest: [[1, 0, 0], -18], head: [[1, 0, 0], -25],
  upper_r: [[1, 0, 0], 70], fore_r: [[1, 0, 0], 95], upper_l: [[1, 0, 0], 40], fore_l: [[1, 0, 0], 120],
  thigh_r: [[1, 0, 0], 75], shin_r: [[1, 0, 0], -95], thigh_l: [[1, 0, 0], -20], shin_l: [[1, 0, 0], -40],
};

export async function look(gear: PartName[]): Promise<void> {
  const bind = posed({});
  const sun = { sun: [48, 150] as [number, number] };
  const front = { position: [0, 1.25, -3.6] as V3, target: [0, 0.98, 0] as V3, fov: 34 };
  await studio([...figure(bind, "ember", gear, [-0.85, 0, 0], 0.5), ...figure(bind, "azure", gear, [0, 0, 0]), ...figure(bind, "ranger", gear, [0.85, 0, 0], -0.5)], front, "out/studio/operator-front.png", sun);
  await studio([...figure(bind, "ember", gear, [-0.85, 0, 0], Math.PI + 0.5), ...figure(bind, "azure", gear, [0, 0, 0], Math.PI), ...figure(bind, "ranger", gear, [0.85, 0, 0], Math.PI / 2)], front, "out/studio/operator-back.png", sun);
  await studio(figure(bind, "azure", gear, [0, 0, 0], 0.35), { position: [0, 1.62, -0.95], target: [0, 1.55, 0], fov: 34 }, "out/studio/operator-head.png", sun);
  const bent = posed(BENT);
  await studio([...figure(bent, "ember", gear, [-0.5, 0.25, 0], 0.9), ...figure(bent, "azure", gear, [0.55, 0.25, 0], -0.6)], { position: [0, 1.45, -3.9], target: [0, 1.05, 0], fov: 36 }, "out/studio/operator-bent.png", sun);
  await studio(figure(bent, "ranger", gear, [0, 0.25, 0], Math.PI / 2), { position: [-0.3, 1.35, -2.6], target: [0, 1.0, 0], fov: 40 }, "out/studio/operator-bent-side.png", sun);
  console.log("out/studio/operator-front.png -back -head -bent -bent-side");
}

// (For a quick look without building: node tools/characters/look.ts)
if (import.meta.main) {
  const meta = (await import("../../src/character/meta.json", { with: { type: "json" } })).default as { gear: PartName[] };
  await look(meta.gear);
}
