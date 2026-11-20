// The soldier: a modern operator in a high-cut helmet with a headset and goggles over a balaclava, a combat shirt
// under a plate carrier with its pouches, a radio and a pack, a belt with a holster, combat trousers with knee pads,
// gloves and boots. Sculpted here as shapes (sdf.ts), one function for each part of the body.
//
// Every part is in its own space (src/character/rig.ts): millimetres, the origin at the joint the part turns about,
// +X the soldier's right, +Y up, +Z the back. A limb hangs down -Y. Where two parts meet both have a ball of cloth
// about the joint: the clothed body is all the parts' cloth made one (skeleton.ts puts the parts in the bind pose,
// skin.ts), so the balls become the shoulder, the elbow, the knee. The right limbs are sculpted; the left ones are
// their mirror images, except what only one side has.
//
// A part is a list of layers: a shape, the material it is made of, and how fine its triangles are. A layer marked
// `skin` is cloth that bends with the body (the skinned mesh); the rest is gear, rigid on its part. Layers may pass
// through each other (a pouch sits in the carrier, the carrier on the shirt): what ends up inside another layer is
// left out when the part is meshed.
import { RIG, type PartName } from "../../src/character/rig.ts";
import {
  type Frame, type Sdf, type V3, at, blend, both, box, capsule, cross, cut, cylinder, displaced, ellipsoid, flipped, folds, grown, half, mirrored, norm, placed, profile,
  ramp, sphere, torus, union,
} from "./sdf.ts";

export interface Layer { mat: string; shape: Sdf; /** Triangle size, when not the part's. */ cell?: number; /** Cloth of the skinned body. */ skin?: boolean }
export interface PartDef { /** Triangle size, millimetres. */ cell: number; min: V3; max: V3; layers: Layer[] }

const mm = (m: number) => Math.round(m * 1000);
/** Everything between two heights. */
const slab = (a: number, b: number): Sdf => (_x, y) => Math.max(a - y, y - b);
/** What of `base`, grown by `t`, lies in `region`: a panel, a strap or a plate that follows the body under it. */
const over = (base: Sdf, t: number, region: Sdf, k = 1.5): Sdf => both(grown(base, t), region, k);
/**
 * A frame on a body's girth (an ellipse rx by rz at height y), `deg` round from the front towards the right, `off`
 * out from it. In it -Z points out of the body, +Y up: a pouch is modelled as if on the chest.
 */
function mount(rx: number, rz: number, y: number, deg: number, off = 0): Frame {
  const a = (deg * Math.PI) / 180;
  const n = norm([Math.sin(a) / rx, 0, -Math.cos(a) / rz]);
  const z: V3 = [-n[0], 0, -n[2]];
  return { o: [rx * Math.sin(a) + n[0] * off, y, -rz * Math.cos(a) + n[2] * off], x: cross([0, 1, 0], z), y: [0, 1, 0], z };
}
/** Rows of webbing: a ladder of raised bands `pitch` apart (in the normals mostly). */
const webbing = (pitch: number, depth: number): Sdf => (_x, y) => depth * ramp(0.1, 0.5, Math.sin((y * 2 * Math.PI) / pitch));

// ---- the trunk ----

