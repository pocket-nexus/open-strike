// Practice: the match when there is no room (no network, no platform, a room this copy of the game cannot join).
// The same map, the same weapon table and the room's rules run here: a few bots that wander their part of the map,
// turn to the player when they see them and shoot, not very well. Damage, deaths, respawns, the score and the rounds
// follow the numbers a room would use (config.ts), so the HUD and the game are driven exactly as online.
import { Raycaster, Shapecaster, Vector3 } from "@threert/scene";
import { FLAG, RULES, TEAM, WEAPONS, damageAt, type Mode, type WeaponDef, type Zone } from "./config.ts";
import type { AnyMap } from "./maps/index.ts";
import type { Actor, Match, Source } from "./match.ts";
import type { V3 } from "./vec.ts";
import { push } from "./soldiers.ts";

const NAMES = ["Vega", "Moss", "Kite", "Juno", "Rook", "Orin", "Tamsin", "Bly"];
const WALK = 2.7;

interface Bot {
  actor: Actor;
  at: Vector3;
  yaw: number;
  pitch: number;
  heading: number;         // where it walks, radians (as a yaw)
  turnIn: number;          // s until it picks another way
  respawnAt: number;       // match time, ms
  look: number;            // s until it looks for the player again
  sees: boolean;
  shootIn: number;
  moving: number;
  staged?: number[];
}

export class Practice implements Source {
  private clock = 0;
  private started = false;
  private readonly bots: Bot[] = [];
  private readonly mine = new Vector3(0, -100, 0);
  private mineCrouched = false;
  private readonly ray = new Raycaster();
  private readonly feeler = new Shapecaster({ type: "sphere", radius: 0.28 });
  private seed = 12345;
  private readonly match: Match;
  private readonly map: () => AnyMap;
  private readonly count: number;
  /** The bots stand where they spawn and do not shoot: targets. */
  private passive: boolean;

  constructor(match: Match, map: () => AnyMap, mode: Mode, bots: number, passive = false) {
    this.match = match;
    this.map = map;
    this.count = Math.max(0, Math.min(8, bots));
    this.passive = passive;
    match.mode = mode;
    match.rules = { ...RULES[mode] };
    match.weapons = WEAPONS;
  }

  private random(): number {
    this.seed = (Math.imul(this.seed, 1664525) + 1013904223) >>> 0;
    return this.seed / 4294967296;
  }

  time(): number {
    return this.clock;
  }

  private begin(): void {
    const m = this.match;
    m.me.id = 1;
    m.me.team = m.mode === "tdm" ? "ember" : null;
    m.hooks.weapons(WEAPONS);
    for (let i = 0; i < this.count; i++) {
      const actor = m.enter(2 + i, NAMES[i % NAMES.length]!);
      if (!actor) break;
      actor.team = m.mode === "tdm" ? "azure" : null;
      actor.soldier.team = actor.team;
      const bot: Bot = { actor, at: new Vector3(), yaw: 0, pitch: 0, heading: 0, turnIn: 0, respawnAt: 0, look: 0, sees: false, shootIn: 1, moving: 1 };
      this.bots.push(bot);
      this.place(bot);
    }
    this.newRound(1);
    m.hooks.spawn("join");
  }

  private newRound(n: number): void {
    const m = this.match;
    m.round = { n, phase: "live", end: m.rules.roundTime ? this.clock + m.rules.roundTime : 0 };
    m.score = m.mode === "tdm" ? { ember: 0, azure: 0 } : {};
    m.me.kills = m.me.deaths = 0;
    m.me.alive = true;
    m.me.health = m.rules.health;
    m.me.protectedUntil = this.clock + m.rules.protect;
    for (const b of this.bots) {
      b.actor.kills = b.actor.deaths = 0;
      this.place(b);
    }
  }

