// The player's body: a capsule the game moves itself through the physics world by shape sweeps (no rigid body: nothing
// pushes it around). The simulation runs in fixed steps of MOVE.step with an accumulator, whatever the frame rate, so
// speeds, jump height and what can be climbed are the same at 30, 60 and 120 Hz; what is drawn is blended between the
// last two steps. A sweep is continuous: no step can pass through a wall.
//
// A step: friction and acceleration toward where the keys point (Quake-style: full control on the ground, a little in
// the air), the jump, gravity; then the move, sideways first (sliding along what it meets; a ledge up to MOVE.stepUp
// is climbed: up, over, down), then up or down; then, for a player walking, the ground is looked for just below (down
// a slope, down a step) so it is walked, not fallen. Ladders are volumes of the map: inside one, forward is up.
import { Raycaster, Shapecaster, Vector3 } from "@threert/scene";
import { MOVE } from "./config.ts";
import type { MapData } from "./maps/types.ts";

/** What the keys ask for during a frame. */
export interface MoveInput {
  /** -1..1: right, forward. Never longer than 1. */
  x: number;
  y: number;
  /** Space went down this frame. */
  jump: boolean;
  crouch: boolean;
  sprint: boolean;
  /** Speed limit as a share of the run speed (the weapon in hand, the sights up). */
  limit: number;
}

export interface Landing { speed: number }

const UP = new Vector3(0, 1, 0), DOWN = new Vector3(0, -1, 0);
const tmp = new Vector3(), dir = new Vector3(), left = new Vector3(), before = new Vector3();

export class Player {
  /** The feet (the capsule's lowest point), after the last step; and where they were a step before. */
  readonly position = new Vector3();
  readonly previous = new Vector3();
  readonly velocity = new Vector3();
  yaw = 0;
  pitch = 0;
  grounded = false;
  crouched = false;
  onLadder = false;
  sprinting = false;
  /** The eyes' height above the feet now (it follows the crouch). */
  eye: number = MOVE.eye;
  /** Seconds since it last stood on something. */
  airTime = 0;
  /** The hardest landing of the last `update` (m/s downward), if any; and whether it left the map's bottom. */
  landed: Landing | null = null;
  fell = false;
  /** Distance walked on the ground, m: the stride of footsteps and of the weapon's bob. */
  walked = 0;

  private acc = 0;
  private jumpQueued = 0;
  private ladderLock = 0;
  private map: MapData | null = null;
  private readonly stand = new Shapecaster({ type: "capsule", halfHeight: MOVE.height / 2 - MOVE.radius, radius: MOVE.radius });
  private readonly duck = new Shapecaster({ type: "capsule", halfHeight: MOVE.crouchHeight / 2 - MOVE.radius, radius: MOVE.radius });
  // (What standing up needs to be free: the space from above the knees to just over a standing head, a little wider
  // than the body, so a player who stands up is never inside something.)
  private readonly probe = new Shapecaster({ type: "capsule", halfHeight: (MOVE.height - 0.5) / 2 - (MOVE.radius + 0.01), radius: MOVE.radius + 0.01 });
  private readonly ray = new Raycaster();

  setMap(map: MapData): void {
    this.map = map;
  }

  /** Puts the player somewhere, standing still. */
  place(at: readonly [number, number, number], yaw: number): void {
    this.position.set(at[0], at[1] + MOVE.skin + 0.01, at[2]);
    this.previous.copy(this.position);
    this.velocity.set(0, 0, 0);
    this.yaw = yaw;
    this.pitch = 0;
    this.grounded = false;
    this.crouched = false;
    this.onLadder = false;
    this.eye = MOVE.eye;
    this.acc = 0;
    this.jumpQueued = 0;
    this.airTime = 0;
  }

  /** Turns the view by a frame's look (radians: right and down are positive). */
  look(dx: number, dy: number): void {
    this.yaw -= dx;
    this.pitch = Math.max(-1.52, Math.min(1.52, this.pitch - dy));
  }

  get height(): number {
    return this.crouched ? MOVE.crouchHeight : MOVE.height;
  }
  get speed(): number {
    return Math.hypot(this.velocity.x, this.velocity.z);
  }

