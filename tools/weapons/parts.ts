// Shared gun parts built with the kit: receiver shells with real ports, slotted handguards, optics, stocks.
// Millimetres, weapon space (+X right, +Y up, -Z forward; origin = the web of the firing hand at the top of the grip).
import { type Kit, type V2, type V3, basis, circle, mul, rect, roundRect } from "./kit.ts";
import type { HandPose } from "./arms.ts";

/** What build.ts writes to meta.json per weapon (millimetres here; metres in the file). */
export interface Meta {
  muzzle: V3;
  eject: V3;
  ejectDir: V3;
  eye: V3;
  gripL: V3;
  magOut: V3;
  boltTravel: number;
  /** The poses of the hands on it (the soldiers' hands in the world are made from the carbine's). */
  hands?: { right: HandPose; left: HandPose };
}

/**
 * A receiver from a side profile: a core and two side skins; the skins take real holes (ejection port, charging-handle
 * slot) with a dark liner behind, so the bolt shows through. `skinL` / `skinR`: the skins' thickness (the pocket depth).
 */
export function shell(k: Kit, outline: V2[], o: { hw: number; skinL?: number; skinR?: number; holesL?: V2[][]; holesR?: V2[][]; bevel?: number; liner?: string }): void {
  const b = o.bevel ?? 2;
  if (!k.hi) {
    k.extrude(outline, { from: -o.hw, to: o.hw });
    return;
  }
  const sl = o.skinL ?? 3, sr = o.skinR ?? 3;
  k.extrude(outline, { from: -o.hw, to: -o.hw + sl, bevel: [b, 0], holes: o.holesL });
  k.extrude(outline, { from: -o.hw + sl, to: o.hw - sr });
  k.extrude(outline, { from: o.hw - sr, to: o.hw, bevel: [0, b], holes: o.holesR });
  const liner = (holes: V2[][] | undefined, x: number) => {
    for (const h of holes ?? []) {
      const us = h.map((p) => p[0]), vs = h.map((p) => p[1]);
      k.box([x - 0.45, Math.min(...vs) - 1.2, Math.min(...us) - 1.2], [x + 0.45, Math.max(...vs) + 1.2, Math.max(...us) + 1.2]);
    }
  };
  const mat = k.material;
  k.mat(o.liner ?? "void");
  liner(o.holesL, -o.hw + sl);
  liner(o.holesR, o.hw - sr);
  k.mat(mat);
}

/**
 * An octagonal free-float handguard from z0 back to z1 forward: eight plates with M-LOK style slots through the side,
 * bottom and diagonal faces (the barrel shows through). The world model gets a plain prism.
 */
export function handguard(k: Kit, o: { z0: number; z1: number; hw: number; top: number; bot: number; c: number; wall?: number; margin?: number; topSlots?: boolean }): void {
  const { z0, z1, hw, top, bot, c } = o;
  const wall = o.wall ?? 2.6;
  const L = z0 - z1;
  const pts: V2[] = [[-hw + c, top], [hw - c, top], [hw, top - c], [hw, bot + c], [hw - c, bot], [-hw + c, bot], [-hw, bot + c], [-hw, top - c]];
  if (!k.hi) {
    k.extrude(pts, { plane: "xy", from: z1, to: z0 });
    return;
  }
  const cy = (top + bot) / 2;
  const pitch = 40;
  for (let i = 0; i < 8; i++) {
    const p = pts[i], q = pts[(i + 1) % 8];
    const w = Math.hypot(q[0] - p[0], q[1] - p[1]);
    const ey: V3 = [(q[0] - p[0]) / w, (q[1] - p[1]) / w, 0];
    let n: V3 = [-ey[1], ey[0], 0];
    if (n[0] * -(p[0] + q[0]) * 0.5 + n[1] * (cy - (p[1] + q[1]) * 0.5) < 0) n = mul(n, -1);
    const holes: V2[][] = [];
    const flat = i % 2 === 0;
    if (i !== 0 || o.topSlots) {
      const [sl, sw] = flat ? [32, Math.min(7, w - 6)] : [22, Math.min(6, w - 5)];
      const count = Math.floor((L - 2 * (o.margin ?? 14) - sl) / pitch) + 1;
      const start = (L - ((count - 1) * pitch + sl)) / 2;
      for (let s = 0; s < count; s++) {
        const u = start + s * pitch + (flat ? 0 : (sl - 22) / 2 + 5);
        if (sw > 2) holes.push(rect(u, u + sl, (w - sw) / 2, (w + sw) / 2, flat ? 1.6 : 0));
      }
    }
    k.at(basis([p[0], p[1], z0], [0, 0, -1], ey, n), () => k.extrude(rect(0, L, 0, w), { plane: "xy", from: 0, to: wall, holes }));
  }
}