function pelvis(): PartDef {
  const hx = mm(RIG.hipJoint[0]), hy = mm(RIG.hipJoint[1]), w = mm(RIG.waist);
  const pants = profile([{ y: -100, rx: 118, rz: 92 }, { y: -60, rx: 168, rz: 114 }, { y: 0, rx: 172, rz: 119 }, { y: 55, rx: 158, rz: 110 }, { y: 95, rx: 150, rz: 104 }]);
  const body = blend(28, pants, ellipsoid([0, w, 0], [150, 80, 104]), mirrored(sphere([hx, hy, 0], 101)));
  const cloth = displaced(body, folds(1.5, 44, [0.85, 0.5, 0], 11));
  // The belt: a padded inner belt, the outer belt with its webbing, the buckle.
  const belt = union(over(pants, 5, slab(6, 76), 3), displaced(over(pants, 10, slab(16, 66), 3), (x, y, z) => 0.9 * ramp(0.6, 0.9, Math.sin(x * 0.17 + z * 0.17))));
  const buckle = union(box([0, 41, -128], [28, 17, 6], 4), box([0, 41, -133], [12, 11, 4], 2));
  const on = (deg: number, y = 41, off = 12) => mount(177, 126, y, deg, off);
  // On the belt: two pistol magazines front left, a rolled dump pouch and a medical pouch behind, a smoke grenade
  // behind the right hip, the holster on the right.
  const pistolMags = union(...[-30, -47].map((d) => at(on(d), box([0, -4, 0], [16, 36, 13], 5))));
  const magTops = union(...[-30, -47].map((d) => at(on(d), box([0, 36, 1], [11, 9, 7.5], 2))));
  const dump = at(on(-128, 20, 16), ellipsoid([0, -10, 0], [46, 34, 24]));
  const medical = at(on(180, 36, 20), blend(4, box([0, 0, 0], [60, 38, 22], 11), box([0, 30, -2], [60, 8, 22], 6)));
  const cross1 = at(on(180, 36, 43), union(box([0, 0, 0], [13, 4, 2.5], 1), box([0, 0, 0], [4, 13, 2.5], 1)));
  const smoke = at(on(133, 34, 26), union(cylinder([0, -40, 0], [0, 28, 0], 28, 8)));
  const smokeTop = at(on(133, 34, 26), union(cylinder([0, 26, 0], [0, 50, 0], 22, 5), cylinder([0, 48, 0], [0, 62, 0], 10, 3), capsule([10, 58, 0], [26, 20, 4], 3)));
  const holster = at(on(84, 0, 20), union(box([0, -52, 0], [20, 76, 34], 9), box([0, 30, 0], [9, 22, 26], 4)));
  const pistol = at(on(84, 0, 20), union(box([0, 34, 12], [15, 14, 30], 4), capsule([0, 44, 34], [0, 108, 58], 14, 13)));
  return {
    cell: 8, min: [-240, -150, -180], max: [260, 190, 190],
    layers: [
      { mat: "fabric", shape: cloth, skin: true },
      { mat: "nylon", shape: union(belt, pistolMags, dump, medical, smoke) },
      { mat: "hard", shape: union(buckle, holster, smokeTop), cell: 5 },
      { mat: "metal", shape: union(magTops, pistol), cell: 5 },
      { mat: "accent", shape: cross1, cell: 4 },
    ],
  };
}

