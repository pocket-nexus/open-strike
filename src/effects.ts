// The pieces of a firefight, from pools made once in setup (nothing is added to the scene while playing: a move is
// an edit in place, an added object may not be): muzzle flashes with the light they throw (a path tracer: for two
// or three frames the flash lights the weapon, the floor and the walls for real), tracers, sparks, bullet marks,
// puffs where a body is hit, casings. Parked far under the map while unused.
import { BoxGeometry, CylinderGeometry, Mesh, MeshStandardMaterial, PointLight, SphereGeometry, type Object3D, type Scene } from "@threert/scene";
import { basisQuat, cross, frameY, norm, sub, type V3 } from "./vec.ts";

const POOL = { flash: 4, tracer: 12, spark: 18, mark: 48, puff: 6, casing: 10 } as const;
const GRAVITY = 9.8;

interface Flash { core: Mesh; light: PointLight; age: number; life: number; scale: number }
interface Tracer { mesh: Mesh; from: V3; dir: V3; length: number; at: number; speed: number; live: boolean }
interface Bit { mesh: Mesh; p: V3; v: V3; age: number; life: number; live: boolean; floor: number; spin: number }

export class Effects {
  private readonly flashes: Flash[] = [];
  private readonly tracers: Tracer[] = [];
  private readonly sparks: Bit[] = [];
  private readonly puffs: Bit[] = [];
  private readonly casings: Bit[] = [];
  private readonly marks: Mesh[] = [];
  private next = { flash: 0, tracer: 0, spark: 0, mark: 0, puff: 0, casing: 0 };
  private parked = 0;

  constructor(scene: Scene) {
    const park = <T extends Object3D>(o: T, name: string): T => {
      o.name = name;
      o.movable = true;
      o.castShadow = false;
      o.position.set(0, -400 - 2 * this.parked++, 0);
      scene.add(o);
      return o;
    };
    const glow = (name: string, c: number, nits: number) => new MeshStandardMaterial({ name, color: 0x000000, emissive: c, emissiveIntensity: nits });
    const flashMat = glow("muzzle flash", 0xffb45c, 160000);
    for (let i = 0; i < POOL.flash; i++) {
      const core = park(new Mesh(new SphereGeometry(0.035, 10, 6), flashMat), `flash ${i}`);
      core.power = 0;
      const light = park(new PointLight(0xffb060, 1100), `flash ${i} light`);
      light.radius = 0.06;
      light.power = 0;
      this.flashes.push({ core, light, age: 1, life: 0, scale: 1 });
    }
    const tracerMat = glow("tracer", 0xffc878, 60000);
    for (let i = 0; i < POOL.tracer; i++) {
      const mesh = park(new Mesh(new BoxGeometry(0.012, 0.012, 1), tracerMat), `tracer ${i}`);
      mesh.power = 0;
      this.tracers.push({ mesh, from: [0, 0, 0], dir: [0, 0, 1], length: 0, at: 0, speed: 0, live: false });
    }
    const bit = (mesh: Mesh): Bit => ({ mesh, p: [0, 0, 0], v: [0, 0, 0], age: 0, life: 0, live: false, floor: -1e9, spin: 0 });
    const sparkMat = glow("spark", 0xffc070, 90000);
    for (let i = 0; i < POOL.spark; i++) {
      const mesh = park(new Mesh(new SphereGeometry(0.012, 6, 4), sparkMat), `spark ${i}`);
      mesh.power = 0;
      this.sparks.push(bit(mesh));
    }
    const puffMat = new MeshStandardMaterial({ name: "puff", color: 0x5a0a08, roughness: 0.5 });
    for (let i = 0; i < POOL.puff; i++) this.puffs.push(bit(park(new Mesh(new SphereGeometry(0.03, 6, 4), puffMat), `puff ${i}`)));
    const brass = new MeshStandardMaterial({ name: "brass", color: 0xc7913a, roughness: 0.32, metalness: 1 });
    for (let i = 0; i < POOL.casing; i++) this.casings.push(bit(park(new Mesh(new CylinderGeometry(0.0045, 0.0045, 0.032, 8), brass), `casing ${i}`)));
    const markMat = new MeshStandardMaterial({ name: "bullet mark", color: 0x0b0a09, roughness: 0.95 });
    for (let i = 0; i < POOL.mark; i++) this.marks.push(park(new Mesh(new CylinderGeometry(0.02, 0.032, 0.004, 9), markMat), `mark ${i}`));
  }

  /** A muzzle flash at `at`, pushed a little along `forward`: the hot core and its light. */
  flash(at: V3, forward: V3, scale = 1): void {
    const f = this.flashes[this.next.flash++ % POOL.flash]!;
    f.age = 0;
    f.life = 0.055;
    f.scale = scale;
    f.core.position.set(at[0] + forward[0] * 0.05, at[1] + forward[1] * 0.05, at[2] + forward[2] * 0.05);
    // (The light a little ahead of the muzzle: it lights the room, not only the weapon it came from.)
    f.light.position.set(at[0] + forward[0] * 0.45, at[1] + forward[1] * 0.45 + 0.03, at[2] + forward[2] * 0.45);
    f.core.scale.setScalar(scale * (0.8 + 0.4 * Math.random()));
    f.core.power = 1;
    f.light.power = scale;
  }

