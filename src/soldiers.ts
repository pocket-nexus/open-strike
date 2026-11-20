// The other players' bodies: the operator model (tools/characters, assets/characters/operator.glb) posed by the game
// every frame from what the room sends (position, yaw, pitch, crouch, speed, weapon). A pose is a frame for each of
// the body's fifteen parts (src/character/rig.ts), worked out here: the skinned body's joints are put at them (the
// engine skins the cloth to them, so it bends at the joints), and the gear (helmet, carrier, pads, gloves, boots) is
// placed at them.
//
// The pose is procedural: the legs stride with the distance covered (feet placed by two-bone IK, so a crouch bends
// the knees over planted feet), the body stands bladed behind the weapon, the chest leans with the aim, the head
// follows the pitch, both hands are on the weapon (IK again), a sprint carries the weapon low. A death makes the body
// a ragdoll (src/ragdoll.ts) from the pose it had, struck by the shot that killed it (`blow`), and the weapon falls
// from its hands. The same skeleton gives the hit volumes the shooter's client tests its rays against: a head sphere,
// a torso capsule, limb capsules (zones head / body / limb).
import { GLTFModel, Raycaster, Vector3, type Scene } from "@threert/scene";
import { FLAG, LOADOUT, POSE, WEAPON_MODEL, type Team, type Zone } from "./config.ts";
import { JOINTS, OPERATOR_MODEL, OUTFITS, RIG, bodyNode, partNode, type Outfit, type PartName } from "./character/rig.ts";
import metaJson from "./character/meta.json";
import { add, basisQuat, cross, dot, len, mad, norm, rayCapsule, raySphere, scale, sub, turn, type V3 } from "./vec.ts";
import { WEAPON_META } from "./viewmodel.ts";
import { P as D, POINTS, Ragdoll, type Blow, type Cast } from "./ragdoll.ts";

/** How many soldiers can be shown at once: nine others in a full room, and spares (the player's own body when it
 *  dies, practice targets). */
export const SLOTS = 12;

const UP: V3 = [0, 1, 0];
const META = metaJson as { wristR: V3; wristL: V3; gear: PartName[] };
const HANDS = META;
/** How far the body is turned from the aim behind the weapon (radians: the support shoulder leads). */
const BLADE = 0.42;
const outfitOf = (team: Team | null): Outfit => team ?? "ranger";

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
  /** The shot that killed it, when known (who fired from where, the zone, how hard): the ragdoll takes it. */
  blow: Blow | null;
}

/** How hard a weapon's killing shot knocks a body (m/s given to what it struck). */
export function push(weapon: string): number {
  return weapon === "shotgun" ? 3.2 : weapon === "marksman" ? 2.4 : 1.6;
}

/** A part's frame: its origin, its right and up axes. */
interface Frame { o: V3; x: V3; y: V3 }

export interface HitVolume { zone: Zone; a: V3; b: V3; r: number }

/** One soldier's models in one outfit: the skinned body, and the gear of each part that has some. */
interface Body { skin: GLTFModel; gear: Partial<Record<PartName, GLTFModel>> }

/** The middle joint of a two-bone chain from `root` to `target`, bent toward `pole`; `end` is where it reaches. */
function bend(root: V3, target: V3, l1: number, l2: number, pole: V3): { joint: V3; end: V3 } {
  let d = sub(target, root);
  const dl = Math.max(1e-4, len(d));
  const reach = Math.min(dl, l1 + l2 - 0.005);
  d = scale(d, 1 / dl);
  const a = (l1 * l1 - l2 * l2 + reach * reach) / (2 * reach);
  const h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
  const perp = norm(sub(pole, scale(d, dot(pole, d))));
  return { joint: add(mad(root, d, a), scale(perp, h)), end: mad(root, d, reach) };
}

export class Soldiers {
  /** The body of each slot in each outfit, parked until shown. */
  private readonly bodies: Partial<Record<Outfit, Body>>[] = Array.from({ length: SLOTS }, () => ({}));
  private readonly worn: (Outfit | null)[] = new Array(SLOTS).fill(null);
  private readonly guns: GLTFModel[][] = [];
  private readonly gunShown = new Int8Array(SLOTS).fill(-1);
  /** The hit volumes of each slot as last posed (empty when not shown or dead). */
  readonly volumes: HitVolume[][] = Array.from({ length: SLOTS }, () => []);
  /** Where each slot's muzzle is (for the flash and tracer of its shots). */
  readonly muzzles: V3[] = Array.from({ length: SLOTS }, () => [0, 0, 0] as V3);