function chest(): PartDef {
  const sx = mm(RIG.shoulder[0]), sy = mm(RIG.shoulder[1]);
  const shirt = profile([
    { y: -25, rx: 148, rz: 102 }, { y: 60, rx: 150, rz: 104 }, { y: 180, rx: 163, rz: 113, n: 2.3 }, { y: 300, rx: 176, rz: 122, n: 2.5 }, { y: 390, rx: 180, rz: 118, n: 2.5 },
    { y: 445, rx: 168, rz: 104, n: 2.2 }, { y: 485, rx: 118, rz: 84 }, { y: 515, rx: 72, rz: 68 },
  ]);
  const body = blend(30, shirt, ellipsoid([0, 0, 0], [148, 82, 102]), mirrored(sphere([sx, sy, 0], 64)), capsule([0, 470, 6], [0, 585, -4], 56, 54), mirrored(capsule([55, 505, 14], [152, 468, 6], 40, 36)));
  const cloth = blend(10, displaced(body, folds(1.3, 50, [0.3, 1, 0], 21)), torus([0, 500, 2], [0, 1, 0.05], 65, 12));
  const gaiter = displaced(blend(9, torus([0, 538, 0], [0, 1, 0], 57, 15), torus([0, 514, 2], [0.05, 1, 0], 62, 14)), folds(1.1, 15, [0.3, 1, 0.2], 7));

  // The plate carrier: a plate front and back (their top corners cut), the cummerbund, the shoulder straps.
  const plate = (z: number): Sdf => both(box([0, 238, z], [128, 166, 150], 24), mirrored(half([128, 332, 0], [1, 1, 0])), 6);
  const rows = webbing(27, 1.3);
  const carrier = union(
    over(shirt, 24, plate(-150), 6),
    displaced(over(shirt, 22, plate(150), 6), rows),
    displaced(over(shirt, 13, slab(72, 226), 5), rows),
  );
  const straps = over(body, 7, mirrored(box([92, 470, 0], [24, 112, 200], 5)), 2.5);
  const front = (deg: number, y: number, off: number) => mount(183, 134, y, deg, off);
  // Three rifle magazines in open pouches across the front, an admin pouch above them with the team's patch.
  const magPouches = union(...[-1, 0, 1].map((i) => at(front(i * 26, 140, 17), blend(3, box([0, 0, 0], [37, 60, 19], 6), box([0, -40, -3], [38, 18, 19], 6)))));
  const mags = union(...[-1, 0, 1].map((i) => at(front(i * 26, 140, 17), at(placed([0, 60, 0], -4, 0, i * 3), union(box([0, 4, 0], [30, 24, 10.5], 3), box([0, 30, 2], [26, 4, 7], 2))))));
  const pulls = union(...[-1, 0, 1].map((i) => at(front(i * 26, 140, 17), capsule([0, 44, -19], [0, 84, -12], 3.2))));
  const admin = at(mount(200, 146, 332, 0, 10), blend(3, box([0, 0, 0], [88, 46, 13], 7), box([0, 30, -2], [88, 14, 13], 5)));
  const patch = at(mount(200, 146, 332, 0, 24), box([-34, -6, 0], [40, 24, 2.5], 2));
  const flag = at(mount(200, 146, 332, 0, 24), box([46, -2, 0], [25, 15, 2], 1.5));
  const buckles = mirrored(at(placed([98, 398, -134], 12, 0, 0), union(box([0, 0, 0], [20, 13, 6], 3), box([0, 0, -5], [8, 8, 3], 1.5))));
  // The radio on the left side with its antenna, a pouch on the right, the push-to-talk on the left strap.
  const radio = at(front(-104, 196, 22), union(box([0, 0, 0], [27, 62, 20], 6), cylinder([-10, 58, 0], [-10, 80, 0], 9, 2), cylinder([12, 58, 0], [12, 72, 0], 7, 2)));
  const antenna = at(front(-104, 196, 22), union(capsule([-10, 78, 0], [-16, 320, 22], 5, 3.4), cylinder([-10, 76, 0], [-10, 100, 0], 7.5, 2)));
  const talk = at(placed([-98, 352, -136], 10, 0, 0), union(box([0, 0, 0], [16, 20, 9], 5), cylinder([0, 0, -8], [0, 0, -14], 8, 2)));
  const pouch = at(front(100, 150, 20), blend(4, box([0, 0, 0], [46, 54, 25], 14), box([0, 36, -2], [47, 12, 25], 8)));
  // On the back: a pack with a pocket and a grab handle, the hydration tube over the right shoulder.
  const back = mount(183, 134, 250, 180, 0);
  const pack = at(back, blend(6, box([0, 0, -38], [110, 150, 46], 32), box([0, -44, -86], [80, 76, 20], 16), displaced(box([0, 60, -80], [70, 34, 10], 8), webbing(24, 1.2))));
  const handle = at(back, blend(4, capsule([-34, 150, -22], [-22, 176, -26], 7), capsule([-22, 176, -26], [22, 176, -26], 7), capsule([22, 176, -26], [34, 150, -22], 7)));
  const backPatch = at(back, box([0, 62, -92], [46, 22, 2.5], 2));
  const tube = blend(8, capsule([66, 404, 158], [92, 498, 28], 6.5), capsule([92, 498, 28], [94, 470, -92], 6.5), capsule([94, 470, -92], [90, 380, -140], 6.5));
  return {
    cell: 8, min: [-290, -110, -230], max: [290, 640, 300],
    layers: [
      { mat: "fabric", shape: cloth, skin: true },
      { mat: "mask", shape: gaiter, cell: 5, skin: true },
      { mat: "nylon", shape: union(carrier, magPouches, admin, pouch, pack, handle) },
      { mat: "nylon", shape: straps, cell: 4 },
      { mat: "accent", shape: union(patch, backPatch), cell: 4 },
      { mat: "hard", shape: union(radio, talk, buckles, flag, pulls), cell: 4 },
      { mat: "metal", shape: mags, cell: 4 },
      { mat: "rubber", shape: union(antenna, tube), cell: 4 },
    ],
  };
}

