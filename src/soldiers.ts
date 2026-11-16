// The other players' bodies: soldiers built in code and posed by the game every frame from what the room sends
// (position, yaw, pitch, crouch, speed, weapon). No model file: a body is a dozen rigid parts (pelvis, chest, head,
// helmet, pack, and capsules for the arms and legs), and each kind of part is one instanced mesh for all soldiers, so
// a pose is a table of matrices (an edit in place) and a team's colour is an instance colour.
//
// The pose is procedural: the legs stride with the distance covered (feet placed by two-bone IK, so a crouch bends
// the knees over planted feet), the chest leans with the aim, the head and the weapon follow the pitch exactly, both
// hands are on the weapon (IK again), a sprint carries the weapon low, and a death lays the body down. The same
// skeleton gives the hit volumes the shooter's client tests its rays against: a head sphere, a torso capsule, limb
// capsules (zones head / body / limb).
import {
  BoxGeometry, CapsuleGeometry, Color, GLTFModel, InstancedMesh, MeshStandardMaterial, SphereGeometry, type BufferGeometry, type Scene,
} from "@threert/scene";
import { FLAG, LOADOUT, POSE, TEAM, WEAPON_MODEL, type Team, type Zone } from "./config.ts";
import { add, basisQuat, cross, dot, len, lerp, mad, norm, rayCapsule, raySphere, scale, sub, turn, writeBasis, type V3 } from "./vec.ts";
import { WEAPON_META } from "./viewmodel.ts";

/** How many soldiers can be shown at once: nine others in a full room, and spares (the player's own body when it
 *  dies, practice targets). */
export const SLOTS = 12;

const UP: V3 = [0, 1, 0];
const UPPER = 0.29, FORE = 0.27, THIGH = 0.45, SHIN = 0.46;
const ZERO = new Float32Array(16);

/** What is drawn of one soldier, and where its hit volumes are. */
export interface SoldierState {
  slot: number;
  team: Team | null;
  /** The feet, the view. */
  position: V3;
  yaw: number;
  pitch: number;
  flags: number;
  /** Ground speed, m/s, and the direction of travel (unit, on the ground plane). */
  speed: number;
  heading: V3;
  weapon: number;
  /** 0 standing .. 1 crouched; the stride's phase (radians); seconds since it died (-1: alive); last shot (s ago). */
  crouch: number;
  stride: number;
  dead: number;
  fired: number;
}

export interface HitVolume { zone: Zone; a: V3; b: V3; r: number }

interface Part { mesh: InstancedMesh; per: number }

export class Soldiers {
  private readonly parts: Record<string, Part> = {};
  private readonly guns: GLTFModel[][] = [];
  private readonly shown = new Uint8Array(SLOTS);
  private readonly gunShown = new Int8Array(SLOTS).fill(-1);
  /** The hit volumes of each slot as last posed (empty when not shown or dead). */
  readonly volumes: HitVolume[][] = Array.from({ length: SLOTS }, () => []);
  /** Where each slot's muzzle is (for the flash and tracer of its shots). */
  readonly muzzles: V3[] = Array.from({ length: SLOTS }, () => [0, 0, 0] as V3);

  constructor(scene: Scene) {
    const cloth = (name: string, roughness = 0.85) => new MeshStandardMaterial({ name, color: 0xffffff, roughness });
    const part = (name: string, g: BufferGeometry, per: number, m = cloth(`soldier ${name}`)) => {
      const mesh = new InstancedMesh(g, m, SLOTS * per);
      mesh.name = `soldiers ${name}`;
      mesh.instanceMatrix.array.fill(0);
      for (let i = 0; i < SLOTS * per; i++) mesh.setColorAt(i, new Color(0xffffff));
      scene.add(mesh);
      this.parts[name] = { mesh, per };
    };
    part("pelvis", new BoxGeometry(0.35, 0.22, 0.23), 1);
    part("chest", new BoxGeometry(0.42, 0.5, 0.25), 1);
    part("vest", new BoxGeometry(0.46, 0.36, 0.3), 1, cloth("soldier vest", 0.7));
    part("pack", new BoxGeometry(0.3, 0.36, 0.13), 1);
    part("head", new SphereGeometry(0.108, 14, 10), 1, cloth("soldier skin", 0.6));
    part("helmet", new SphereGeometry(0.138, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.6), 1, cloth("soldier helmet", 0.45));
    part("upper", new CapsuleGeometry(0.062, UPPER, 3, 8), 2);
    part("fore", new CapsuleGeometry(0.052, FORE, 3, 8), 2);
    part("hand", new SphereGeometry(0.05, 8, 6), 2, cloth("soldier glove", 0.8));
    part("thigh", new CapsuleGeometry(0.094, THIGH, 3, 8), 2);
    part("shin", new CapsuleGeometry(0.074, SHIN, 3, 8), 2);
    part("boot", new BoxGeometry(0.12, 0.1, 0.29), 2, cloth("soldier boot", 0.6));
    // The weapons a soldier may hold: the low-detail models, one of each a slot, parked until needed.
    for (let s = 0; s < SLOTS; s++) {
      this.guns.push(LOADOUT.map((id, k) => {
        const g = new GLTFModel(`assets/weapons/${WEAPON_MODEL[id]}_world.glb`);
        g.name = `soldier ${s} ${id}`;
        g.movable = true;
        g.position.set(-40 - 2 * s, -330 - 3 * k, 0);
        scene.add(g);
        return g;
      }));
    }
  }