  /** A bot at one of its side's spawns, alive. */
  private place(b: Bot): void {
    const side = b.actor.team ? TEAM[b.actor.team].side : "any";
    const all = this.map().spawns;
    const own = all.filter((s) => s.team === side);
    const list = own.length ? own : all;
    // (Bots of a team match also start out in the lanes, so there is something to shoot at once.)
    const free = all.filter((s) => s.team === "any");
    const pool = side !== "any" && free.length && this.random() < 0.6 ? free : list;
    const s = pool[Math.floor(this.random() * pool.length)]!;
    b.at.set(s.position[0], s.position[1], s.position[2]);
    b.yaw = b.heading = s.yaw;
    b.pitch = 0;
    b.turnIn = 0.5 + this.random() * 2;
    b.actor.alive = true;
    b.actor.health = this.match.rules.health;
    b.actor.soldier.dead = -1;
    b.sees = false;
    b.shootIn = 1 + this.random();
  }

  update(_now: number, dt: number): void {
    const m = this.match;
    this.clock += dt * 1000;
    if (!this.started) {
      this.started = true;
      this.begin();
    }
    const t = this.clock;
    // The round: its time, its score, and the next one.
    if (m.round.phase === "live") {
      const { mine, theirs, limit } = m.standing();
      const top = Math.max(mine, theirs);
      if ((limit > 0 && top >= limit) || (m.round.end && t >= m.round.end)) {
        const winner = mine === theirs ? undefined : m.mode === "tdm" ? (mine > theirs ? "ember" : "azure") : mine > theirs ? m.me.id : [...m.actors.values()].sort((a, b) => b.kills - a.kills)[0]?.id;
        m.round = { n: m.round.n, phase: "over", end: t + m.rules.intermission, ...(winner !== undefined ? { winner } : {}) };
      }
    } else if (m.round.phase === "over" && t >= m.round.end) {
      this.newRound(m.round.n + 1);
      m.hooks.spawn("round");
    }
    if (!m.me.alive && m.round.phase === "live" && t >= m.me.respawnAt) {
      m.me.alive = true;
      m.me.health = m.rules.health;
      m.me.protectedUntil = t + m.rules.protect;
      m.hooks.spawn("respawn");
    }
    for (const b of this.bots) this.think(b, dt);
  }