  /** A tracer from `from` to `to`. */
  tracer(from: V3, to: V3): void {
    const d = sub(to, from);
    const length = Math.hypot(d[0], d[1], d[2]);
    if (length < 1.5) return;
    const t = this.tracers[this.next.tracer++ % POOL.tracer]!;
    t.from = from;
    t.dir = [d[0] / length, d[1] / length, d[2] / length];
    t.length = length;
    t.at = 0.6;
    t.speed = 260;
    t.live = true;
    // (The streak's long axis is its local Z.)
    const { z } = frameY(t.dir);
    const q = basisQuat(z, cross(t.dir, z), t.dir);
    t.mesh.quaternion.set(q[0], q[1], q[2], q[3]);
    t.mesh.power = 1;
    this.placeTracer(t);
  }

  private placeTracer(t: Tracer): void {
    const tail = Math.max(0, t.at - 7), head = Math.min(t.at, t.length);
    const mid = (tail + head) / 2;
    t.mesh.position.set(t.from[0] + t.dir[0] * mid, t.from[1] + t.dir[1] * mid, t.from[2] + t.dir[2] * mid);
    t.mesh.scale.set(1, 1, Math.max(0.05, head - tail));
  }

  /** A bullet meeting a surface at `point` (unit `normal`): sparks and a mark. */
  impact(point: V3, normal: V3, mark = true): void {
    for (let i = 0; i < 3; i++) {
      const s = this.sparks[this.next.spark++ % POOL.spark]!;
      s.p = [point[0] + normal[0] * 0.02, point[1] + normal[1] * 0.02, point[2] + normal[2] * 0.02];
      s.v = [normal[0] * 2.4 + (Math.random() - 0.5) * 3.4, normal[1] * 2.4 + Math.random() * 2.2, normal[2] * 2.4 + (Math.random() - 0.5) * 3.4];
      s.age = 0;
      s.life = 0.16 + Math.random() * 0.14;
      s.live = true;
      s.floor = -1e9;
      s.mesh.power = 1;
    }
    if (!mark) return;
    const m = this.marks[this.next.mark++ % POOL.mark]!;
    const n = norm(normal);
    const { x, z } = frameY(n);
    const q = basisQuat(x, n, z);
    m.quaternion.set(q[0], q[1], q[2], q[3]);
    m.position.set(point[0] + n[0] * 0.003, point[1] + n[1] * 0.003, point[2] + n[2] * 0.003);
  }

  /** A bullet meeting a body. */
  puff(point: V3, toward: V3): void {
    for (let i = 0; i < 2; i++) {
      const s = this.puffs[this.next.puff++ % POOL.puff]!;
      s.p = [...point];
      s.v = [toward[0] * 1.5 + (Math.random() - 0.5) * 1.6, 0.8 + Math.random(), toward[2] * 1.5 + (Math.random() - 0.5) * 1.6];
      s.age = 0;
      s.life = 0.28;
      s.live = true;
      s.floor = -1e9;
    }
  }

  /** A spent case thrown from the port at `at` with velocity `v`; it comes to rest on `floor` (a height). */
  casing(at: V3, v: V3, floor: number): void {
    const c = this.casings[this.next.casing++ % POOL.casing]!;
    c.p = [...at];
    c.v = [...v];
    c.age = 0;
    c.life = 2.4;
    c.live = true;
    c.floor = floor + 0.006;
    c.spin = 12 + Math.random() * 20;
  }

  /** No effect in flight (a map change, a respawn far away keeps them; this is for a new scene). */
  clear(): void {
    for (const f of this.flashes) { f.age = 1; f.core.power = 0; f.light.power = 0; }
    for (const t of this.tracers) if (t.live) { t.live = false; t.mesh.power = 0; t.mesh.position.set(0, -390, 0); }
    for (const m of this.marks) m.position.y = -395;
  }

  update(dt: number): void {
    for (const f of this.flashes) {
      if (f.age >= f.life) continue;
      f.age += dt;
      if (f.age >= f.life) {
        f.core.power = 0;
        f.light.power = 0;
        f.core.position.y = -380;
      } else {
        const k = 1 - f.age / f.life;
        f.light.power = f.scale * k;
        f.core.power = k;
      }
    }
    for (const t of this.tracers) {
      if (!t.live) continue;
      t.at += t.speed * dt;
      if (t.at - 7 >= t.length) {
        t.live = false;
        t.mesh.power = 0;
        t.mesh.position.set(0, -390, 0);
      } else this.placeTracer(t);
    }
    for (const list of [this.sparks, this.puffs, this.casings]) {
      for (const s of list) {
        if (!s.live) continue;
        s.age += dt;
        if (s.age >= s.life) {
          s.live = false;
          s.mesh.power = list === this.sparks ? 0 : 1;
          s.mesh.position.set(0, -385, 0);
          continue;
        }
        s.v[1] -= GRAVITY * dt;
        s.p[0] += s.v[0] * dt; s.p[1] += s.v[1] * dt; s.p[2] += s.v[2] * dt;
        if (s.p[1] < s.floor) {
          s.p[1] = s.floor;
          // One bounce, then it lies there.
          if (Math.abs(s.v[1]) > 1.2) s.v = [s.v[0] * 0.45, -s.v[1] * 0.32, s.v[2] * 0.45];
          else { s.v = [0, 0, 0]; s.spin = 0; }
        }
        s.mesh.position.set(s.p[0], s.p[1], s.p[2]);
        if (s.spin) s.mesh.rotation.set(s.age * s.spin, s.age * s.spin * 0.7, 1.2);
      }
    }
  }
}