/** A pin / button / screw head along x between x0 and x1. */
export function pinX(k: Kit, z: number, y: number, x0: number, x1: number, r: number, segs = 8, bevel = 0.5): void {
  if (!k.hi) return;
  k.cyl([x0, y, z], [x1, y, z], r, segs, { bevel, crease: 50 });
}

/**
 * Holographic sight (open hood, no glass): a clamp, a housing with rear buttons, and a window frame with side wings.
 * Sits on a rail whose top is `rail`, from zr (rear) to zr - 64. Returns the sight line's height.
 */
export function holoSight(k: Kit, zr: number, rail: number): number {
  const zf = zr - 64;
  const y0 = rail + 3;
  k.mat("anodized");
  // Rail clamp and its lever.
  k.box([-13, rail - 6.5, zf + 4], [13, rail + 4, zr - 4], 1.5);
  if (k.hi) {
    k.box([-17.5, rail - 5, zr - 40], [-12, rail + 2, zr - 14], 1.2);
    k.cyl([-17.6, rail - 1.5, zr - 20], [-19.5, rail - 1.5, zr - 20], 3.2, 8, { bevel: 0.6, crease: 50 });
  }
  // Housing (battery / electronics), lower at the back so the window stays clear.
  k.extrude([[zr, y0], [zr, y0 + 13], [zr - 3, y0 + 16], [zr - 33, y0 + 16], [zr - 36, y0 + 13.5], [zf, y0 + 13.5], [zf, y0]], { from: -16, to: 16, bevel: 2 });
  // Window frame: 30 x 24 opening.
  const wy0 = y0 + 13, wy1 = wy0 + 31;
  const frame = roundRect(-19.5, 19.5, wy0, wy1, 5, k.hi ? 2 : 1);
  k.extrude(frame, { plane: "xy", from: zf, to: zf + 26, bevel: 1.2, holes: [roundRect(-15, 15, wy0 + 3.5, wy1 - 3.5, 2.5, 1)] });
  // Hood wings sloping back to the housing.
  for (const s of [-1, 1]) {
    k.extrude([[zf + 25, wy1 - 2], [zf + 25, wy0 + 1], [zr - 6, wy0 + 1], [zr - 6, wy0 + 4]], { from: s * 15.5, to: s * 19.5, bevel: k.hi ? 0.8 : 0 });
  }
  if (k.hi) {
    // Rear buttons, battery cap, adjustment screws.
    k.mat("rubber");
    for (const x of [-8, 0, 8]) k.box([x - 3, y0 + 5, zr - 0.5], [x + 3, y0 + 10.5, zr + 1.2], 0.6);
    k.mat("gunmetal");
    k.cyl([16, y0 + 7, zf + 14], [20, y0 + 7, zf + 14], 5.5, 10, { bevel: 0.8, crease: 50 });
    k.cyl([16, y0 + 8, zr - 14], [18.5, y0 + 8, zr - 14], 3, 8, { bevel: 0.5, crease: 50 });
  }
  return (wy0 + wy1) / 2;
}

/**
 * Micro red dot (a short open tube on a riser mount). Rear of the tube at zr; returns the sight line's height.
 */
export function microDot(k: Kit, zr: number, rail: number, rise = 30): number {
  const cy = rail + rise;
  const zf = zr - 46;
  k.mat("anodized");
  // Mount: clamp, riser with a lightening cut, and saddle.
  k.box([-12.5, rail - 6.5, zf + 3], [12.5, rail + 4, zr - 3], 1.5);
  k.extrude([[zr - 5, rail + 3], [zr - 9, cy - 13], [zf + 9, cy - 13], [zf + 5, rail + 3]], { from: -9, to: 9, bevel: 1.5, holes: k.hi && rise > 26 ? [rect(zf + 15, zr - 15, rail + 7, cy - 17, 1.5)] : undefined });
  k.box([-14, cy - 15, zf + 4], [14, cy - 9, zr - 4], 1.5);
  // Tube with a bore: bezels front and rear.
  const R = 15.5, r = 12;
  k.lathe([[zr, r], [zr, R - 1], [zr - 1.5, R], [zr - 7, R], [zr - 8, R - 1.2], [zf + 8, R - 1.2], [zf + 7, R], [zf + 1.5, R], [zf, R - 1], [zf, r]], { at: [0, cy, 0], segs: k.segs(20, 10), closed: true });
  // Body under the tube (emitter housing) and turrets.
  k.box([-14, cy - 16, zf + 7], [14, cy - 12.6, zr - 7], 1);
  k.mat("gunmetal");
  k.cyl([0, cy + R - 2.5, (zr + zf) / 2], [0, cy + R + 4, (zr + zf) / 2], 5.5, k.segs(10, 6), { bevel: 0.8, crease: 50 });
  k.cyl([R - 2.5, cy, (zr + zf) / 2], [R + 4, cy, (zr + zf) / 2], 5.5, k.segs(10, 6), { bevel: 0.8, crease: 50 });
  if (k.hi) {
    k.cyl([-14, cy - 7, zr - 14], [-17, cy - 7, zr - 14], 4.5, 10, { bevel: 0.6, crease: 50 });
    k.box([-16.5, rail - 5, zr - 34], [-12, rail + 2, zr - 12], 1);
  }
  return cy;
}