  private think(b: Bot, dt: number): void {
    const m = this.match, a = b.actor, t = this.clock;
    if (!a.alive) {
      a.soldier.dead += dt;
      if (m.round.phase === "live" && t >= b.respawnAt) this.place(b);
      else {
        a.pose = [b.at.x, b.at.y, b.at.z, b.yaw, 0, 0, 0, 0];
        return;
      }
    }
    if (this.passive) {
      a.pose = b.staged ?? [b.at.x, b.at.y, b.at.z, b.yaw, 0, 0, 0, 0];
      return;
    }
    // Does it see the player? (Looked at four times a second: a ray from its eyes to the player's chest.)
    b.look -= dt;
    const to = new Vector3(this.mine.x - b.at.x, this.mine.y + (this.mineCrouched ? 0.8 : 1.2) - (b.at.y + 1.6), this.mine.z - b.at.z);
    const far = to.length();
    if (b.look <= 0) {
      b.look = 0.25;
      b.sees = false;
      if (m.me.alive && far < 45 && far > 0.01) {
        this.ray.set(new Vector3(b.at.x, b.at.y + 1.6, b.at.z), to.clone().multiplyScalar(1 / far));
        this.ray.far = far;
        b.sees = this.ray.intersectPhysics().length === 0;
      }
    }
    let speed = 0;
    if (b.sees) {
      // Face the player (it turns at a human rate), stand or sidestep, and fire.
      const want = Math.atan2(-to.x, -to.z);
      let d = want - b.yaw;
      d -= Math.PI * 2 * Math.round(d / (Math.PI * 2));
      b.yaw += Math.max(-4 * dt, Math.min(4 * dt, d));
      b.pitch += (Math.asin(Math.max(-1, Math.min(1, to.y / far))) - b.pitch) * Math.min(1, dt * 6);
      b.shootIn -= dt;
      if (b.shootIn <= 0 && Math.abs(d) < 0.25 && m.round.phase === "live") {
        b.shootIn = 0.55 + this.random() * 0.9;
        this.shoot(b, far);
      }
      b.heading = b.yaw + (Math.sin(t / 900 + a.id) > 0 ? Math.PI / 2 : -Math.PI / 2);
      speed = WALK * 0.6 * b.moving;
    } else {
      b.turnIn -= dt;
      if (b.turnIn <= 0) {
        b.turnIn = 1.5 + this.random() * 3;
        b.heading += (this.random() - 0.5) * 2.4;
        b.moving = this.random() < 0.15 ? 0 : 1;
      }
      let d = b.heading - b.yaw;
      d -= Math.PI * 2 * Math.round(d / (Math.PI * 2));
      b.yaw += Math.max(-3 * dt, Math.min(3 * dt, d));
      b.pitch += (0 - b.pitch) * Math.min(1, dt * 4);
      speed = WALK * b.moving;
    }
    // Walk: stop at what is in the way and at edges, follow the floor.
    if (speed > 0) {
      const dir = new Vector3(-Math.sin(b.heading), 0, -Math.cos(b.heading));
      const step = speed * dt;
      this.feeler.set(new Vector3(b.at.x, b.at.y + 0.75, b.at.z));
      this.feeler.far = step + 0.45;
      const wall = this.feeler.sweep(dir);
      let ok = !wall;
      if (ok) {
        this.ray.set(new Vector3(b.at.x + dir.x * (step + 0.3), b.at.y + 0.9, b.at.z + dir.z * (step + 0.3)), new Vector3(0, -1, 0));
        this.ray.far = 1.6;
        const floor = this.ray.intersectPhysics()[0];
        if (floor) {
          b.at.x += dir.x * step;
          b.at.z += dir.z * step;
          b.at.y += (floor.point.y - b.at.y) * Math.min(1, dt * 12);
        } else ok = false;
      }
      if (!ok) {
        b.heading += Math.PI * (0.6 + this.random() * 0.8);
        b.turnIn = 1 + this.random() * 2;
        speed = 0;
      }
    }
    a.pose = [b.at.x, b.at.y, b.at.z, b.yaw, b.pitch, speed, b.sees && b.shootIn > 0.4 ? FLAG.firing : 0, 0];
  }

  /** A bot's shot at the player: it lands now and then, less often far away and on a moving or crouched player. */
  private shoot(b: Bot, far: number): void {
    const m = this.match, w = WEAPONS.carbine!;
    let chance = Math.max(0.06, Math.min(0.42, 0.5 - far * 0.012));
    if (this.mineCrouched) chance *= 0.7;
    const hit = this.random() < chance && this.clock >= m.me.protectedUntil;
    const aim: V3 = [this.mine.x + (hit ? 0 : (this.random() - 0.5) * 2.2), this.mine.y + 1.1 + (hit ? 0 : (this.random() - 0.3) * 1.6), this.mine.z + (hit ? 0 : (this.random() - 0.5) * 2.2)];
    m.hooks.shot(b.actor, { weapon: w.id, ends: [aim] });
    if (!hit) return;
    const amount = Math.min(m.me.health, damageAt(w, this.random() < 0.08 ? "head" : this.random() < 0.3 ? "limb" : "body", far) >> 1);
    m.me.health -= amount;
    m.hooks.hurt(amount, [b.at.x, b.at.y, b.at.z]);
    if (m.me.health <= 0) this.down(b.actor, w.id);
  }

  /** The player dies. */
  private down(by: Actor | null, weapon: string): void {
    const m = this.match;
    if (!m.me.alive) return;
    m.me.alive = false;
    m.me.health = 0;
    m.me.deaths++;
    m.me.respawnAt = this.clock + m.rules.respawn;
    if (by) {
      by.kills++;
      if (by.team) m.score[by.team] = (m.score[by.team] ?? 0) + 1;
      m.say(`${by.name}  ›  ${m.me.name}   ${WEAPONS[weapon]?.title ?? weapon}`, "bad");
    } else m.say(`${m.me.name} fell`, "bad");
    m.hooks.died(by, weapon);
  }

