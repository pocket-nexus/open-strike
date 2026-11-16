// The weapons in the player's hands: which one is up, its magazine and reserve, the reload, the sights, the spread
// (which opens with movement, in the air and with every shot) and the recoil (a kick of the view that mostly comes
// back). It decides when a shot leaves and in which direction relative to the view; what the shot hits is the game's
// business (game.ts: the ray against the map and the other players).
//
// Time here is the simulation's (seconds since the match began on this client). Shots are timed inside a frame, so
// the rate of fire is the table's at any frame rate.
import { LOADOUT, WEAPONS, type WeaponDef } from "./config.ts";

export interface FireInput {
  /** The trigger is held; it went down this frame. */
  trigger: boolean;
  pressed: boolean;
  ads: boolean;
  reload: boolean;
  /** A weapon chosen by its key (0..n-1), or null; wheel notches (positive: the next weapon). */
  select: number | null;
  wheel: number;
}

/** What the body is doing, for the spread. */
export interface Stance {
  speed: number;        // m/s on the ground plane
  runSpeed: number;     // the speed that counts as running flat out
  grounded: boolean;
  crouched: boolean;
  sprinting: boolean;
}

export interface Shot {
  weapon: WeaponDef;
  /** Simulation time of the shot, s. */
  at: number;
  /** One direction a pellet, as angles off the view's axis (radians: right, up). */
  pellets: [number, number][];
  /** The magazine was emptied by it. */
  last: boolean;
  /** Where the view was off the player's aim as it left (radians: up, left): the kick of the shots before it, not its own. */
  off: [number, number];
}

export interface Slot {
  def: WeaponDef;
  ammo: number;
  reserve: number;
  /** It cannot fire before this (a reload the room is still counting: config.ts, README "Netcode"). */
  blockedUntil: number;
}

