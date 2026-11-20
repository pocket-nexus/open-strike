// A body gone limp: the soldier's skeleton as points (Verlet integration, constraints projected a few times a step),
// started from the pose it had when it died, moving as it moved, struck by the shot that killed it. The pelvis and
// the chest are rigid, joined at the waist; the head, the arms, the legs and the feet hang from them with the limits
// a body has (knees and elbows bend one way and not all the way, the neck, the spine and the hips only so far), so
// it folds at the knees, twists at the waist and lands on its side or its back, never through itself the way no
// body can. The weapon leaves the hands and falls on its own. The map is felt through rays (`Cast`), one a point a
// frame; once the body lies still it is left alone (nothing is posed, nothing is skinned again).
//
// Plain numbers and a cast function: no engine in here (src/soldiers.ts turns the points into the parts' frames).
import { RIG } from "./character/rig.ts";
import { add, cross, dot, len, mad, norm, scale, sub, type V3 } from "./vec.ts";

/** The points, by name. */
export const P = {
  hipL: 0, hipR: 1, waist: 2, neck: 3, shoulderL: 4, shoulderR: 5, head: 6, elbowL: 7, elbowR: 8, wristL: 9, wristR: 10,
  kneeL: 11, kneeR: 12, ankleL: 13, ankleR: 14, toeL: 15, toeR: 16, grip: 17, muzzle: 18,
} as const;
export const POINTS = Object.keys(P).length;

/** What a ray from `from` to `to` meets first in the map, or null. */
export type Cast = (from: V3, to: V3) => { point: V3; normal: V3 } | null;

/** The shot that killed: where it came from (a point), where it struck, how hard (m/s given to what it struck). */
export interface Blow { from: V3 | null; zone: string; push: number }

/** Each point: its mass (relative) and its radius (m: how far it keeps from the map). */
const MASS = [3, 3, 3, 1.2, 1.6, 1.6, 1.5, 0.8, 0.8, 0.5, 0.5, 1.6, 1.6, 1, 1, 0.5, 0.5, 1.2, 1.2];
const RADIUS = [0.1, 0.1, 0.11, 0.07, 0.08, 0.08, 0.12, 0.06, 0.06, 0.05, 0.05, 0.07, 0.07, 0.06, 0.06, 0.04, 0.04, 0.04, 0.03];
const GRAVITY = 9.8;
const STEP = 1 / 120;
/** Of the velocity kept each step (air), and along the ground when a point touches it. */
const DAMP = 0.996, FRICTION = 0.8;
/** No point moves faster (m/s): projecting a limit moves points, and in Verlet a move is a velocity. */
const FASTEST = 8;
/** Of an angle's excess taken out at each pass (angles are corrected softly, over the passes, or they kick). */
const SOFT = 0.35;
/** How far above a point its ray starts (m). */
const LOOK_UP = 0.25;
/** Passes over the constraints a step. */
const PASSES = 4;

interface Rod { a: number; b: number; min: number; max: number }
/** A hinge: `end` turns about `mid` one way only, about an axis carried by a rigid group (`frame`), at most `max`. */
interface Hinge { root: number; mid: number; end: number; axis: V3; frame: "pelvis" | "chest"; max: number }
/** A cone: the direction `a`→`b` stays within `max` (radians) of an axis carried by a rigid group. */
interface Cone { a: number; b: number; axis: V3; frame: "pelvis" | "chest"; max: number }
/** Where a point touched the map this frame (a plane). */
interface Contact { point: V3; normal: V3 }

/** A rigid group's frame from its points: right (x), up (y) and back (z = x × y). */
function groupFrame(p: V3[], g: "pelvis" | "chest"): { x: V3; y: V3; z: V3 } {
  const [l, r, base, top] = g === "pelvis" ? [P.hipL, P.hipR, -1, P.waist] : [P.shoulderL, P.shoulderR, P.waist, P.neck];
  const x = norm(sub(p[r]!, p[l]!));
  const from = base < 0 ? scale(add(p[l]!, p[r]!), 0.5) : p[base]!;
  let y = sub(p[top]!, from);
  y = norm(sub(y, scale(x, dot(y, x))));
  return { x, y, z: cross(x, y) };
}
const inFrame = (f: { x: V3; y: V3; z: V3 }, v: V3): V3 => add(add(scale(f.x, v[0]), scale(f.y, v[1])), scale(f.z, v[2]));
const ofFrame = (f: { x: V3; y: V3; z: V3 }, v: V3): V3 => [dot(v, f.x), dot(v, f.y), dot(v, f.z)];
/** `v` turned about the unit `axis` by `a` radians. */
const turn = (v: V3, axis: V3, a: number): V3 => add(add(scale(v, Math.cos(a)), scale(cross(axis, v), Math.sin(a))), scale(axis, dot(axis, v) * (1 - Math.cos(a))));