  /**
   * Puts the bots where a picture or a test wants them, standing still: one entry a bot ({ at, yaw, pitch?, flags?,
   * speed?, weapon?, team?, fire?: a point it shoots at now }).
   */
  stage(list: { at: V3; yaw: number; pitch?: number; flags?: number; speed?: number; weapon?: number; team?: "ember" | "azure"; fire?: V3; die?: Zone }[]): void {
    this.passive = true;
    this.bots.forEach((b, i) => {
      const s = list[i];
      if (s?.die) {
        // Shot dead now, by the player, where it stands (and it stays down).
        const a = b.actor;
        a.alive = false;
        a.soldier.dead = 0;
        a.soldier.blow = { from: [this.mine.x, this.mine.y + 1.4, this.mine.z], zone: s.die, push: push(["carbine", "shotgun", "marksman"][s.weapon ?? 0]!) };
        b.respawnAt = Infinity;
        return;
      }
      if (!s) { b.at.set(0, -150, 0); b.yaw = 0; b.staged = [0, -150, 0, 0, 0, 0, 0, 0]; return; }
      if (!b.actor.alive) { b.actor.alive = true; b.actor.health = this.match.rules.health; b.actor.soldier.dead = -1; }
      b.at.set(s.at[0], s.at[1], s.at[2]);
      b.yaw = s.yaw;
      b.staged = [s.at[0], s.at[1], s.at[2], s.yaw, s.pitch ?? 0, s.speed ?? 0, s.flags ?? 0, s.weapon ?? 0];
      if (s.team) { b.actor.team = s.team; b.actor.soldier.team = s.team; }
      if (s.speed) b.actor.soldier.stride = 1.1 + i;
      if (s.fire) this.match.hooks.shot(b.actor, { weapon: ["carbine", "shotgun", "marksman"][s.weapon ?? 0]!, ends: [s.fire] });
    });
  }

  pose(pose: number[]): void {
    this.mine.set(pose[0]!, pose[1]!, pose[2]!);
    this.mineCrouched = ((pose[6] ?? 0) & FLAG.crouch) !== 0;
  }

  fire(): number {
    this.match.me.protectedUntil = 0;
    return this.clock;
  }

  claim(_shotTime: number, weapon: WeaponDef, actor: Actor, zone: Zone, _point: V3, distance: number): void {
    const m = this.match;
    const b = this.bots.find((x) => x.actor === actor);
    if (!b || !actor.alive || m.round.phase !== "live" || !m.me.alive) return;
    const amount = Math.min(actor.health, damageAt(weapon, zone, distance));
    actor.health -= amount;
    const killed = actor.health <= 0;
    if (killed) {
      actor.alive = false;
      actor.deaths++;
      actor.soldier.dead = 0;
      actor.soldier.blow = { from: [this.mine.x, this.mine.y + (this.mineCrouched ? 1.0 : 1.4), this.mine.z], zone, push: push(weapon.id) };
      b.respawnAt = this.clock + m.rules.respawn;
      m.me.kills++;
      if (m.me.team) m.score[m.me.team] = (m.score[m.me.team] ?? 0) + 1;
      m.say(`${m.me.name}  ›  ${actor.name}   ${weapon.title}${zone === "head" ? " · headshot" : ""}`, "accent");
    } else {
      // It was hit: it turns to where it came from.
      b.sees = true;
      b.look = 0.6;
    }
    m.hooks.confirmed(actor, amount, zone, killed);
  }

  reload(): void {}

  die(_cause: string): void {
    this.down(null, "world");
  }

  leave(): void {
    for (const b of this.bots) this.match.exit(b.actor.id);
    this.bots.length = 0;
  }
}