  private colour(slot: number, team: Team | null): void {
    const c = new Color(team ? TEAM[team].color : 0x8d8f86);
    const fatigue = new Color(team === "ember" ? 0x4a3f33 : team === "azure" ? 0x333c4a : 0x41443c);
    const dark = new Color(0x1c1d1f);
    const set = (name: string, col: Color) => {
      const p = this.parts[name]!;
      for (let i = 0; i < p.per; i++) p.mesh.setColorAt(slot * p.per + i, col);
      if (p.mesh.instanceColor) p.mesh.instanceColor.needsUpdate = true;
    };
    set("pelvis", fatigue); set("chest", fatigue); set("upper", fatigue); set("fore", fatigue); set("thigh", fatigue); set("shin", fatigue);
    set("vest", c); set("helmet", c); set("pack", dark); set("hand", dark); set("boot", dark);
    set("head", new Color(0xc49a78));
  }

  /** Takes a soldier out of the picture. */
  hide(slot: number): void {
    if (!this.shown[slot]) return;
    this.shown[slot] = 0;
    for (const p of Object.values(this.parts)) {
      for (let i = 0; i < p.per; i++) p.mesh.instanceMatrix.array.set(ZERO, (slot * p.per + i) * 16);
      p.mesh.instanceMatrix.needsUpdate = true;
    }
    this.holster(slot, -1);
    this.volumes[slot] = [];
  }

  private holster(slot: number, keep: number): void {
    const was = this.gunShown[slot]!;
    if (was >= 0 && was !== keep) this.guns[slot]![was]!.position.set(-40 - 2 * slot, -330 - 3 * was, 0);
    this.gunShown[slot] = keep;
  }