export class Ragdoll {
  readonly p: V3[];
  private prev: V3[];
  private readonly rods: Rod[] = [];
  private readonly hinges: Hinge[] = [];
  private readonly cones: Cone[] = [];
  private readonly contacts: (Contact | null)[] = new Array(POINTS).fill(null);
  private still = 0;
  private left = 0;
  /** It lies still: posing it again would change nothing. */
  asleep = false;

  /**
   * From the points of the last pose (`now`), those of the frame before (`before`, `dt` seconds earlier: how it was
   * moving), and the blow.
   */
  constructor(now: V3[], before: V3[] | null, dt: number, blow: Blow | null) {
    this.p = now.map((v) => [...v] as V3);
    // (Moving as it was, no faster than a sprint; the step's displacement.)
    this.prev = now.map((v, i) => {
      let vel: V3 = before && dt > 0 ? scale(sub(v, before[i]!), 1 / dt) : [0, 0, 0];
      const s = len(vel);
      if (s > 7) vel = scale(vel, 7 / s);
      return sub(v, scale(vel, STEP));
    });
    const rod = (a: number, b: number, slack = 0, give = 0) => {
      const d = len(sub(now[a]!, now[b]!));
      this.rods.push({ a, b, min: d * (1 - give), max: d * (1 + slack) });
    };
    // The pelvis and the chest are rigid; the waist is the joint between them. The spine bends and twists only so
    // far: the shoulders keep near their distances to the hips.
    rod(P.hipL, P.hipR); rod(P.hipL, P.waist); rod(P.hipR, P.waist);
    for (const [a, b] of [[P.waist, P.neck], [P.waist, P.shoulderL], [P.waist, P.shoulderR], [P.neck, P.shoulderL], [P.neck, P.shoulderR], [P.shoulderL, P.shoulderR]] as const) rod(a, b);
    for (const [a, b] of [[P.shoulderL, P.hipR], [P.shoulderR, P.hipL], [P.shoulderL, P.hipL], [P.shoulderR, P.hipR]] as const) rod(a, b, 0.08, 0.14);
    rod(P.neck, P.head);
    // The limbs: bones, a foot, the weapon.
    for (const [a, b] of [[P.shoulderL, P.elbowL], [P.elbowL, P.wristL], [P.shoulderR, P.elbowR], [P.elbowR, P.wristR], [P.hipL, P.kneeL], [P.kneeL, P.ankleL], [P.hipR, P.kneeR], [P.kneeR, P.ankleR], [P.ankleL, P.toeL], [P.ankleR, P.toeR], [P.grip, P.muzzle]] as const) rod(a, b);
    // The foot stays near square to the shin.
    const footRod = (knee: number, toe: number) => {
      const s = RIG.shin, f = len(sub(now[toe]!, now[knee === P.kneeL ? P.ankleL : P.ankleR]!));
      const at = (deg: number) => Math.sqrt(s * s + f * f - 2 * s * f * Math.cos((deg * Math.PI) / 180));
      this.rods.push({ a: knee, b: toe, min: at(65), max: at(125) });
    };
    footRod(P.kneeL, P.toeL); footRod(P.kneeR, P.toeR);
    // Knees and elbows: one way, not all the way. The axis is the one they were bending about (when they were bent
    // enough to tell), else the body's own: an elbow bends forward, a knee backward.
    const pelvis = groupFrame(now, "pelvis"), chest = groupFrame(now, "chest");
    const hinge = (root: number, mid: number, end: number, frame: "pelvis" | "chest", fallback: V3, max: number) => {
      const bend = cross(sub(now[mid]!, now[root]!), sub(now[end]!, now[mid]!));
      const f = frame === "pelvis" ? pelvis : chest;
      const axis = len(bend) > 0.02 ? ofFrame(f, norm(bend)) : fallback;
      this.hinges.push({ root, mid, end, axis, frame, max });
    };
    hinge(P.shoulderL, P.elbowL, P.wristL, "chest", [1, 0, 0], 2.5);
    hinge(P.shoulderR, P.elbowR, P.wristR, "chest", [1, 0, 0], 2.5);
    hinge(P.hipL, P.kneeL, P.ankleL, "pelvis", [-1, 0, 0], 2.4);
    hinge(P.hipR, P.kneeR, P.ankleR, "pelvis", [-1, 0, 0], 2.4);
    // The head on the neck; the thighs from the hips (forward more than back); the spine, the chest on the pelvis.
    this.cones.push({ a: P.neck, b: P.head, axis: [0, 1, -0.15], frame: "chest", max: 0.85 });
    for (const [a, b] of [[P.hipL, P.kneeL], [P.hipR, P.kneeR]] as const) this.cones.push({ a, b, axis: norm([0, -1, -0.75]), frame: "pelvis", max: 1.45 });
    this.cones.push({ a: P.waist, b: P.neck, axis: [0, 1, 0], frame: "pelvis", max: 0.7 });

    if (blow) this.strike(blow);
  }