  private readonly scene: Scene;
  /** Each slot's ragdoll while it is dead; the points of its last two live poses (to start one moving as it was). */
  private readonly dolls: (Ragdoll | null)[] = new Array(SLOTS).fill(null);
  private readonly last: ({ now: V3[]; before: V3[] | null; dt: number; hands: { r: Frame; l: Frame }; up: V3; weapon: number; feet: V3 } | null)[] = new Array(SLOTS).fill(null);
  /** Where the ragdoll's weapon's top points (carried from frame to frame as it tumbles). */
  private readonly gunUp: V3[] = Array.from({ length: SLOTS }, () => [0, 1, 0] as V3);
  private readonly ray = new Raycaster();
  /** The map, for the ragdolls: the first thing a ray meets. */
  private readonly cast: Cast = (from, to) => {
    const d = sub(to, from), l = len(d);
    if (l < 1e-6) return null;
    this.ray.set(new Vector3(from[0], from[1], from[2]), new Vector3(d[0] / l, d[1] / l, d[2] / l));
    this.ray.far = l;
    const h = this.ray.intersectPhysics().sort((a, b) => a.distance - b.distance)[0];
    if (!h) return null;
    // (The face's normal, turned to meet the ray: a mesh collider's triangle may face either way.)
    let n: V3 = h.normal ? [h.normal.x, h.normal.y, h.normal.z] : [0, 1, 0];
    if (dot(n, d) > 0) n = scale(n, -1);
    return { point: [h.point.x, h.point.y, h.point.z], normal: n };
  };

  constructor(scene: Scene) {
    this.scene = scene;
    // Every slot has a body in each outfit and one of each weapon (the first-person model without its arms), parked
    // until needed. All of it is made here: a model that first appears in a frame is loaded in that frame, and a
    // frame's script has 50 ms.
    for (let s = 0; s < SLOTS; s++) {
      this.guns.push(LOADOUT.map((id, k) => {
        const g = new GLTFModel(`assets/weapons/${WEAPON_MODEL[id]}.glb`, { nodes: ["body", "mag", "bolt"] });
        g.name = `soldier ${s} ${id}`;
        g.movable = true;
        g.position.set(-40 - 2 * s, -330 - 3 * k, 0);
        scene.add(g);
        return g;
      }));
      // Each body is posed once, standing, before the scene is built: a body the game poses is skinned on its own,
      // again only when its pose changes (a parked one never is).
      for (const outfit of OUTFITS) {
        const team = (OUTFITS.indexOf(outfit) < 2 ? outfit : null) as Team | null;
        this.pose(newSoldier(s, team));
        this.hide(s);
      }
    }
  }

  private body(slot: number, outfit: Outfit): Body {
    return (this.bodies[slot]![outfit] ??= ((): Body => {
      const add = (m: GLTFModel, what: string) => {
        m.name = `soldier ${slot} ${outfit} ${what}`;
        m.movable = true;
        this.scene.add(m);
        return m;
      };
      const gear: Body["gear"] = {};
      for (const part of META.gear) gear[part] = add(new GLTFModel(OPERATOR_MODEL, { nodes: [partNode(part, outfit)] }), part);
      return { skin: add(new GLTFModel(OPERATOR_MODEL, { nodes: [bodyNode(outfit)] }), "body"), gear };
    })());
  }

  private undress(slot: number): void {
    const outfit = this.worn[slot];
    if (outfit) {
      // (Out of sight below the map; the skinned body keeps its pose there.)
      const b = this.bodies[slot]![outfit]!;
      b.skin.position.set(-40 - 2 * slot, -360, 0);
      Object.values(b.gear).forEach((m, i) => m.position.set(-40 - 2 * slot, -362 - 2 * i, 0));
    }
    this.worn[slot] = null;
  }

  /** Takes a soldier out of the picture. */
  hide(slot: number): void {
    this.dolls[slot] = null;
    this.last[slot] = null;
    if (!this.worn[slot]) return;
    this.undress(slot);
    this.holster(slot, -1);
    this.volumes[slot] = [];
  }