  /** Poses one soldier. `team` colours it when it is first shown (or changes side). */
  private readonly teams: (Team | null | undefined)[] = [];
  pose(s: SoldierState): void {
    const slot = s.slot;
    if (!this.shown[slot] || this.teams[slot] !== s.team) {
      this.colour(slot, s.team);
      this.teams[slot] = s.team;
      this.shown[slot] = 1;
    }
    const sy = Math.sin(s.yaw), cy = Math.cos(s.yaw);
    const f: V3 = [-sy, 0, -cy], r: V3 = [cy, 0, -sy];
    const c = s.crouch;
    const moving = Math.min(1, s.speed / 4.8);
    const sprint = (s.flags & FLAG.sprint) !== 0 ? 1 : 0;
    const air = (s.flags & FLAG.air) !== 0;
    // The hips: lower in a crouch, bobbing with the stride.
    const hipY = 0.95 - 0.34 * c + Math.abs(Math.sin(s.stride)) * 0.035 * moving;
    const P: V3 = [s.position[0], s.position[1] + hipY, s.position[2]];
    // The chest leans into a run and a crouch, and half with the aim.
    const lean = 0.06 + 0.16 * moving + 0.3 * c + 0.2 * sprint - s.pitch * 0.4;
    const tUp = norm(add(scale(UP, Math.cos(lean)), scale(f, Math.sin(lean))));
    const tF = cross(r, tUp).map((v) => -v) as V3;          // forward of the chest: r x tUp points back
    const W = mad(P, UP, 0.08);
    const neck = mad(W, tUp, 0.54);
    const sp = Math.sin(s.pitch), cp = Math.cos(s.pitch);
    const aimF: V3 = [f[0] * cp, sp, f[2] * cp];
    const aimU = cross(r, aimF);                              // up of the aim
    const headC = mad(mad(neck, UP, 0.115), aimF, 0.02);

    // Death: the whole body turns back about its feet and lies down.
    const fall = s.dead < 0 ? 0 : Math.min(1, s.dead / 0.55);
    const tip = fall * fall * (3 - 2 * fall) * 1.5;
    const feet: V3 = [s.position[0], s.position[1], s.position[2]];
    const laid = (p: V3): V3 => (tip === 0 ? p : add(add(feet, turn(sub(p, feet), r, -tip)), [0, 0.11 * fall, 0]));
    const laidDir = (d: V3): V3 => (tip === 0 ? d : turn(d, r, -tip));
    const M = (name: string, i: number, x: V3, y: V3, z: V3, t: V3) => {
      const p = this.parts[name]!;
      writeBasis(p.mesh.instanceMatrix.array, (slot * p.per + i) * 16, laidDir(x), laidDir(y), laidDir(z), laid(t));
    };
    /** A capsule (its axis is Y) from a to b. */
    const limb = (name: string, i: number, a: V3, b: V3, side: V3) => {
      const y = norm(sub(b, a));
      const x = norm(cross(y, cross(side, y)));
      M(name, i, x, y, cross(x, y), lerp(a, b, 0.5));
    };
    /** The middle joint of a two-bone chain from `root` to `target`, bent toward `pole`. */
    const bend = (root: V3, target: V3, l1: number, l2: number, pole: V3): { joint: V3; end: V3 } => {
      let d = sub(target, root);
      const dl = Math.max(1e-4, len(d));
      const reach = Math.min(dl, l1 + l2 - 0.005);
      d = scale(d, 1 / dl);
      const a = (l1 * l1 - l2 * l2 + reach * reach) / (2 * reach);
      const h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
      const perp = norm(sub(pole, scale(d, dot(pole, d))));
      return { joint: add(mad(root, d, a), scale(perp, h)), end: mad(root, d, reach) };
    };

    M("pelvis", 0, r, UP, scale(f, -1), mad(P, UP, 0.02));
    const tZ = scale(tF, -1);
    M("chest", 0, r, tUp, tZ, mad(W, tUp, 0.27));
    M("vest", 0, r, tUp, tZ, mad(mad(W, tUp, 0.31), tF, 0.005));
    M("pack", 0, r, tUp, tZ, mad(mad(W, tUp, 0.3), tF, -0.19));
    const hZ = scale(aimF, -1);
    M("head", 0, r, aimU, hZ, headC);
    M("helmet", 0, r, aimU, hZ, mad(headC, aimU, 0.012));

    // The weapon: at the right shoulder along the aim; carried low in a sprint and when dead.
    const low = Math.max(sprint * 0.75, fall);
    const gF = norm(turn(aimF, r, -low * 0.75)), gU = cross(r, gF);
    const grip = add(mad(mad(mad(W, tUp, 0.33 - 0.1 * low), r, 0.13), gF, 0.27), [0, 0, 0]);
    const wi = Math.max(0, Math.min(LOADOUT.length - 1, Math.round(s.weapon)));
    const meta = WEAPON_META[WEAPON_MODEL[LOADOUT[wi]!]!]!;
    const gun = this.guns[slot]![wi]!;
    this.holster(slot, wi);
    const gq = basisQuat(laidDir(r), laidDir(gU), laidDir(scale(gF, -1)));
    const gp = laid(grip);
    gun.position.set(gp[0], gp[1], gp[2]);
    gun.quaternion.set(gq[0], gq[1], gq[2], gq[3]);
    const inGun = (p: V3): V3 => mad(mad(mad(grip, r, p[0]), gU, p[1]), gF, -p[2]);
    this.muzzles[slot] = laid(inGun(meta.muzzle));

    // The arms: both hands on the weapon.
    const handR = mad(grip, gU, -0.035);
    const handL = inGun([meta.gripL[0], meta.gripL[1] - 0.02, Math.max(meta.gripL[2], -0.3)]);
    const shR = mad(mad(W, tUp, 0.45), r, 0.2), shL = mad(mad(W, tUp, 0.45), r, -0.2);
    const armR = bend(shR, handR, UPPER, FORE, add(scale(UP, -1), scale(r, 0.7)));
    const armL = bend(shL, handL, UPPER, FORE, add(scale(UP, -1), scale(r, -0.5)));
    limb("upper", 0, shR, armR.joint, f); limb("fore", 0, armR.joint, armR.end, f);
    limb("upper", 1, shL, armL.joint, f); limb("fore", 1, armL.joint, armL.end, f);
    M("hand", 0, r, UP, scale(f, -1), armR.end);
    M("hand", 1, r, UP, scale(f, -1), armL.end);

    // The legs: feet swing along the direction of travel, lifted on the way forward.
    const swing = Math.min(0.42, s.speed * 0.085), liftMax = Math.min(0.17, s.speed * 0.04);
    const ground = s.position[1];
    const volumes: HitVolume[] = [];
    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? 1 : -1;
      const ph = s.stride + (i === 0 ? 0 : Math.PI);
      const hip = mad(mad(P, r, 0.1 * side), UP, -0.03);
      let foot = mad(mad([P[0], ground + 0.075, P[2]], r, 0.11 * side), s.heading, Math.sin(ph) * swing);
      foot = mad(foot, f, side * 0.13 * c + (air ? -0.1 : 0));
      foot[1] += Math.max(0, Math.cos(ph)) * liftMax + (air ? 0.12 : 0);
      const leg = bend(hip, foot, THIGH, SHIN, add(f, scale(r, 0.25 * side)));
      limb("thigh", i, hip, leg.joint, r);
      limb("shin", i, leg.joint, leg.end, r);
      M("boot", i, r, UP, scale(f, -1), mad(mad(leg.end, f, 0.06), UP, -0.03));
      volumes.push({ zone: "limb", a: hip, b: leg.joint, r: 0.11 }, { zone: "limb", a: leg.joint, b: mad(leg.end, UP, -0.05), r: 0.095 });
    }
    volumes.push({ zone: "limb", a: shR, b: armR.joint, r: 0.075 }, { zone: "limb", a: armR.joint, b: armR.end, r: 0.07 });
    volumes.push({ zone: "limb", a: shL, b: armL.joint, r: 0.075 }, { zone: "limb", a: armL.joint, b: armL.end, r: 0.07 });
    volumes.push({ zone: "body", a: mad(P, UP, 0.02), b: mad(W, tUp, 0.38), r: 0.215 });
    volumes.push({ zone: "head", a: mad(headC, aimU, 0.015), b: headC, r: 0.15 });
    this.volumes[slot] = s.dead >= 0 ? [] : volumes;