  /** The killing shot: what it struck is knocked away from the shooter (and a little up), the rest of the body less. */
  strike(blow: Blow): void {
    const centre = this.p[P.waist]!;
    let dir: V3 = blow.from ? sub(centre, blow.from) : groupFrame(this.p, "chest").z;
    dir = norm([dir[0], 0, dir[2]]);
    dir = norm(add(dir, [0, 0.1, 0]));
    const struck: number[] = blow.zone === "head" ? [P.head, P.neck] : blow.zone === "limb" ? [P.kneeL, P.kneeR, P.hipL, P.hipR] : [P.shoulderL, P.shoulderR, P.neck, P.waist];
    for (let i = 0; i < P.grip; i++) {
      const k = struck.includes(i) ? 1 : 0.15;
      this.prev[i] = sub(this.prev[i]!, scale(dir, blow.push * k * STEP));
    }
    this.asleep = false;
    this.still = 0;
  }

  /** How long it has been limp (s). */
  age = 0;

  /** The axis a knee or an elbow bends about (world, across its upper bone): 0 elbowL, 1 elbowR, 2 kneeL, 3 kneeR. */
  hingeAxis(i: number): V3 {
    const h = this.hinges[i]!;
    const u = norm(sub(this.p[h.mid]!, this.p[h.root]!));
    const a = inFrame(groupFrame(this.p, h.frame), h.axis);
    return norm(sub(a, scale(u, dot(a, u))));
  }

  /** The frame of the pelvis or of the chest. */
  frame(g: "pelvis" | "chest"): { x: V3; y: V3; z: V3 } {
    return groupFrame(this.p, g);
  }

  /** Runs the body on by `dt` seconds. */
  step(dt: number, cast: Cast): void {
    this.age += dt;
    if (this.asleep) return;
    const start = this.p.map((v) => [...v] as V3);
    this.left = Math.min(this.left + dt, 0.1);
    while (this.left >= STEP) {
      this.left -= STEP;
      this.integrate();
      for (let k = 0; k < PASSES; k++) this.constrain();
    }
    // The map: a ray a point a frame, along its way this frame and down by its radius (from a little above where it
    // was: a point a hair under the floor still finds it). What it meets is the plane the point keeps out of, until
    // the next frame's ray (a plane is only good near where it was found: a crate's top is not the floor beside it).
    // (A point that has not moved keeps the plane it rests on: no ray.)
    for (let i = 0; i < POINTS; i++) {
      const from = start[i]!, to = this.p[i]!, r = RADIUS[i]!;
      const way = sub(to, from), l = len(way);
      if (l < 0.002 && this.contacts[i]) continue;
      const end = sub(l > 1e-6 ? mad(to, way, (0.5 * r) / l) : to, [0, r + 0.005, 0]);
      this.contacts[i] = cast(add(from, [0, LOOK_UP, 0]), end);
    }
    for (let k = 0; k < 3; k++) { this.collide(); this.constrain(); }
    this.collide();
    // Still for half a second: asleep.
    let moved = 0;
    for (let i = 0; i < POINTS; i++) moved = Math.max(moved, len(sub(this.p[i]!, start[i]!)));
    this.still = moved < 0.0015 ? this.still + dt : 0;
    if (this.still > 0.5) this.asleep = true;
  }

  // (The steps below run a few hundred times a frame: they change the points in place and make no arrays.)