/** A folded back-up sight lying on the rail (front or rear), its base at z0..z0-22. */
export function foldedSight(k: Kit, z0: number, rail: number, dir: 1 | -1 = 1): void {
  k.mat("gunmetal");
  k.box([-11.5, rail - 6, z0 - 22], [11.5, rail + 4.5, z0], 1.2);
  if (!k.hi) return;
  k.box([-6.5, rail + 4, dir > 0 ? z0 - 20 : z0 - 54], [6.5, rail + 9.5, dir > 0 ? z0 + 32 : z0 - 2], 1.5);
  k.cyl([-11.6, rail + 5, dir > 0 ? z0 - 16 : z0 - 6], [11.6, rail + 5, dir > 0 ? z0 - 16 : z0 - 6], 2.6, 8, { bevel: 0.4, crease: 50 });
}

/** A cartridge lying along -z with its base at `at` (case radius r, total length len). */
export function cartridge(k: Kit, at: V3, r: number, len: number, neck = 0.78, bullet = 0.3): void {
  const z = at[2];
  const caseLen = len * (1 - bullet);
  k.mat("brass");
  k.lathe([[z, r * 0.92], [z - 1, r], [z - caseLen * 0.82, r], [z - caseLen * 0.9, r * neck], [z - caseLen, r * neck]], { at, segs: k.segs(10, 6), crease: 40 });
  k.mat("copper");
  k.lathe([[z - caseLen + 0.3, r * neck * 0.97], [z - caseLen - len * bullet * 0.45, r * neck * 0.8], [z - caseLen - len * bullet * 0.85, r * neck * 0.4], [z - len, 0]], { at, segs: k.segs(10, 6), crease: 60 });
}

/** Fake ports / grooves around a cylinder along z: thin dark pads tangent to radius r at `angles` (degrees from +x). */
export function ports(k: Kit, cx: number, cy: number, r: number, z0: number, z1: number, width: number, angles: number[], mat = "void"): void {
  if (!k.hi) return;
  k.mat(mat);
  for (const a of angles) {
    const c = Math.cos((a * Math.PI) / 180), s = Math.sin((a * Math.PI) / 180);
    k.at(basis([cx, cy, 0], [c, s, 0], [-s, c, 0], [0, 0, 1]), () => k.box([r - 1.5, -width / 2, Math.min(z0, z1)], [r + 0.25, width / 2, Math.max(z0, z1)], 0.2, { plane: "xy" }));
  }
}

/** AR-style buffer tube with castle nut, along z from z0 to z1 at height y. */
export function bufferTube(k: Kit, z0: number, z1: number, y: number): void {
  k.mat("anodized");
  k.lathe([[z0 - 2, 18.5], [z0 + 5, 18.5], [z0 + 5, 16.5], [z0 + 11, 16.5], [z0 + 11, 14.6], [z1 - 1, 14.6], [z1, 13.6]], { at: [0, y, 0], segs: k.segs(18, 8) });
}

/** AR-pattern pistol grip (top-rear at the origin: the web of the hand) with rubber side panels. */
export function arGrip(k: Kit, mat = "polymer"): void {
  k.mat(mat);
  const grip: V2[] = [[15, 2], [16.5, -8], [23, -32], [33, -70], [39, -93], [36, -98], [-10, -102], [-13.5, -98], [-18, -78], [-23.5, -52], [-30, -30], [-37.5, -24], [-38, -3]];
  k.extrude(grip, { from: -14.2, to: 14.2, bevel: 5, round: k.hi ? 3 : 1, crease: 42 });
  if (k.hi) {
    k.mat("rubber");
    k.extrude([[14, -14], [21, -40], [29, -70], [33, -88], [-9, -92], [-14, -76], [-19, -52], [-24, -34], [-20, -20]], { from: -15, to: 15, bevel: 1.2 });
  }
}