    for (const p of Object.values(this.parts)) p.mesh.instanceMatrix.needsUpdate = true;
  }

  /**
   * The nearest hit of a ray (origin, unit direction) on the soldiers in `slots`, within `far` metres: the slot, the
   * zone, how far, and the point.
   */
  hit(origin: V3, direction: V3, far: number, slots: Iterable<number>): { slot: number; zone: Zone; distance: number; point: V3 } | null {
    let best: { slot: number; zone: Zone; distance: number; point: V3 } | null = null;
    for (const slot of slots) {
      for (const v of this.volumes[slot]!) {
        const t = v.zone === "head" ? raySphere(origin, direction, v.a, v.r) : rayCapsule(origin, direction, v.a, v.b, v.r);
        if (t < 0 || t > far) continue;
        // (The head wins a tie with the torso behind it; a limb in front of the torso is a limb.)
        if (!best || t < best.distance - (v.zone === "head" ? -0.05 : 0)) best = { slot, zone: v.zone, distance: t, point: mad(origin, direction, t) };
      }
    }
    return best;
  }
}

/** Advances a soldier's animation state from a pose the room sent (or a bot's), over `dt` seconds. */
export function animate(s: SoldierState, pose: ArrayLike<number>, dt: number): void {
  const x = pose[POSE.x]!, y = pose[POSE.y]!, z = pose[POSE.z]!;
  const dx = x - s.position[0], dz = z - s.position[2];
  const moved = Math.hypot(dx, dz);
  // The direction of travel, eased (a pose is interpolated, its small steps are noisy).
  if (moved > 1e-4 && dt > 0) {
    const k = Math.min(1, dt * 10);
    s.heading = norm([s.heading[0] + (dx / moved - s.heading[0]) * k, 0, s.heading[2] + (dz / moved - s.heading[2]) * k]);
  }
  s.position = [x, y, z];
  s.yaw = pose[POSE.yaw]!;
  s.pitch = pose[POSE.pitch]!;
  s.speed = pose[POSE.speed] ?? (dt > 0 ? moved / dt : 0);
  s.flags = pose[POSE.flags] ?? 0;
  s.weapon = pose[POSE.weapon] ?? 0;
  const crouch = s.flags & FLAG.crouch ? 1 : 0;
  s.crouch += (crouch - s.crouch) * Math.min(1, dt * 9);
  // A stride is 1.55 m (two steps); the phase runs on with the ground covered.
  s.stride += Math.min(moved, 1) * ((2 * Math.PI) / (s.flags & FLAG.sprint ? 2.1 : 1.55));
  if (s.speed < 0.3) s.stride += (Math.round(s.stride / Math.PI) * Math.PI - s.stride) * Math.min(1, dt * 6);
}

export function newSoldier(slot: number, team: Team | null): SoldierState {
  return { slot, team, position: [0, -200, 0], yaw: 0, pitch: 0, flags: 0, speed: 0, heading: [0, 0, -1], weapon: 0, crouch: 0, stride: 0, dead: -1, fired: 9 };
}