  private holster(slot: number, keep: number): void {
    const was = this.gunShown[slot]!;
    if (was >= 0 && was !== keep) this.guns[slot]![was]!.position.set(-40 - 2 * slot, -330 - 3 * was, 0);
    this.gunShown[slot] = keep;
  }

  /** Poses one soldier (in its team's outfit), `dt` seconds after the last time. */
  pose(s: SoldierState, dt = 1 / 60): void {
    const slot = s.slot;
    const outfit = outfitOf(s.team);
    if (this.worn[slot] !== outfit) {
      this.undress(slot);
      this.worn[slot] = outfit;
    }
    const body = this.body(slot, outfit);
    if (s.dead < 0 && this.dolls[slot]) {
      this.dolls[slot] = null;
      s.blow = null;
    }
    // (Dead, it keeps the weapon it had.)
    const k = this.last[slot];
    const wi = s.dead >= 0 && k ? k.weapon : Math.max(0, Math.min(LOADOUT.length - 1, Math.round(s.weapon)));
    const gun = this.guns[slot]![wi]!;
    this.holster(slot, wi);
    if (s.dead >= 0 && !this.dolls[slot] && k) {
      // It has just died: limp from its last live pose, moving as it moved (what the room says of a body that died,
      // its pose since, is not how it fell).
      this.dolls[slot] = new Ragdoll(k.now, k.before, k.dt, s.blow);
      this.gunUp[slot] = k.up;
      s.blow = null;
      this.volumes[slot] = [];
    }
    const doll = this.dolls[slot];
    if (doll) {
      // Dead: the ragdoll runs on (a late word of the shot still strikes it).
      if (s.blow && doll.age < 0.3) doll.strike(s.blow);
      s.blow = null;
      const was = doll.asleep;
      doll.step(dt, this.cast);
      if (!was) this.limp(slot, body, gun, doll, k?.feet ?? s.position);
      return;
    }
    const sy = Math.sin(s.yaw), cy = Math.cos(s.yaw);
    const f: V3 = [-sy, 0, -cy], r: V3 = [cy, 0, -sy];
    const c = s.crouch;
    const moving = Math.min(1, s.speed / 4.8), still = 1 - moving;
    const sprint = (s.flags & FLAG.sprint) !== 0 ? 1 : 0;
    const air = (s.flags & FLAG.air) !== 0;
    const step = Math.sin(s.stride);

    const feet: V3 = [s.position[0], s.position[1], s.position[2]];
    const frames: Partial<Record<PartName, Frame>> = {};
    /** Places a part: its origin, its right and up axes (its back axis follows). */
    const place = (part: PartName, o: V3, x: V3, y: V3) => { frames[part] = { o, x, y }; };
    /** Places the two bones of a limb, which bend about one axis: `hinge` (the parts' X). */
    const limb = (upper: PartName, lower: PartName, root: V3, joint: V3, end: V3, hinge: V3) => {
      const u = norm(sub(root, joint)), v = norm(sub(joint, end));
      place(upper, root, norm(sub(hinge, scale(u, dot(hinge, u)))), u);
      place(lower, joint, norm(sub(hinge, scale(v, dot(hinge, v)))), v);
    };

    // The hips: lower in a crouch, bobbing and swaying with the stride, turned a little behind the weapon.
    const hipY = RIG.hip - RIG.crouch * c + Math.abs(step) * 0.035 * moving;
    const P = mad([s.position[0], s.position[1] + hipY, s.position[2]], r, step * 0.014 * moving);
    const pr = turn(r, UP, -BLADE * 0.45 * still);
    place("pelvis", P, pr, UP);
    // The chest leans into a run and a crouch, and half with the aim; it is bladed, and swings against the legs.
    const lean = 0.06 + 0.16 * moving + 0.3 * c + 0.2 * sprint - s.pitch * 0.4;
    const tUp = norm(add(scale(UP, Math.cos(lean)), scale(f, Math.sin(lean))));
    const cr = turn(r, tUp, -BLADE * (1 - 0.5 * sprint) - step * 0.07 * moving);
    const W = mad(P, UP, RIG.waist);
    place("chest", W, cr, tUp);
    // The head looks where the soldier aims (the neck takes most of the pitch, the chest the rest).
    const neck = mad(W, tUp, RIG.neck);
    const sp = Math.sin(s.pitch), cp = Math.cos(s.pitch);
    const aimF: V3 = [f[0] * cp, sp, f[2] * cp];
    const aimU = cross(r, aimF);
    const hp = s.pitch * 0.8;
    const headU: V3 = norm(turn(add(scale(UP, Math.cos(hp)), scale(f, -Math.sin(hp))), aimF, -0.09));
    place("head", neck, norm(cross(headU, scale(aimF, -1))), headU);
    const headC = mad(neck, headU, RIG.head);

    // The weapon: at the right shoulder along the aim; carried low in a sprint.
    const low = sprint * 0.75;
    const gF = norm(turn(aimF, r, -low * 0.75)), gU = cross(r, gF);
    const grip = mad(mad(mad(W, tUp, 0.33 - 0.1 * low), r, 0.13), gF, 0.27);
    const meta = WEAPON_META[WEAPON_MODEL[LOADOUT[wi]!]!]!;
    const gq = basisQuat(r, gU, scale(gF, -1));
    gun.position.set(grip[0], grip[1], grip[2]);
    gun.quaternion.set(gq[0], gq[1], gq[2], gq[3]);
    const inGun = (p: V3): V3 => mad(mad(mad(grip, r, p[0]), gU, p[1]), gF, -p[2]);
    this.muzzles[slot] = inGun(meta.muzzle);

    // The hands are on the weapon (the gloves are modelled closed on it); the arms reach their wrists.
    const support: V3 = [meta.gripL[0], meta.gripL[1], Math.max(meta.gripL[2], -0.32)];
    place("hand_r", grip, r, gU);
    place("hand_l", inGun(support), r, gU);
    const sx = RIG.shoulder[0], sh = mad(W, tUp, RIG.shoulder[1]);
    const shR = mad(sh, cr, sx), shL = mad(sh, cr, -sx);
    const wristR = inGun(HANDS.wristR), wristL = inGun(add(support, HANDS.wristL));
    const poleR = add(scale(UP, -1), scale(r, 0.4)), poleL = add(scale(UP, -1), scale(r, -0.45));
    const armR = bend(shR, wristR, RIG.upper, RIG.fore, poleR), armL = bend(shL, wristL, RIG.upper, RIG.fore, poleL);
    const elbow = (root: V3, a: { joint: V3; end: V3 }) => norm(cross(sub(a.joint, root), sub(a.end, a.joint)));
    limb("upper_r", "fore_r", shR, armR.joint, armR.end, elbow(shR, armR));
    limb("upper_l", "fore_l", shL, armL.joint, armL.end, elbow(shL, armL));

    // The legs: at rest the support-side foot leads; feet swing along the direction of travel, lifted on the way
    // forward, and a crouch drops onto the rear knee's side.
    const swing = Math.min(0.42, s.speed * 0.085), liftMax = Math.min(0.17, s.speed * 0.04);
    const ground = s.position[1];
    const volumes: HitVolume[] = [];
    const legs: { hip: V3; knee: V3; ankle: V3; toe: V3 }[] = [];
    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? 1 : -1;
      const ph = s.stride + (i === 0 ? 0 : Math.PI);
      const hip = mad(mad(P, pr, RIG.hipJoint[0] * side), UP, RIG.hipJoint[1]);
      const lead = (side < 0 ? 0.1 + 0.1 * c : -0.08 - 0.1 * c) * still + (air ? -0.1 : 0);
      let ankle = mad(mad([s.position[0], ground + RIG.ankle, s.position[2]], r, (RIG.stance + 0.03 * c) * side), s.heading, Math.sin(ph) * swing);
      ankle = mad(ankle, f, lead);
      const lift = Math.max(0, Math.cos(ph)) * liftMax + (air ? 0.12 : 0);
      ankle[1] += lift;
      const leg = bend(hip, ankle, RIG.thigh, RIG.shin, add(f, scale(r, 0.3 * side)));
      const knee = norm(cross(sub(leg.end, leg.joint), sub(leg.joint, hip)));
      limb(side > 0 ? "thigh_r" : "thigh_l", side > 0 ? "shin_r" : "shin_l", hip, leg.joint, leg.end, len(cross(sub(leg.end, leg.joint), sub(leg.joint, hip))) > 1e-5 ? knee : r);
      // The foot: toes out a little, down while it is lifted; flat on the ground otherwise.
      const toe = turn(f, UP, -side * (0.16 + 0.1 * still) - BLADE * 0.3 * still);
      const dip = Math.min(0.9, lift * 4.5) + (leg.end[1] - ankle[1] > 0.01 ? 0.5 : 0);
      const fu = norm(add(scale(UP, Math.cos(dip)), scale(toe, Math.sin(dip))));
      place(side > 0 ? "foot_r" : "foot_l", leg.end, norm(cross(fu, scale(toe, -1))), fu);
      legs.push({ hip, knee: leg.joint, ankle: leg.end, toe: mad(mad(leg.end, scale(cross(norm(cross(fu, scale(toe, -1))), fu), -1), 0.15), fu, -0.05) });
      volumes.push({ zone: "limb", a: hip, b: leg.joint, r: 0.11 }, { zone: "limb", a: leg.joint, b: mad(leg.end, UP, -0.05), r: 0.095 });
    }
    volumes.push({ zone: "limb", a: shR, b: armR.joint, r: 0.075 }, { zone: "limb", a: armR.joint, b: armR.end, r: 0.07 });
    volumes.push({ zone: "limb", a: shL, b: armL.joint, r: 0.075 }, { zone: "limb", a: armL.joint, b: armL.end, r: 0.07 });
    volumes.push({ zone: "body", a: mad(P, UP, 0.02), b: mad(W, tUp, 0.38), r: 0.215 });
    volumes.push({ zone: "head", a: mad(headC, aimU, 0.015), b: headC, r: 0.15 });
    this.volumes[slot] = s.dead >= 0 ? [] : volumes;
    this.dress(body, frames, feet);