  /** Where the feet are drawn: between the last two steps. */
  feet(out: Vector3): Vector3 {
    return out.copy(this.previous).lerp(this.position, Math.min(1, this.acc / MOVE.step));
  }

  /** A frame of `dt` seconds: as many steps as have come due. Returns how many it ran. */
  update(dt: number, input: MoveInput): number {
    this.landed = null;
    this.fell = false;
    if (input.jump) this.jumpQueued = 0.12;
    this.acc += dt;
    let steps = 0;
    // (At most 16 steps a frame: a frame is at most 0.1 s, 12 steps.)
    while (this.acc >= MOVE.step - 1e-9 && steps < 16) {
      this.acc -= MOVE.step;
      this.previous.copy(this.position);
      this.step(MOVE.step, input);
      steps++;
    }
    if (this.acc < 0) this.acc = 0;
    // The eyes follow the crouch.
    const target = this.crouched ? MOVE.crouchEye : MOVE.eye;
    const d = target - this.eye, m = MOVE.crouchRate * dt;
    this.eye += Math.abs(d) <= m ? d : Math.sign(d) * m;
    return steps;
  }

  private caster(): Shapecaster {
    return this.crouched ? this.duck : this.stand;
  }

  /** The capsule at `at` (the feet) swept along `direction` (unit) by `distance`: how far it gets, and the surface. */
  private sweep(at: Vector3, direction: Vector3, distance: number): { distance: number; raw: number; normal: Vector3; point: Vector3 } | null {
    const c = this.caster();
    tmp.copy(at);
    tmp.y += this.height / 2;
    c.set(tmp);
    c.far = distance + MOVE.skin;
    const h = c.sweep(direction);
    return h && h.normal ? { distance: Math.max(h.distance - MOVE.skin, 0), raw: h.distance, normal: h.normal, point: h.point } : null;
  }

  /**
   * Whether what a downward sweep met can be stood on. A flat-enough surface can. So can the edge of one (a step's
   * lip, a ledge): there the contact's normal leans, because the capsule's end is round, so the surface itself is
   * asked with a short ray just inside the edge.
   */
  private standable(h: { normal: Vector3; point: Vector3 }): boolean {
    return this.floor(h) !== null;
  }

  /** The height of the surface a downward sweep met, if it can be stood on. */
  private floor(h: { normal: Vector3; point: Vector3 }): number | null {
    if (h.normal.y >= MOVE.ground) return h.point.y;
    if (h.normal.y < 0.05) return null;
    const nl = Math.hypot(h.normal.x, h.normal.z) || 1;
    this.ray.set(tmp.set(h.point.x - (h.normal.x / nl) * 0.03, h.point.y + 0.06, h.point.z - (h.normal.z / nl) * 0.03), DOWN);
    this.ray.far = 0.16;
    const face = this.ray.intersectPhysics()[0];
    return face && face.normal && face.normal.y >= MOVE.ground ? face.point.y : null;
  }

  /**
   * Moves `at` by `delta`, sliding along what it meets. Returns the last wall met (a surface too steep to stand
   * on), if any.
   */
  private slide(at: Vector3, delta: Vector3, level = false): Vector3 | null {
    let wall: Vector3 | null = null;
    left.copy(delta);
    let first: Vector3 | null = null;
    for (let turn = 0; turn < 4; turn++) {
      const length = left.length();
      if (length < 1e-6) break;
      dir.copy(left).multiplyScalar(1 / length);
      const h = this.sweep(at, dir, length);
      if (!h) {
        at.add(left);
        break;
      }
      const n = h.normal;
      // (A level move never rises: what leans is a wall to it. Stepping over a ledge is such a move, or the capsule's
      // round end would ride up a ledge higher than a step.)
      if (level && n.y < MOVE.ground) {
        n.y = 0;
        if (n.lengthSq() < 1e-8) break;
        n.normalize();
      }
      // Against it already and moving away from it: nothing is in the way of that.
      if (h.distance <= 1e-6 && left.dot(n) >= 0) {
        at.add(left);
        break;
      }
      at.addScaledVector(dir, h.distance);
      left.addScaledVector(dir, -h.distance);
      if (n.y < MOVE.ground) wall = n;
      // Take out of what is left the part that goes into the surface; in a crease of two, go along the crease.
      before.copy(left);
      left.addScaledVector(n, -left.dot(n));
      if (first && left.dot(first) < -1e-9) {
        const crease = tmp.copy(first).cross(n);
        if (crease.lengthSq() < 1e-8) break;
        crease.normalize();
        left.copy(crease).multiplyScalar(before.dot(crease));
      }
      first ??= n.clone();
    }
    return wall;
  }

