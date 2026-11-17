// First-person arms: how a hand is posed on a weapon. The hand itself is sculpted by ../characters/hand.ts.
//
// A hand is posed in weapon space (millimetres) by its wrist, the direction to the knuckles, the back-of-hand direction,
// finger curls, and thumb joints; the forearm runs from the wrist to `elbow`. The same builder makes both hands (the
// left one mirrored). Hand space: x = towards the thumb, y = out of the back of the hand, z = wrist -> knuckles.
import { type Kit, type V3, add, cross, dot, len, mul, norm, rad, sub } from "./kit.ts";
import { type HandShape, sculptArm } from "../characters/hand.ts";

export interface FingerPose {
  /** Flexion at the knuckle, middle and end joints (degrees towards the palm). */
  curl: [number, number, number];
  /** Sideways angle at the knuckle (degrees towards the thumb side). */
  spread?: number;
}

export interface HandPose {
  side: "R" | "L";
  /** Wrist centre. */
  wrist: V3;
  /** Wrist -> knuckles. */
  fwd: V3;
  /** Out of the back of the hand (made perpendicular to fwd). */
  back: V3;
  /** Index, middle, ring, little finger. */
  fingers: [FingerPose, FingerPose, FingerPose, FingerPose];
  /** Thumb joints in weapon space: knuckle (MCP), end joint (IP), tip. */
  thumb: [V3, V3, V3];
  /** Where the forearm ends (beyond the frame). */
  elbow: V3;
  /** Scale of the hand (1 = a large gloved hand). */
  scale?: number;
  /** Cupping of the palm: the knuckle row folds towards the palm about the mid-palm crease (degrees). */
  cup?: number;
}

// Knuckle positions and phalanx lengths / radii (hand space, mm): index, middle, ring, little.
const KNUCKLE: V3[] = [[27, 0, 91], [9, 1.5, 95], [-9, 1, 91], [-26, -1.5, 83]];
const PHALANX: [number, number, number][] = [[43, 26, 22], [47, 29, 23], [44, 27, 22], [35, 21, 20]];
const RADIUS = [10.2, 10.4, 9.8, 8.9];
/** Where the thumb's metacarpal leaves the palm (hand space), and how far its knuckle can sit from there. */
export const THUMB_BASE: V3 = [26, -8, 22];
const THUMB_REACH = 50;

const CREASE = 48;
/** Folds a hand-space point beyond the palm crease towards the palm by `cup` degrees. */
function cupped(p: V3, cup: number): V3 {
  if (!cup || p[2] <= CREASE) return p;
  const c = Math.cos(rad(cup)), s = Math.sin(rad(cup));
  const y = p[1], z = p[2] - CREASE;
  return [p[0], y * c - z * s, CREASE + z * c + y * s];
}
/** Folds a direction the same way. */
function cuppedDir(d: V3, cup: number): V3 {
  if (!cup) return d;
  const c = Math.cos(rad(cup)), s = Math.sin(rad(cup));
  return [d[0], d[1] * c - d[2] * s, d[2] * c + d[1] * s];
}

/** The hand's frame: thumb side, back, forward. */
export function handFrame(p: HandPose): { s: V3; n: V3; f: V3 } {
  const f = norm(p.fwd);
  const n = norm(sub(p.back, mul(f, dot(p.back, f))));
  const s = p.side === "R" ? cross(n, f) : cross(f, n);
  return { s, n, f };
}

/** Weapon-space position of a point given in hand space. */
export function handPoint(p: HandPose, local: V3): V3 {
  const { s, n, f } = handFrame(p);
  const k = p.scale ?? 1;
  return add(p.wrist, add(add(mul(s, local[0] * k), mul(n, local[1] * k)), mul(f, local[2] * k)));
}

/** A pose whose middle-finger knuckle sits at `knuckle` (weapon space): the wrist follows from the frame. */
export function poseAt(knuckle: V3, p: Omit<HandPose, "wrist">): HandPose {
  const pose = { ...p, wrist: [0, 0, 0] as V3 };
  return { ...pose, wrist: sub(knuckle, handPoint(pose, cupped(KNUCKLE[1], p.cup ?? 0))) };
}

/** Finger joints in hand space: knuckle, middle joint, end joint, tip. */
export function fingerJoints(i: number, pose: FingerPose, cup = 0): V3[] {
  const sp = rad(pose.spread ?? 0);
  const dir = (deg: number): V3 => cuppedDir([Math.sin(sp) * Math.cos(rad(deg)), -Math.sin(rad(deg)), Math.cos(sp) * Math.cos(rad(deg))], cup);
  const pts: V3[] = [cupped(KNUCKLE[i], cup)];
  let a = 0;
  for (let j = 0; j < 3; j++) {
    a += pose.curl[j];
    pts.push(add(pts[j], mul(dir(a), PHALANX[i][j])));
  }
  return pts;
}

/** Where a pose puts the finger joints, in weapon space (for fitting a grip). */
export function describeHand(p: HandPose): string {
  const fmt = (v: V3) => `(${v.map((x) => x.toFixed(0)).join(", ")})`;
  const names = ["index", "middle", "ring", "little"];
  const lines = p.fingers.map((f, i) => `  ${names[i]}: ${fingerJoints(i, f, p.cup ?? 0).map((j) => fmt(handPoint(p, j))).join(" -> ")}`);
  const cmc = handPoint(p, THUMB_BASE);
  lines.push(`  thumb: ${fmt(cmc)} -> ${p.thumb.map(fmt).join(" -> ")}  lengths ${[cmc, ...p.thumb].slice(1).map((q, i) => len(sub(q, [cmc, ...p.thumb][i])).toFixed(0)).join(", ")}`);
  return lines.join("\n");
}