/** Trigger guard and trigger of an AR-pattern lower (guard from the grip at z = -38 to `front`). */
export function arTrigger(k: Kit, front = -97): void {
  k.mat("polymer");
  k.extrude([[front, -29], [-38, -26.5], [-38, -31], [front, -34]], { from: -7, to: 7, bevel: 1 });
  k.mat("gunmetal");
  k.extrude([[-64, -3], [-56.5, -3], [-58, -12], [-61, -20], [-64.5, -23.5], [-66.5, -22], [-64.5, -13]], { from: -3.2, to: 3.2, bevel: 0.9 });
}

/**
 * Magnified scope without glass: a fat tube whose bore widens forwards (so the far rim, not the tube wall, bounds the
 * view from the eye), ocular at zr, 220 long, on a one-piece mount. Returns the sight line's height.
 */
export function scope(k: Kit, zr: number, rail: number, rise = 49): number {
  const cy = rail + rise;
  const zf = zr - 220;
  const seg = k.segs(18, 8);
  k.mat("anodized");
  k.lathe([[zr, 18], [zr, 24.5], [zr - 3, 25.5], [zr - 12, 25.5], [zr - 14, 24.5], [zr - 48, 24.5], [zr - 54, 23.5], [zr - 150, 23.5], [zr - 168, 30], [zf + 4, 30], [zf, 29], [zf, 22]], { at: [0, cy, 0], segs: seg, closed: true });
  // Turret saddle and turrets (elevation, windage, parallax).
  // (a block around the tube: the bore runs through it)
  k.extrude(rect(-25, 25, cy - 25, cy + 25, 9), { plane: "xy", from: zr - 114, to: zr - 86, bevel: 1.5, holes: [circle(0, cy, 23, seg)] });
  k.mat("gunmetal");
  const ts = k.segs(12, 6);
  k.cyl([0, cy + 22, zr - 100], [0, cy + 40, zr - 100], 11, ts, { bevel: 1.5, crease: 50 });
  k.cyl([24, cy, zr - 100], [40, cy, zr - 100], 11, ts, { bevel: 1.5, crease: 50 });
  k.cyl([-24, cy, zr - 100], [-34, cy, zr - 100], 12.5, ts, { bevel: 1.5, crease: 50 });
  // Mount: rail clamp, two pillars and rings.
  k.mat("anodized");
  k.box([-13, rail - 6.5, zr - 150], [13, rail + 5, zr - 52], 1.5);
  for (const z of [zr - 66, zr - 136]) {
    k.box([-9, rail + 4, z - 8], [9, cy - 22.5, z + 8], 1.2);
    k.lathe([[z + 8, 23.4], [z + 8, 28], [z - 8, 28], [z - 8, 23.4]], { at: [0, cy, 0], segs: seg, closed: true });
    if (k.hi) for (const s of [-1, 1]) k.cyl([s * 22, cy + 16, z], [s * 22, cy + 21, z], 2.6, 6, { crease: 50 });
  }
  if (k.hi) {
    k.mat("rubber");
    k.lathe([[zr + 6, 20.5], [zr + 6, 24.6], [zr - 1, 26], [zr - 1, 20.5]], { at: [0, cy, 0], segs: seg, closed: true });
  }
  return cy;
}

/** The firing hand on an AR-pattern grip (arGrip): index on the trigger, thumb forward along the lower receiver. */
export const RIFLE_GRIP_HAND = {
  side: "R" as const,
  wrist: [1, -26, 62] as V3,
  fwd: [0.259, -0.2415, -0.935] as V3,
  back: [1, 0, 0.2] as V3,
  fingers: [{ curl: [10, 62, 45], spread: 22 }, { curl: [80, 80, 25] }, { curl: [80, 82, 25] }, { curl: [82, 82, 25] }] as [{ curl: [number, number, number]; spread?: number }, { curl: [number, number, number] }, { curl: [number, number, number] }, { curl: [number, number, number] }],
  thumb: [[-16, -8, 8], [-22, -9, -18], [-21, -11, -42]] as [V3, V3, V3],
  elbow: [120, -170, 290] as V3,
};

export { circle };