function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Arsenal {
  readonly slots: Slot[];
  current = 0;
  /** Simulation time, s. */
  clock = 0;
  /** 0 from the hip .. 1 sights up. */
  ads = 0;
  /** Seconds left of the reload (0: none), and of raising the weapon after a switch. */
  reloading = 0;
  drawing = 0;
  /** The spread the shots have added, radians. */
  bloom = 0;
  /** The view's offset from where the player aims, radians (it decays: the recoil that comes back). */
  kickPitch = 0;
  kickYaw = 0;
  /** Recoil that does not come back: the game adds it to the player's aim and zeroes it. */
  climbPitch = 0;
  climbYaw = 0;
  /** When the last shot left (s); how many in the current burst. */
  lastShot = -10;
  burst = 0;
  /** Called when a reload starts by the player's hand (not the one an empty magazine starts): the room is told. */
  onReload: ((def: WeaponDef, at: number) => void) | null = null;
  /** Sounds: "dry", "reload", "reloaded", "switch", "ads". */
  onSound: ((name: string) => void) | null = null;

  private nextFire = 0;
  private wanted = 0;                   // a press of a semi-automatic's trigger waits this long for the weapon, s
  private pending: number | null = null;
  private readonly random: () => number;

  constructor(seed = 1, table: Record<string, WeaponDef> = WEAPONS) {
    this.random = mulberry(seed);
    this.slots = LOADOUT.map((id) => ({ def: table[id]!, ammo: table[id]!.mag, reserve: table[id]!.reserve, blockedUntil: 0 }));
  }

  get slot(): Slot {
    return this.slots[this.current]!;
  }
  get def(): WeaponDef {
    return this.slot.def;
  }

  /** Full magazines and reserves, nothing in progress (a new round). */
  reset(): void {
    for (const s of this.slots) { s.ammo = s.def.mag; s.reserve = s.def.reserve; s.blockedUntil = 0; }
    this.settle();
  }

  /** Nothing in progress: no reload, no kick, sights down (a respawn). */
  settle(): void {
    this.reloading = 0;
    this.drawing = 0.25;
    this.ads = 0;
    this.bloom = 0;
    this.kickPitch = this.kickYaw = this.climbPitch = this.climbYaw = 0;
    this.pending = null;
    this.wanted = 0;
    this.burst = 0;
  }

  /**
   * The player died: every magazine that is not full is reloaded while it waits (the room is told, and counts the
   * reload's time from now: a weapon may still be blocked for a moment after a quick respawn), and the reserve is
   * what a fresh spawn carries.
   */
  restock(): void {
    for (const s of this.slots) {
      if (s.ammo < s.def.mag) {
        s.ammo = s.def.mag;
        s.blockedUntil = Math.max(s.blockedUntil, this.clock + s.def.reload / 1000);
        this.onReload?.(s.def, this.clock);
      }
      s.reserve = s.def.reserve;
    }
    this.reloading = 0;
  }

  /** The cone's half angle now, radians. */
  spread(st: Stance): number {
    const sp = this.def.spread;
    let a = sp.hip + (sp.ads - sp.hip) * this.ads;
    a += sp.move * Math.min(1, st.speed / st.runSpeed) * (1 - 0.7 * this.ads);
    if (!st.grounded) a += sp.air;
    a += this.bloom;
    if (st.crouched && st.grounded) a *= sp.crouch;
    return a;
  }

  private startReload(byHand: boolean): boolean {
    const s = this.slot;
    if (this.reloading > 0 || s.ammo >= s.def.mag || s.reserve <= 0) return false;
    this.reloading = s.def.reload / 1000;
    this.onSound?.("reload");
    if (byHand) this.onReload?.(s.def, this.clock);
    return true;
  }

  private select(index: number): void {
    if (index === this.current || index < 0 || index >= this.slots.length) return;
    // A reload under way is lost to the player (the magazine stays as it was), but not to the room, which has been
    // told and counts it: this weapon cannot fire before the reload would have ended.
    if (this.reloading > 0) this.slot.blockedUntil = Math.max(this.slot.blockedUntil, this.clock + this.reloading);
    this.reloading = 0;
    this.current = index;
    this.drawing = this.def.draw;
    this.bloom = 0;
    this.burst = 0;
    this.wanted = 0;
    this.onSound?.("switch");
  }

  /** A frame of `dt` seconds. Returns the shots that left during it, in order. */
  update(dt: number, input: FireInput, st: Stance): Shot[] {
    const t0 = this.clock, t1 = t0 + dt;
    this.clock = t1;
    const shots: Shot[] = [];

    if (input.select !== null) this.pending = input.select;
    if (input.wheel !== 0) this.pending = (((this.pending ?? this.current) + (input.wheel > 0 ? 1 : -1)) % this.slots.length + this.slots.length) % this.slots.length;
    if (this.pending !== null) {
      this.select(this.pending);
      this.pending = null;
    }
    const s = this.slot, w = s.def;

    this.drawing = Math.max(0, this.drawing - dt);
    if (this.reloading > 0) {
      this.reloading -= dt;
      if (this.reloading <= 0) {
        this.reloading = 0;
        const take = Math.min(w.mag - s.ammo, s.reserve);
        s.ammo += take;
        s.reserve -= take;
        this.onSound?.("reloaded");
      }
    }
    if (input.reload) this.startReload(true);

    // The sights: up while the button is held and the hands are free.
    const up = input.ads && this.reloading === 0 && this.drawing === 0 && !st.sprinting;
    const rate = dt / w.adsTime;
    this.ads = up ? Math.min(1, this.ads + rate) : Math.max(0, this.ads - rate * 1.3);

    // The trigger. An automatic fires while it is held; a semi-automatic once a press, and a press a moment early
    // still counts (it waits up to 0.15 s for the weapon to be ready).
    if (input.pressed) this.wanted = 0.15;
    else this.wanted = Math.max(0, this.wanted - dt);
    const pulling = w.auto ? input.trigger : this.wanted > 0;
    const interval = 60 / w.rpm;
    if (pulling && !st.sprinting && this.drawing === 0 && this.reloading === 0) {
      let at = Math.max(this.nextFire, s.blockedUntil, t0);
      while (at <= t1 && s.ammo > 0) {
        s.ammo--;
        const cone = this.spread(st);
        const pellets: [number, number][] = [];
        for (let i = 0; i < w.pellets; i++) {
          // Uniform over the cone's disc.
          const r = cone * Math.sqrt(this.random()), a = this.random() * Math.PI * 2;
          pellets.push([r * Math.cos(a), r * Math.sin(a)]);
        }
        shots.push({ weapon: w, at, pellets, last: s.ammo === 0, off: [this.kickPitch + this.climbPitch, this.kickYaw + this.climbYaw] });
        // The kick: up, and to a side that leans one way for a few shots, then the other.
        const scale = 1 - (1 - w.recoil.ads) * this.ads;
        const lean = Math.sin(this.burst * 0.7) * 0.6;
        const kp = w.recoil.up * scale * (0.85 + 0.3 * this.random());
        const ky = w.recoil.side * scale * (lean + (this.random() * 2 - 1) * 0.7);
        this.kickPitch += kp * w.recoil.recover;
        this.kickYaw += ky * w.recoil.recover;
        this.climbPitch += kp * (1 - w.recoil.recover);
        this.climbYaw += ky * (1 - w.recoil.recover);
        this.bloom = Math.min(w.spread.bloomMax, this.bloom + w.spread.bloom);
        this.burst++;
        this.lastShot = at;
        this.nextFire = at + interval;
        this.wanted = 0;
        if (!w.auto) break;
        at = this.nextFire;
      }
      if (s.ammo === 0 && shots.length === 0 && input.pressed) this.onSound?.("dry");
      // An empty magazine reloads itself (the room starts counting that reload at the shot that emptied it).
      if (s.ammo === 0 && s.reserve > 0) this.startReload(false);
    }

    // The recoil that comes back, the bloom that closes, the burst that ends.
    const k = Math.exp(-w.recoil.rate * dt);
    this.kickPitch *= k;
    this.kickYaw *= k;
    if (t1 - this.lastShot > interval * 1.5) {
      this.bloom = Math.max(0, this.bloom - w.spread.bloomDecay * dt);
      if (t1 - this.lastShot > 0.35) this.burst = 0;
    }
    return shots;
  }
}