/** The pose as the sculptor wants it: the hand's frame and its joints in hand space. */
export function handShape(p: HandPose): HandShape {
  const { s, n, f } = handFrame(p);
  const sc = p.scale ?? 1, cup = p.cup ?? 0;
  const inv = (w: V3): V3 => {
    const d = sub(w, p.wrist);
    return [dot(d, s) / sc, dot(d, n) / sc, dot(d, f) / sc];
  };
  const [mcp, ip, tip] = p.thumb.map(inv) as [V3, V3, V3];
  return { side: p.side, frame: { o: p.wrist, x: s, y: n, z: f }, scale: sc, fingers: p.fingers.map((pose, i) => fingerJoints(i, pose, cup)), thumb: [THUMB_BASE, mcp, ip, tip] };
}

/** The first-person arm of a pose: the gloved hand and the sleeved forearm to `elbow` (sculpted: ../characters/hand.ts). */
export function arm(k: Kit, p: HandPose): void {
  if (!k.hi) return;
  const shape = handShape(p);
  const reach = len(sub(shape.thumb[1], THUMB_BASE));
  if (reach > THUMB_REACH) k.warnings.push(`hand ${p.side}: thumb knuckle ${reach.toFixed(0)} mm from the palm (max ${THUMB_REACH}): it will read as a hose`);
  const layers = sculptArm(shape, { cell: 3, elbow: p.elbow, watch: p.side === "L" });
  for (const [mat, buf] of layers) k.raw(p.side === "R" ? "arm_r" : "arm_l", mat, buf);
}

/**
 * Fits a support hand around a convex handguard section (xy outline at depth z): searches knuckle position, palm
 * elevation and finger curls so the fingers lie about one finger radius off the surface, the tips stay below `maxY`
 * (the rail), and the thumb's base stays within reach of `thumbAt` on the left face. Returns the pose (without thumb
 * joints and elbow) and its penalty; a high penalty means the section is too small or too large for the hand.
 */
export function fitSupport(outline: [number, number][], z: number, maxY: number, thumbAt: V3): { pose: Omit<HandPose, "thumb" | "elbow">; penalty: number; reach: number } {
  const cy = outline.reduce((a, p) => a + p[1], 0) / outline.length, cx = outline.reduce((a, p) => a + p[0], 0) / outline.length;
  const dist = (x: number, y: number): number => {
    let m = -Infinity;
    for (let i = 0; i < outline.length; i++) {
      const p = outline[i], q = outline[(i + 1) % outline.length];
      const ex = q[0] - p[0], ey = q[1] - p[1], l = Math.hypot(ex, ey) || 1;
      let nx = -ey / l, ny = ex / l;
      if (nx * (cx - p[0]) + ny * (cy - p[1]) > 0) (nx = -nx), (ny = -ny);
      m = Math.max(m, (x - p[0]) * nx + (y - p[1]) * ny);
    }
    return m;
  };
  const ys = outline.map((p) => p[1]), xs = outline.map((p) => p[0]);
  const bot = Math.min(...ys), x0 = Math.min(...xs), x1 = Math.max(...xs);
  let best: { pose: Omit<HandPose, "thumb" | "elbow">; penalty: number; reach: number } | null = null;
  for (const el of [0, 10, 20, 30, 40])
    for (let kx = x0; kx <= x1; kx += 3)
      for (let ky = bot - 16; ky <= bot - 6; ky += 2)
        for (let a = 0; a <= 60; a += 10)
          for (let b = 40; b <= 90; b += 10)
            for (let d = 10; d <= 40; d += 10) {
              const e = rad(el);
              const f: FingerPose = { curl: [a, b, d] };
              const base = { side: "L" as const, fwd: [Math.cos(e) * 0.88, Math.sin(e) * 0.88, -0.47] as V3, back: [-Math.sin(e), -Math.cos(e), 0] as V3, fingers: [f, f, f, f] as HandPose["fingers"] };
              const pose = poseAt([kx, ky, z], { ...base, thumb: [[0, 0, 0], [0, 0, 0], [0, 0, 0]], elbow: [0, 0, 0] });
              const w = fingerJoints(1, f).map((p) => handPoint(pose, p));
              let pen = 0;
              for (let j = 0; j < 3; j++)
                for (let t = 0; t <= 1; t += 0.25) {
                  const dd = dist(w[j][0] + (w[j + 1][0] - w[j][0]) * t, w[j][1] + (w[j + 1][1] - w[j][1]) * t);
                  pen += dd < 7 ? (7 - dd) * 5 : (dd - 10) ** 2 * 0.05;
                }
              if (w[3][1] > maxY) pen += (w[3][1] - maxY) * 8;
              pen += Math.abs(dist(w[0][0], w[0][1]) - 12) * 1.5;
              const reach = len(sub(handPoint(pose, THUMB_BASE), thumbAt));
              if (reach > 42) pen += (reach - 42) * 3;
              const heel = handPoint(pose, [0, -16, 30]);
              if (dist(heel[0], heel[1]) < 0) pen += -dist(heel[0], heel[1]) * 5;
              if (!best || pen < best.penalty) best = { pose: { ...base, wrist: pose.wrist }, penalty: pen, reach };
            }
  return best!;
}
