// The first-person weapon: the model in the player's hands (built in code, tools/weapons: the gun with the firing
// hand, the magazine, the bolt and the support arm as parts), placed against the camera every frame. From the hip it
// sits low and to the right, sways behind the view when it turns, bobs with the stride, kicks back with each shot,
// drops and tilts for a reload (the magazine comes out and goes back in), and comes up from below after a switch.
// With the sights up the weapon's eye point is brought to the eye; a scoped weapon gives way to its reticle.
import { BoxGeometry, GLTFModel, Mesh, MeshStandardMaterial, RingGeometry, type Object3D, type PerspectiveCamera, type Scene } from "@threert/scene";
import { LOADOUT, WEAPON_MODEL, type WeaponDef } from "./config.ts";
import { add, basisQuat, mad, norm, scale, turn, type V3 } from "./vec.ts";
import type { Arsenal } from "./weapons.ts";
import metaJson from "./weapons/meta.json";

export interface WeaponMeta { muzzle: V3; eject: V3; ejectDir: V3; eye: V3; gripL: V3; magOut: V3; boltTravel: number; length: number }
export const WEAPON_META = metaJson as unknown as Record<string, WeaponMeta>;
export const metaOf = (w: WeaponDef): WeaponMeta => WEAPON_META[WEAPON_MODEL[w.id]!]!;

interface Parts { main: GLTFModel; mag: GLTFModel; bolt: GLTFModel; support: GLTFModel }
const PARK = -300;

/** What the view model needs to know of the player this frame. */
export interface ViewState {
  dt: number;
  /** The camera's place and axes (forward, right, up). */
  eye: V3; f: V3; r: V3; u: V3;
  /** This frame's turn (radians: right, down), the ground speed, the distance walked, on the ground, sprinting. */
  lookX: number; lookY: number; speed: number; walked: number; grounded: boolean; sprinting: boolean;
  /** Vertical speed, m/s (the weapon lags a jump and a landing). */
  vy: number;
  hidden: boolean;
}

export class ViewModel {
  private readonly parts = new Map<string, Parts>();
  private readonly reticle: Object3D[] = [];
  private shown: string | null = null;
  private swayX = 0;
  private swayY = 0;
  private lift = 0;
  private run = 0;
  /** Where the muzzle and the ejection port are in the world this frame, and the weapon's forward. */
  muzzle: V3 = [0, 0, 0];
  port: V3 = [0, 0, 0];
  portDir: V3 = [1, 0, 0];
  forward: V3 = [0, 0, -1];
  /** The scope's reticle is what the player sees (the HUD draws no crosshair then). */
  scoped = false;

  constructor(scene: Scene) {
    let n = 0;
    const park = <T extends Object3D>(o: T, name: string): T => {
      o.name = name;
      o.movable = true;
      o.castShadow = false;
      o.position.set(40 + 3 * n++, PARK, 0);
      scene.add(o);
      return o;
    };
    for (const id of LOADOUT) {
      const model = `assets/weapons/${WEAPON_MODEL[id]}.glb`;
      this.parts.set(id, {
        main: park(new GLTFModel(model, { nodes: ["body", "arm_r"] }), `vm ${id}`),
        mag: park(new GLTFModel(model, { nodes: ["mag"] }), `vm ${id} mag`),
        bolt: park(new GLTFModel(model, { nodes: ["bolt"] }), `vm ${id} bolt`),
        support: park(new GLTFModel(model, { nodes: ["arm_l"] }), `vm ${id} arm`),
      });
    }
    // The scope's picture: a black mask with a round hole and two hairs, held in front of the eye.
    // (Black metal: no diffuse and no specular at all, so the sun on it shows nothing.)
    const black = new MeshStandardMaterial({ name: "scope", color: 0x000000, roughness: 1, metalness: 1 });
    this.reticle.push(park(new Mesh(new RingGeometry(1, 14, 48, 1), black), "scope mask"));
    this.reticle.push(park(new Mesh(new BoxGeometry(1.9, 0.012, 0.001), black), "scope hair h"));
    this.reticle.push(park(new Mesh(new BoxGeometry(0.012, 1.9, 0.001), black), "scope hair v"));
  }

  private hide(id: string): void {
    const p = this.parts.get(id);
    if (!p) return;
    let i = 0;
    for (const o of [p.main, p.mag, p.bolt, p.support]) o.position.set(40 + 3 * i++, PARK - 5 * LOADOUT.indexOf(id as (typeof LOADOUT)[number]), 0);
  }