  private integrate(): void {
    const fall = GRAVITY * STEP * STEP, fastest = FASTEST * STEP;
    for (let i = 0; i < POINTS; i++) {
      const p = this.p[i]!, q = this.prev[i]!;
      let vx = (p[0] - q[0]) * DAMP, vy = (p[1] - q[1]) * DAMP, vz = (p[2] - q[2]) * DAMP;
      const l = Math.sqrt(vx * vx + vy * vy + vz * vz);
      if (l > fastest) { const k = fastest / l; vx *= k; vy *= k; vz *= k; }
      q[0] = p[0]; q[1] = p[1]; q[2] = p[2];
      p[0] += vx; p[1] += vy - fall; p[2] += vz;
    }
    this.collide();
  }

  /** Points out of the planes they touch; what slides along one is slowed. */
  private collide(): void {
    for (let i = 0; i < POINTS; i++) {
      const c = this.contacts[i];
      if (!c) continue;
      const p = this.p[i]!, q = this.prev[i]!, n = c.normal, o = c.point;
      const d = (p[0] - o[0]) * n[0] + (p[1] - o[1]) * n[1] + (p[2] - o[2]) * n[2] - RADIUS[i]!;
      if (d >= 0) continue;
      p[0] -= n[0] * d; p[1] -= n[1] * d; p[2] -= n[2] * d;
      // (Friction: of the motion this step, what runs along the plane is cut; what goes into it is gone.)
      const vx = p[0] - q[0], vy = p[1] - q[1], vz = p[2] - q[2];
      const vn = vx * n[0] + vy * n[1] + vz * n[2], keep = 1 - FRICTION, out = Math.max(0, vn);
      q[0] = p[0] - ((vx - n[0] * vn) * keep + n[0] * out);
      q[1] = p[1] - ((vy - n[1] * vn) * keep + n[1] * out);
      q[2] = p[2] - ((vz - n[2] * vn) * keep + n[2] * out);
    }
  }

  private constrain(): void {
    const p = this.p;
    for (const r of this.rods) {
      const a = p[r.a]!, b = p[r.b]!;
      const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
      const l = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (l < 1e-6) continue;
      const want = l < r.min ? r.min : l > r.max ? r.max : l;
      if (want === l) continue;
      const wa = 1 / MASS[r.a]!, wb = 1 / MASS[r.b]!, k = (l - want) / (l * (wa + wb));
      a[0] += dx * k * wa; a[1] += dy * k * wa; a[2] += dz * k * wa;
      b[0] -= dx * k * wb; b[1] -= dy * k * wb; b[2] -= dz * k * wb;
    }
    const frames = { pelvis: groupFrame(p, "pelvis"), chest: groupFrame(p, "chest") };
    for (const h of this.hinges) {
      const u = sub(p[h.mid]!, p[h.root]!), v = sub(p[h.end]!, p[h.mid]!);
      const lu = len(u), lv = len(v);
      if (lu < 1e-6 || lv < 1e-6) continue;
      let axis = inFrame(frames[h.frame], h.axis);
      axis = norm(sub(axis, scale(u, dot(axis, u) / (lu * lu))));
      // The angle it is bent by, signed about the axis; held between straight and `max`.
      const un = scale(u, 1 / lu), vn = scale(v, 1 / lv);
      const a = Math.atan2(dot(cross(un, vn), axis), dot(un, vn));
      const want = Math.max(0, Math.min(h.max, a));
      if (want !== a) {
        const nv = turn(vn, axis, (want - a) * SOFT);
        p[h.end] = mad(p[h.mid]!, nv, lv);
      }
    }
    for (const c of this.cones) {
      const d = sub(p[c.b]!, p[c.a]!), l = len(d);
      if (l < 1e-6) continue;
      const axis = norm(inFrame(frames[c.frame], c.axis)), dn = scale(d, 1 / l);
      const a = Math.acos(Math.max(-1, Math.min(1, dot(dn, axis))));
      if (a <= c.max) continue;
      const about = cross(axis, dn);
      if (len(about) < 1e-6) continue;
      const nd = turn(dn, norm(about), (c.max - a) * SOFT);
      // (The spine's cone turns the whole chest about the waist; the others move the far point.)
      if (c.b === P.neck) {
        const rot = (q: V3) => add(p[c.a]!, turn(sub(q, p[c.a]!), norm(about), (c.max - a) * SOFT));
        for (const i of [P.neck, P.shoulderL, P.shoulderR, P.head]) p[i] = rot(p[i]!);
      } else p[c.b] = mad(p[c.a]!, nd, l);
    }
  }
}