  private inLadder(): boolean {
    const p = this.position, r = MOVE.radius * 0.5;
    for (const l of this.map?.ladders ?? []) {
      if (p.x > l.min[0] - r && p.x < l.max[0] + r && p.z > l.min[2] - r && p.z < l.max[2] + r && p.y > l.min[1] - 0.1 && p.y < l.max[1]) return true;
    }
    return false;
  }

  /** Whether there is room to stand up where it crouches. */
  private headroom(): boolean {
    tmp.copy(this.position);
    tmp.y += 0.5 + (MOVE.height - 0.5) / 2 + 0.01;
    this.probe.set(tmp);
    return this.probe.overlap().length === 0;
  }

  private step(dt: number, input: MoveInput): void {
    const v = this.velocity, p = this.position;
    // The crouch: down at once, up when there is room.
    if (input.crouch) this.crouched = true;
    else if (this.crouched && this.headroom()) this.crouched = false;

    const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
    // Where the keys point, on the ground plane: forward is (-sin, -cos), right is (cos, -sin).
    let wx = -sin * input.y + cos * input.x, wz = -cos * input.y - sin * input.x;
    const wl = Math.hypot(wx, wz);
    if (wl > 1) { wx /= wl; wz /= wl; }
    const pressing = Math.min(wl, 1);
    this.sprinting = input.sprint && !this.crouched && input.y > 0.5 && this.grounded && input.limit >= 0.9;
    const top = (this.crouched ? MOVE.crouch : this.sprinting ? MOVE.sprint : MOVE.run) * (this.crouched ? Math.min(1, input.limit + 0.2) : input.limit);

    this.ladderLock = Math.max(0, this.ladderLock - dt);
    this.jumpQueued = Math.max(0, this.jumpQueued - dt);
    const ladder = this.ladderLock === 0 && this.inLadder() && !(this.grounded && input.y <= 0);
    if (ladder) {
      // On a ladder: forward climbs (down, when looking down), sideways shuffles, jumping lets go.
      this.onLadder = true;
      this.grounded = false;
      this.airTime = 0;
      if (this.jumpQueued > 0) {
        this.jumpQueued = 0;
        this.ladderLock = 0.35;
        v.set(sin * 2.6, 2.2, cos * 2.6);
      } else {
        const climb = input.y * (this.pitch < -0.45 ? -1 : 1) * MOVE.ladder;
        v.set(wx * 2.4, climb, wz * 2.4);
        if (climb !== 0) {
          const h = this.sweep(p, tmp.set(0, Math.sign(climb), 0).clone(), Math.abs(climb) * dt);
          p.y += Math.sign(climb) * (h ? h.distance : Math.abs(climb) * dt);
          if (h && climb < 0 && this.standable(h)) this.grounded = true;
        }
        this.slide(p, tmp.set(v.x * dt, 0, v.z * dt).clone());
        return;
      }
    }
    this.onLadder = false;

    if (this.grounded) {
      // Friction, then acceleration toward the wish velocity.
      const speed = Math.hypot(v.x, v.z);
      if (speed > 1e-4) {
        const drop = Math.max(speed, MOVE.stopSpeed) * MOVE.friction * dt;
        const k = Math.max(speed - drop, 0) / speed;
        v.x *= k;
        v.z *= k;
      }
      accelerate(v, wx, wz, top * pressing, MOVE.accel, dt);
      if (this.jumpQueued > 0 && (!this.crouched || this.headroom())) {
        this.jumpQueued = 0;
        this.crouched = false;
        v.y = MOVE.jump;
        this.grounded = false;
      }
    } else {
      accelerate(v, wx, wz, Math.min(top, MOVE.airSpeed) * pressing, MOVE.airAccel, dt);
    }
    // Gravity: half before the move and half after it, so a jump's height is v² / 2g at any step.
    if (!this.grounded) v.y -= MOVE.gravity * dt * 0.5;

    // Sideways, with what a walking player may step over.
    const flat = new Vector3(v.x * dt, 0, v.z * dt);
    if (flat.lengthSq() > 1e-12) {
      const start = p.clone();
      const wall = this.slide(p, flat.clone());
      if (wall && this.grounded) {
        const plain = p.clone();
        const stepped = this.tryStep(start, flat);
        const gain = (q: Vector3) => (q.x - start.x) * flat.x + (q.z - start.z) * flat.z;
        if (stepped && gain(stepped) > gain(plain) + 1e-5) p.copy(stepped);
        else this.clip(wall);
      } else if (wall) {
        this.clip(wall);
      }
    }

    // Up or down.
    if (!this.grounded) {
      const fall = v.y * dt;
      const h = this.sweep(p, tmp.set(0, fall >= 0 ? 1 : -1, 0).clone(), Math.abs(fall));
      if (!h) p.y += fall;
      else {
        p.y += Math.sign(fall) * h.distance;
        if (fall > 0) v.y = 0;                              // a ceiling
        else if (this.standable(h)) {
          if (-v.y > (this.landed?.speed ?? 0)) this.landed = { speed: -v.y };
          v.y = 0;
          this.grounded = true;
        } else {
          // Too steep to stand on: slide down it.
          const n = h.normal;
          v.addScaledVector(n, -v.dot(n));
          this.slide(p, tmp.set(0, fall, 0).addScaledVector(n, -fall * n.y).clone());
        }
      }
    } else {
      // Walking: the ground is just below, or it has been walked off.
      const h = this.sweep(p, tmp.set(0, -1, 0).clone(), MOVE.stepDown);
      if (h && this.standable(h)) p.y -= h.raw - MOVE.skin;        // (up, too: back to a skin above it)
      else if (h) {
        p.y -= h.distance;
        this.grounded = false;
      } else this.grounded = false;
    }
    if (!this.grounded) v.y -= MOVE.gravity * dt * 0.5;

    if (this.grounded) {
      this.airTime = 0;
      this.walked += Math.hypot(p.x - this.previous.x, p.z - this.previous.z);
    } else this.airTime += dt;
    if (this.map && p.y < this.map.killY) this.fell = true;
  }