function head(): PartDef {
  // The head under a balaclava: the skull, the jaw, the neck, a nose and a brow under the cloth.
  const skull = blend(30, ellipsoid([0, 138, -4], [77, 91, 97]), ellipsoid([0, 58, -30], [60, 58, 66]), capsule([0, -45, 10], [0, 62, 5], 54));
  const face = blend(15, skull, capsule([0, 98, -97], [0, 74, -109], 11, 14), capsule([-38, 130, -84], [38, 130, -84], 13));
  const balaclava = displaced(face, (x, y, z) => folds(1.0, 19, [0.25, 1, 0], 4)(x, y, z) * (1 - ramp(40, 80, y)));
  // Goggles: a frame that follows the face, the lens set into it, the strap round the head.
  const window = box([0, 113, -100], [61, 18, 80], 14);
  const frame = cut(over(face, 17, box([0, 113, -80], [77, 31, 60], 22), 6), window, 3);
  const lens = over(face, 12.5, box([0, 113, -80], [66, 23, 60], 16), 2);
  const strap = over(skull, 4.5, both(slab(101, 125), half([0, 0, 40], [0, 0, 1])), 2);

  // The helmet: a high-cut shell (clear of the ears, low at the back), rails on its sides, a mount on its brow, hook
  // panels on top, at the back and on the sides (the team's colour), a pouch at the back, a strobe.
  const dome = ellipsoid([0, 152, 6], [99, 97, 117]);
  const edge: Sdf = (_x, y, z) => 131 + 20 * ramp(-72, -36, z) - 56 * ramp(44, 86, z) - y;
  const shell = cut(both(dome, edge, 5), both(ellipsoid([0, 146, 6], [90, 89, 108]), (_x, y) => y - 150), 4);
  const liner = both(ellipsoid([0, 150, 6], [93, 91, 110]), (x, y, z) => Math.max(edge(x, y, z) + 4, 60 - Math.abs(x)), 3);
  const rails = displaced(over(dome, 6.5, mirrored(box([96, 159, 8], [30, 10.5, 56], 4)), 2), (_x, _y, z) => -1.4 * ramp(0.75, 0.95, Math.sin(z * 0.42)));
  const mountPlate = union(over(dome, 7, box([0, 198, -100], [23, 25, 60], 6), 2), over(dome, 13, box([0, 196, -100], [13, 14, 60], 4), 2));
  const panels = union(over(dome, 2.6, box([0, 250, 34], [36, 40, 44], 9), 1.2), over(dome, 2.6, box([0, 178, 130], [44, 22, 40], 7), 1.2), over(dome, 2.6, mirrored(box([100, 196, 4], [30, 15, 44], 6)), 1.2));
  const pouch = over(dome, 14, box([0, 136, 125], [40, 18, 40], 7), 3);
  const strobe = at(placed([28, 236, 62], -28, 0, -14), union(box([0, 4, 0], [14, 7, 20], 4), box([0, 12, 0], [9, 4, 13], 3)));
  // The headset: a cup over each ear hung from the rail, the microphone on the left.
  const cups = mirrored(union(at(placed([85, 96, 12], 0, 0, -8), box([0, 0, 0], [16, 35, 28], 12)), box([93, 136, 10], [4.5, 20, 7], 3)));
  const seals = mirrored(at(placed([74, 96, 12], 0, 0, -8), box([0, 0, 0], [8, 31, 24], 8)));
  const boom = union(capsule([-88, 76, -12], [-66, 50, -82], 4), ellipsoid([-60, 47, -90], [9, 8, 11]));
  const chin = union(mirrored(capsule([88, 134, -30], [50, 24, -66], 4.5)), mirrored(capsule([86, 132, 44], [54, 26, -50], 4)), blend(4, capsule([-36, 10, -74], [36, 10, -74], 8), ellipsoid([0, 8, -80], [24, 11, 10])));
  return {
    cell: 4, min: [-140, -90, -160], max: [140, 290, 170],
    layers: [
      { mat: "mask", shape: balaclava },
      { mat: "rubber", shape: union(frame, seals, boom) },
      { mat: "lens", shape: lens },
      { mat: "strap", shape: union(strap, chin) },
      { mat: "helmet", shape: shell },
      { mat: "hard", shape: union(liner, rails, mountPlate, strobe, cups), cell: 3.5 },
      { mat: "accent", shape: panels, cell: 3.5 },
      { mat: "nylon", shape: pouch },
    ],
  };
}