  update(camera: PerspectiveCamera, a: Arsenal, v: ViewState): void {
    const w = a.def, meta = metaOf(w);
    const dt = v.dt;
    // Sway: the weapon trails the view's turn; it settles when the view does.
    const ease = 1 - Math.exp(-dt * 12);
    this.swayX += (Math.max(-0.06, Math.min(0.06, -v.lookX * 1.6)) - this.swayX) * ease;
    this.swayY += (Math.max(-0.06, Math.min(0.06, -v.lookY * 1.6)) - this.swayY) * ease;
    this.lift += (Math.max(-0.03, Math.min(0.03, -v.vy * 0.006)) - this.lift) * ease;
    this.run += ((v.sprinting ? 1 : 0) - this.run) * (1 - Math.exp(-dt * 9));

    const scoped = w.scoped && a.ads > 0.86;
    this.scoped = scoped;
    if (this.shown && this.shown !== w.id) this.hide(this.shown);
    this.shown = w.id;

    // The weapon's origin (the grip) relative to the eye: from the hip, or with its eye point at the eye.
    const k = a.ads * a.ads * (3 - 2 * a.ads);
    const hip: V3 = [w.hip[0], w.hip[1], w.hip[2]];
    const sights: V3 = [-meta.eye[0], -meta.eye[1], meta.eye[2] + 0.07];
    let right = hip[0] + (sights[0] - hip[0]) * k, upward = hip[1] + (sights[1] - hip[1]) * k, ahead = hip[2] + (sights[2] - hip[2]) * k;
    // The stride's bob (smaller with the sights up), the jump's lag, the kick, the reload's drop, the draw.
    const stride = v.walked * (v.sprinting ? 2.9 : 3.4);
    const bob = Math.min(1, v.speed / 4.8) * (v.grounded ? 1 : 0.2) * (1 - 0.85 * k);
    right += Math.sin(stride) * 0.006 * bob;
    upward += -Math.abs(Math.cos(stride)) * 0.008 * bob + this.lift;
    const since = a.clock - a.lastShot;
    const punch = Math.exp(-since * 22) * (0.03 + w.recoil.up * 0.5) * (1 - 0.5 * k);
    ahead -= punch;
    const reloadT = a.reloading > 0 ? 1 - a.reloading / (w.reload / 1000) : -1;
    const bell = (t: number, a0: number, a1: number) => (t <= a0 || t >= a1 ? 0 : Math.sin(((t - a0) / (a1 - a0)) * Math.PI));
    const down = reloadT >= 0 ? Math.min(1, Math.min(reloadT, 1 - reloadT) * 7) : 0;
    const draw = w.draw > 0 ? a.drawing / w.draw : 0;
    upward -= down * 0.05 + draw * 0.2 + this.run * 0.035;
    right -= this.run * 0.03;

    // The weapon's axes: the view's, turned by the sway, the kick, the reload's tilt, the run's carry.
    let wf = v.f, wr = v.r, wu = v.u;
    const rot = (axis: V3, angle: number) => { wf = turn(wf, axis, angle); wr = turn(wr, axis, angle); wu = turn(wu, axis, angle); };
    // (From the hip the weapon is canted a little: its muzzle towards the middle of the view, its top to the left.)
    rot(v.u, this.swayX * (1 - 0.7 * k) - this.run * 0.5 + 0.045 * (1 - k));
    rot(wr, -this.swayY * (1 - 0.7 * k) + punch * 1.4 - draw * 0.7 - down * 0.28 - this.run * 0.32);
    rot(wf, down * 0.42 - 0.07 * (1 - k));
    const origin = mad(mad(mad(v.eye, v.r, right), v.u, upward), v.f, ahead);
    // (Weapon space: +X right, +Y up, -Z forward.)
    const wz = scale(wf, -1);
    const q = basisQuat(wr, wu, wz);
    const at = (p: V3): V3 => mad(mad(mad(origin, wr, p[0]), wu, p[1]), wz, p[2]);
    this.muzzle = at(meta.muzzle);
    this.port = at(meta.eject);
    this.portDir = norm(add(add(scale(wr, meta.ejectDir[0]), scale(wu, meta.ejectDir[1])), scale(wz, meta.ejectDir[2])));
    this.forward = wf;

    const parts = this.parts.get(w.id)!;
    if (v.hidden || scoped) this.hide(w.id);
    else {
      const set = (o: Object3D, offset: V3) => {
        const p = at(offset);
        o.position.set(p[0], p[1], p[2]);
        o.quaternion.set(q[0], q[1], q[2], q[3]);
      };
      set(parts.main, [0, 0, 0]);
      // The bolt runs back with a shot. The magazine leaves during the reload's first half and comes back.
      set(parts.bolt, [0, 0, Math.exp(-since * 38) * meta.boltTravel * (since < 0.12 ? 1 : 0)]);
      const out = reloadT >= 0 ? bell(reloadT, 0.12, 0.7) : 0;
      const magAt: V3 = [meta.magOut[0] * out * 1.6, meta.magOut[1] * out * 1.6, meta.magOut[2] * out * 1.6];
      set(parts.mag, magAt);
      // The support hand goes with the magazine while it is out.
      set(parts.support, [magAt[0] * 0.9, magAt[1] * 0.9 - out * 0.02, magAt[2] * 0.9 + out * 0.05]);
    }

    // The reticle, sized to the field of view so the hole stays the picture's height.
    const [mask, hairH, hairV] = this.reticle as [Object3D, Object3D, Object3D];
    if (scoped && !v.hidden) {
      const d = 0.2, half = d * Math.tan((camera.fov * Math.PI) / 360);
      const c = mad(v.eye, v.f, d);
      const cq = basisQuat(v.r, v.u, scale(v.f, -1));
      for (const o of [mask, hairH, hairV]) {
        o.position.set(c[0], c[1], c[2]);
        o.quaternion.set(cq[0], cq[1], cq[2], cq[3]);
      }
      mask.scale.setScalar(half * 0.94);
      hairH.scale.set(half, half * 0.6, 1);
      hairV.scale.set(half * 0.6, half, 1);
    } else if (mask.position.y > PARK + 50) {
      mask.position.set(30, PARK - 30, 0);
      hairH.position.set(33, PARK - 30, 0);
      hairV.position.set(36, PARK - 30, 0);
    }
  }
}