    // The points a ragdoll would start from, and how it was moving: kept from the last two poses.
    const pts: V3[] = new Array(POINTS);
    const [lr, ll] = [legs[0]!, legs[1]!];
    Object.assign(pts, {
      [D.hipL]: ll.hip, [D.hipR]: lr.hip, [D.waist]: W, [D.neck]: neck, [D.shoulderL]: shL, [D.shoulderR]: shR, [D.head]: headC,
      [D.elbowL]: armL.joint, [D.elbowR]: armR.joint, [D.wristL]: armL.end, [D.wristR]: armR.end, [D.kneeL]: ll.knee, [D.kneeR]: lr.knee,
      [D.ankleL]: ll.ankle, [D.ankleR]: lr.ankle, [D.toeL]: ll.toe, [D.toeR]: lr.toe, [D.grip]: grip, [D.muzzle]: inGun([0, 0, -0.55]),
    });
    const relative = (hand: Frame, fore: Frame): Frame => {
      const z = cross(fore.x, fore.y), d = sub(hand.o, fore.o);
      const local = (v: V3): V3 => [dot(v, fore.x), dot(v, fore.y), dot(v, z)];
      return { o: local(d), x: local(hand.x), y: local(hand.y) };
    };
    const prev = this.last[slot];
    this.last[slot] = { now: pts, before: prev?.now ?? null, dt, hands: { r: relative(frames.hand_r!, frames.fore_r!), l: relative(frames.hand_l!, frames.fore_l!) }, up: gU, weapon: wi, feet };
    // Dead with no live pose before (it was down when this client came, or it is the player's own body): limp from
    // this one.
    if (s.dead >= 0) this.pose(s, dt);
  }

  /** Puts the skinned body's joints and the gear at the parts' frames (the joints in the body's space: from its
   *  origin, at `origin`). */
  private dress(body: Body, frames: Partial<Record<PartName, Frame>>, origin: V3): void {
    const joints: Record<string, number[]> = {};
    for (const [part, f] of Object.entries(frames) as [PartName, Frame][]) {
      const q = basisQuat(f.x, f.y, cross(f.x, f.y));
      const m = body.gear[part];
      if (m) {
        m.position.set(f.o[0], f.o[1], f.o[2]);
        m.quaternion.set(q[0], q[1], q[2], q[3]);
      }
      if ((JOINTS as string[]).includes(part)) joints[part] = [f.o[0] - origin[0], f.o[1] - origin[1], f.o[2] - origin[2], q[0], q[1], q[2], q[3]];
    }
    body.skin.position.set(origin[0], origin[1], origin[2]);
    body.skin.animation = { nodes: joints };
  }

  /** The parts' frames from a ragdoll's points; the weapon where it fell. */
  private limp(slot: number, body: Body, gun: GLTFModel, doll: Ragdoll, origin: V3): void {
    const p = doll.p;
    const ortho = (x: V3, y: V3): V3 => norm(sub(x, scale(y, dot(x, y))));
    const pelvis = doll.frame("pelvis"), chest = doll.frame("chest");
    const hipMid = scale(add(p[D.hipL]!, p[D.hipR]!), 0.5);
    const frames: Partial<Record<PartName, Frame>> = {
      pelvis: { o: mad(hipMid, pelvis.y, -RIG.hipJoint[1]), x: pelvis.x, y: pelvis.y },
      chest: { o: p[D.waist]!, x: chest.x, y: chest.y },
    };
    const headY = norm(sub(p[D.head]!, p[D.neck]!));
    frames.head = { o: p[D.neck]!, x: ortho(chest.x, headY), y: headY };
    /** A bone from `a` down to `b` (its part hangs -Y), turned about `x`. */
    const bone = (part: PartName, a: V3, b: V3, x: V3) => {
      const y = norm(sub(a, b));
      frames[part] = { o: a, x: ortho(x, y), y };
    };
    const eL = doll.hingeAxis(0), eR = doll.hingeAxis(1), kL = scale(doll.hingeAxis(2), -1), kR = scale(doll.hingeAxis(3), -1);
    bone("upper_l", p[D.shoulderL]!, p[D.elbowL]!, eL); bone("fore_l", p[D.elbowL]!, p[D.wristL]!, eL);
    bone("upper_r", p[D.shoulderR]!, p[D.elbowR]!, eR); bone("fore_r", p[D.elbowR]!, p[D.wristR]!, eR);
    bone("thigh_l", p[D.hipL]!, p[D.kneeL]!, kL); bone("shin_l", p[D.kneeL]!, p[D.ankleL]!, kL);
    bone("thigh_r", p[D.hipR]!, p[D.kneeR]!, kR); bone("shin_r", p[D.kneeR]!, p[D.ankleR]!, kR);
    for (const [part, ankle, toe, shin] of [["foot_l", D.ankleL, D.toeL, "shin_l"], ["foot_r", D.ankleR, D.toeR, "shin_r"]] as const) {
      const z = norm(sub(p[ankle]!, p[toe]!)), x = ortho(frames[shin]!.x, z);
      frames[part] = { o: p[ankle]!, x, y: cross(z, x) };
    }
    // The hands stay as they were on the forearms (closed, now on nothing).
    const k = this.last[slot];
    for (const [part, fore, rel] of [["hand_r", "fore_r", k?.hands.r], ["hand_l", "fore_l", k?.hands.l]] as const) {
      if (!rel) continue;
      const f = frames[fore]!, z = cross(f.x, f.y);
      const w = (v: V3): V3 => add(add(scale(f.x, v[0]), scale(f.y, v[1])), scale(z, v[2]));
      frames[part] = { o: add(f.o, w(rel.o)), x: w(rel.x), y: w(rel.y) };
    }
    this.dress(body, frames, origin);
    // The weapon: along its two points, its top carried over from the last frame.
    const back = norm(sub(p[D.grip]!, p[D.muzzle]!));
    const up = ortho(this.gunUp[slot]!, back);
    this.gunUp[slot] = up;
    const gq = basisQuat(cross(up, back), up, back);
    gun.position.set(p[D.grip]![0], p[D.grip]![1], p[D.grip]![2]);
    gun.quaternion.set(gq[0], gq[1], gq[2], gq[3]);
  }

  /** The ragdolls as they are (for tests): each dead slot's waist, head and lowest point, whether it lies still. */
  ragdolls(): { slot: number; waist: V3; head: V3; low: number; asleep: boolean }[] {
    const r = (v: V3): V3 => v.map((x) => Math.round(x * 1000) / 1000) as V3;
    return this.dolls.flatMap((d, slot) => (d ? [{ slot, waist: r(d.p[D.waist]!), head: r(d.p[D.head]!), low: Math.round(Math.min(...d.p.map((p) => p[1])) * 1000) / 1000, asleep: d.asleep }] : []));
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
  return { slot, team, position: [0, -200, 0], yaw: 0, pitch: 0, flags: 0, speed: 0, heading: [0, 0, -1], weapon: 0, crouch: 0, stride: 0, dead: -1, fired: 9, blow: null };
}