// ---- the limbs (the right ones) ----

function upperArm(): PartDef {
  const L = mm(RIG.upper);
  const arm = blend(22, sphere([0, 0, 0], 63), ellipsoid([8, -45, 0], [54, 88, 60]), profile([{ y: -L, rx: 47, rz: 49 }, { y: -200, rx: 52, rz: 55 }, { y: -90, rx: 56, rz: 60 }, { y: -10, rx: 57, rz: 61 }]), sphere([0, -L, 0], 48));
  const creases = folds(1.7, 38, [0.2, 1, 0.1], 31);
  const cloth = displaced(arm, (x, y, z) => creases(x, y, z) * ramp(-30, -90, y));
  // A pocket on the outside with the team's patch on its hook panel.
  const pocket = over(arm, 7, box([60, -150, 0], [40, 50, 36], 8), 3);
  const patch = over(arm, 9.6, box([60, -142, 0], [40, 30, 27], 4), 1.5);
  return { cell: 7, min: [-90, -L - 70, -90], max: [100, 90, 90], layers: [{ mat: "fabric", shape: blend(5, cloth, pocket), skin: true }, { mat: "accent", shape: patch, cell: 4 }] };
}

function forearm(): PartDef {
  const L = mm(RIG.fore);
  const arm = blend(16, sphere([0, 0, 0], 48), profile([{ y: -238, rx: 35, rz: 31 }, { y: -200, rx: 38, rz: 35 }, { y: -110, rx: 45, rz: 44 }, { y: -20, rx: 47, rz: 48 }]), torus([0, -230, 0], [0, 1, 0], 31, 6));
  const creases = folds(1.6, 34, [0.2, 1, 0.1], 33);
  const cloth = displaced(arm, (x, y, z) => creases(x, y, z) * ramp(-20, -60, y));
  // The wrist under the glove's cuff.
  const wrist = blend(6, capsule([0, -215, 0], [0, -L, 0], 31, 29), sphere([0, -L, 0], 31));
  // The elbow pad: a hard cap on a padded base, strapped below the elbow.
  const cap = displaced(ellipsoid([0, -10, 40], [38, 58, 22]), (_x, y) => -1.2 * ramp(0.8, 0.97, Math.sin(y * 0.3)));
  const base = union(over(arm, 5, box([0, -12, 34], [56, 76, 40], 20), 4), over(arm, 3.5, slab(-74, -54), 1.5));
  return { cell: 7, min: [-80, -L - 60, -80], max: [80, 80, 90], layers: [{ mat: "fabric", shape: cloth, skin: true }, { mat: "glove", shape: wrist }, { mat: "nylon", shape: base }, { mat: "hard", shape: cap, cell: 4.5 }] };
}

function thigh(): PartDef {
  const L = mm(RIG.thigh);
  const leg = blend(26, sphere([0, 0, 0], 100), profile([{ y: -L, rx: 66, rz: 72 }, { y: -330, rx: 74, rz: 82 }, { y: -180, rx: 90, rz: 98, cz: -5 }, { y: -50, rx: 98, rz: 104 }]), sphere([0, -L, 0], 68));
  const creases = folds(1.9, 50, [0.25, 1, 0], 41);
  const cloth = displaced(leg, (x, y, z) => creases(x, y, z) * (0.5 + 0.5 * ramp(-150, -40, y) + 0.5 * ramp(-330, -420, y)));
  // The cargo pocket on the outside, its flap.
  const cargo = blend(5, box([84, -238, 6], [16, 68, 54], 12), box([89, -180, 6], [14, 13, 57], 5));
  return { cell: 8, min: [-130, -L - 90, -130], max: [140, 120, 130], layers: [{ mat: "fabric", shape: blend(12, cloth, cargo), skin: true }] };
}

