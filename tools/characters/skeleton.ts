// The bind pose: where every part's frame is when the parts' cloth is made one skinned body (millimetres, the feet at
// the origin, the soldier facing -Z). The arms are out from the sides and the legs a little apart, so no two limbs
// touch and run together; the cloth between (the armpit, the crotch) is what the joints share.
import { JOINTS, PARTS, RIG, SKELETON, type JointName, type PartName } from "../../src/character/rig.ts";
import { type Frame, type V3, IDENT, dot, sub, toWorld, turned } from "./sdf.ts";

/** How far the arms are out from the sides and the legs apart in the bind pose (degrees). */
export const BIND_ARMS = 38;
export const BIND_LEGS = 5;

const mm = (m: number) => m * 1000;

/** Every part's frame in the bind pose. (The hands' parts are in their weapon's space: they are not in it.) */
export function bindPose(): Record<Exclude<PartName, "hand_r" | "hand_l">, Frame> {
  const pelvis: Frame = { ...IDENT, o: [0, mm(RIG.hip), 0] };
  const chest: Frame = { ...IDENT, o: toWorld(pelvis, [0, mm(RIG.waist), 0]) };
  const head: Frame = { ...IDENT, o: toWorld(chest, [0, mm(RIG.neck), 0]) };
  const limbs = (side: 1 | -1) => {
    const upper = turned({ ...IDENT, o: toWorld(chest, [side * mm(RIG.shoulder[0]), mm(RIG.shoulder[1]), 0]) }, [0, 0, 1], side * BIND_ARMS);
    const fore = { ...upper, o: toWorld(upper, [0, -mm(RIG.upper), 0]) };
    const thigh = turned({ ...IDENT, o: toWorld(pelvis, [side * mm(RIG.hipJoint[0]), mm(RIG.hipJoint[1]), 0]) }, [0, 0, 1], side * BIND_LEGS);
    const shin = { ...thigh, o: toWorld(thigh, [0, -mm(RIG.thigh), 0]) };
    // (The boot stands flat.)
    const foot: Frame = { ...IDENT, o: toWorld(shin, [0, -mm(RIG.shin), 0]) };
    return { upper, fore, thigh, shin, foot };
  };
  const r = limbs(1), l = limbs(-1);
  return {
    pelvis, chest, head,
    upper_r: r.upper, upper_l: l.upper, fore_r: r.fore, fore_l: l.fore,
    thigh_r: r.thigh, thigh_l: l.thigh, shin_r: r.shin, shin_l: l.shin, foot_r: r.foot, foot_l: l.foot,
  };
}

/** A point given in the bind pose, in a frame's own space. */
export const toLocal = (f: Frame, p: V3): V3 => { const d = sub(p, f.o); return [dot(d, f.x), dot(d, f.y), dot(d, f.z)]; };

/** The skeleton's neighbours of each joint (its parent and its children). */
export function neighbours(): Record<JointName, JointName[]> {
  const n = Object.fromEntries(JOINTS.map((j) => [j, [] as JointName[]])) as Record<JointName, JointName[]>;
  for (const j of JOINTS) {
    const p = SKELETON[j];
    if (p) { n[j].push(p); n[p].push(j); }
  }
  return n;
}

/** The joints a part turns about or carries, in its own space: its origin and where its children's are. */
export function jointsOf(part: Exclude<PartName, "hand_r" | "hand_l">, bind = bindPose()): V3[] {
  const children = PARTS.filter((c) => c !== "hand_r" && c !== "hand_l" && parentOf(c) === part) as Exclude<PartName, "hand_r" | "hand_l">[];
  return [[0, 0, 0], ...children.map((c) => toLocal(bind[part], bind[c].o))];
}

/** A part's parent in the body (the feet hang from the shins, though only the cloth's joints are skinned). */
function parentOf(part: PartName): PartName | null {
  if (part === "foot_r") return "shin_r";
  if (part === "foot_l") return "shin_l";
  return (SKELETON as Record<string, PartName | null>)[part] ?? null;
}