  /** Takes out of the velocity what goes into a wall. */
  private clip(wall: Vector3): void {
    const v = this.velocity;
    const nl = Math.hypot(wall.x, wall.z);
    if (nl < 1e-6) return;
    const nx = wall.x / nl, nz = wall.z / nl;
    const into = v.x * nx + v.z * nz;
    if (into < 0) {
      v.x -= nx * into;
      v.z -= nz * into;
    }
  }

  /** From `start`: up by a step, over by `flat`, down again. Where that ends, if it ends on ground higher than it began. */
  private tryStep(start: Vector3, flat: Vector3): Vector3 | null {
    const q = start.clone();
    const up = this.sweep(q, UP, MOVE.stepUp);
    const rise = up ? up.distance : MOVE.stepUp;
    if (rise < 0.02) return null;
    q.y += rise;
    this.slide(q, flat.clone(), true);
    const down = this.sweep(q, tmp.set(0, -1, 0).clone(), rise + MOVE.stepDown);
    // It must end on ground, and on ground no higher than a step (its lip counts as the surface it belongs to).
    const top = down ? this.floor(down) : null;
    if (!down || top === null || top - (start.y - MOVE.skin) > MOVE.stepUp + 0.005) return null;
    q.y -= down.distance;
    return q.y > start.y + 0.01 ? q : null;
  }
}

/** Quake's acceleration: toward the wish direction, never past the wish speed along it. */
function accelerate(v: Vector3, wx: number, wz: number, wish: number, accel: number, dt: number): void {
  const l = Math.hypot(wx, wz);
  if (l < 1e-6 || wish <= 0) return;
  const dx = wx / l, dz = wz / l;
  const add = wish - (v.x * dx + v.z * dz);
  if (add <= 0) return;
  const a = Math.min(accel * dt * wish, add);
  v.x += dx * a;
  v.z += dz * a;
}