function shin(): PartDef {
  const L = mm(RIG.shin);
  // The trouser leg ends bloused over the boot, a hand above the ankle.
  const leg = blend(20, sphere([0, 0, 0], 67), profile([{ y: -300, rx: 56, rz: 60, cz: 4 }, { y: -160, rx: 64, rz: 72, cz: 12 }, { y: -30, rx: 66, rz: 70 }]), torus([0, -292, 3], [0, 1, 0], 47, 16));
  const creases = folds(1.9, 40, [0.2, 1, 0], 43);
  const cloth = displaced(leg, (x, y, z) => creases(x, y, z) * (0.4 + 0.8 * ramp(-180, -290, y)));
  // The knee pad: a ribbed hard cap on a padded base, strapped under the knee.
  const cap = displaced(ellipsoid([0, -8, -56], [54, 74, 30]), (_x, y) => -1.5 * ramp(0.8, 0.97, Math.sin(y * 0.24)));
  const base = union(over(leg, 6, box([0, -15, -46], [70, 94, 48], 24), 4), over(leg, 3.5, slab(-102, -80), 1.5));
  return { cell: 7, min: [-95, -L + 60, -115], max: [95, 95, 105], layers: [{ mat: "fabric", shape: cloth, skin: true }, { mat: "nylon", shape: base }, { mat: "hard", shape: cap, cell: 4.5 }] };
}

function foot(): PartDef {
  const g = -mm(RIG.ankle);
  // The boot: toe box, instep, heel and the shaft up the ankle; a sole with a heel; laces up the tongue.
  const upper = blend(16, ellipsoid([0, g + 35, -128], [46, 28, 66]), ellipsoid([0, g + 47, -40], [45, 40, 82]), ellipsoid([0, g + 45, 42], [42, 40, 46]), capsule([0, -10, 8], [0, 150, 4], 47, 51), sphere([0, 0, 0], 50));
  const leather = both(upper, half([0, g + 20, 0], [0, -1, 0]));
  const sole = cut(both((x, _y, z) => upper(x, g + 29, z) - 5, slab(g, g + 23), 4), box([0, g - 2, -18], [70, 9, 24], 5), 3);
  const lacing: [number, number][] = [[g + 57, -80], [g + 78, -64], [g + 102, -52], [g + 130, -47], [g + 160, -46], [g + 190, -47]];
  const laces = union(...lacing.map(([y, z]) => capsule([-17, y, z], [17, y, z], 3.4)), capsule([0, g + 57, -82], [0, g + 190, -50], 2.6));
  const collar = torus([0, 146, 4], [0, 1, 0], 44, 9);
  return {
    cell: 5, min: [-70, g - 12, -215], max: [70, 175, 105],
    layers: [{ mat: "boot", shape: blend(5, leather, collar) }, { mat: "rubber", shape: sole }, { mat: "hard", shape: laces, cell: 3.5 }],
  };
}

/** A part mirrored to the left side. */
const left = (p: PartDef): PartDef => ({ ...p, min: [-p.max[0], p.min[1], p.min[2]], max: [-p.min[0], p.max[1], p.max[2]], layers: p.layers.map((l) => ({ ...l, shape: flipped(l.shape) })) });

/** The sculpted parts of the body. The hands are made from a weapon's hand poses (hands.ts). */
export function operator(): Record<Exclude<PartName, "hand_r" | "hand_l">, PartDef> {
  return {
    pelvis: pelvis(), chest: chest(), head: head(),
    upper_r: upperArm(), upper_l: left(upperArm()), fore_r: forearm(), fore_l: left(forearm()),
    thigh_r: thigh(), thigh_l: left(thigh()), shin_r: shin(), shin_l: left(shin()), foot_r: foot(), foot_l: left(foot()),
  };
}
