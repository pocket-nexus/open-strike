// The numbers of the game in one place. The weapon table and the match rules here are what a room is created with
// (`meta.rules`, read by the platform's `fps` rules module), so the client and the room agree on damage, zones,
// falloff, rate of fire, magazines and reload times. What only the client needs (spread, recoil, handling) sits
// beside them in the same table and is left out of what the room gets.

/** The app's name on the platform (rooms are opened under it). */
export const APP = "openstrike";
export const VERSION = "0.1.0";
/** The platform, unless `host.launch.api` (or the manifest's `platform.rooms`) says otherwise. */
export const ENDPOINT = "https://threert.app";
/** A private room's link. */
export const inviteLink = (code: string) => `https://openstrike.threert.app/#room=${code}`;
export const MAX_PLAYERS = 10;

export type Mode = "tdm" | "dm";
export type Zone = "head" | "body" | "limb";

/** The two teams, as the room names them, and the map's side each spawns on (MapSpawn.team). */
export const TEAMS = ["ember", "azure"] as const;
export type Team = (typeof TEAMS)[number];
export const TEAM: Record<Team, { title: string; side: "a" | "b"; color: number; glow: [number, number, number] }> = {
  ember: { title: "Ember", side: "a", color: 0xd9541e, glow: [1.0, 0.36, 0.08] },
  azure: { title: "Azure", side: "b", color: 0x1f7fd9, glow: [0.1, 0.5, 1.0] },
};

// ---- movement (metres, seconds) ----

export const MOVE = {
  /** The simulation's step: the frame script may run at any rate, the player always moves in these. */
  step: 1 / 120,
  radius: 0.3,
  height: 1.8,
  crouchHeight: 1.2,
  eye: 1.64,
  crouchEye: 1.04,
  /** How fast the eyes move between the two, m/s. */
  crouchRate: 5,
  run: 4.8,
  sprint: 6.6,
  crouch: 2.4,
  /** Speed with the sights up, as a share of `run`. */
  adsSpeed: 0.6,
  /** Ground acceleration (1/s: speed gained per second per m/s of wish speed) and friction. */
  accel: 11,
  friction: 9,
  /** Below this speed friction acts as if at it: a player stops instead of crawling. */
  stopSpeed: 1.6,
  /** Air control: acceleration, and the wish speed it is capped at (the classic strafe-jump feel, kept small). */
  airAccel: 14,
  airSpeed: 0.9,
  gravity: 17,
  jump: 5.45,           // 0.874 m: v² / 2g
  /** Ledges up to this are walked over; ground within it under a walking player is stepped down to. */
  stepUp: 0.45,
  stepDown: 0.35,
  /** A surface is ground when its normal's y is at least this (about 46 degrees). */
  ground: 0.69,
  ladder: 3.2,
  /** How close a sweep lets the capsule come to a surface. */
  skin: 0.015,
} as const;

// ---- weapons ----

export interface WeaponDef {
  id: string;
  title: string;
  /** Held down, it keeps firing. */
  auto: boolean;
  // What the room checks (the `fps` module's Weapon):
  damage: number;                         // a pellet's, point-blank, on a zone of multiplier 1
  zones: Record<Zone, number>;
  range: number;                          // m
  falloff: { start: number; end: number; min: number };
  rpm: number;
  mag: number;
  reload: number;                         // ms
  pellets: number;
  // The client's own:
  reserve: number;                        // rounds carried beyond the magazine (refilled at a respawn)
  /** Half angles of the cone, radians: at rest from the hip, with the sights up; added at full run speed, in the
   *  air; times `crouch` when crouched; `bloom` added per shot up to `bloomMax`, decaying at `bloomDecay` a second. */
  spread: { hip: number; ads: number; move: number; air: number; crouch: number; bloom: number; bloomMax: number; bloomDecay: number };
  /** The view's kick per shot, radians: up, and to a side (random within ±side, biased by the pattern); the share
   *  of it that comes back and how fast (1/s); the kick's scale with the sights up. */
  recoil: { up: number; side: number; recover: number; rate: number; ads: number };
  /** Field of view with the sights up (degrees), and the time to bring them up (s). */
  adsFov: number;
  adsTime: number;
  /** A scope: the weapon is hidden behind a reticle at full ADS. */
  scoped: boolean;
  /** Time to raise it after a switch, s. */
  draw: number;
  /** Run speed with it in hand, as a share. */
  mobility: number;
  /** The first-person pose: where the grip sits relative to the eye from the hip (m: right, up, forward). */
  hip: [number, number, number];
}

const ZONES: Record<Zone, number> = { head: 4, body: 1, limb: 0.75 };

export const WEAPONS: Record<string, WeaponDef> = {
  carbine: {
    id: "carbine", title: "VK-5 Carbine", auto: true,
    damage: 26, zones: ZONES, range: 120, falloff: { start: 22, end: 70, min: 0.62 }, rpm: 660, mag: 30, reload: 2300, pellets: 1,
    reserve: 120,
    spread: { hip: 0.011, ads: 0.0012, move: 0.022, air: 0.06, crouch: 0.65, bloom: 0.0026, bloomMax: 0.022, bloomDecay: 0.05 },
    recoil: { up: 0.0105, side: 0.0045, recover: 0.6, rate: 7, ads: 0.75 },
    adsFov: 52, adsTime: 0.18, scoped: false, draw: 0.42, mobility: 1, hip: [0.118, -0.137, 0.31],
  },
  shotgun: {
    id: "shotgun", title: "M12 Breacher", auto: false,
    damage: 13, zones: { head: 1.5, body: 1, limb: 0.75 }, range: 32, falloff: { start: 6, end: 22, min: 0.25 }, rpm: 72, mag: 7, reload: 2700, pellets: 9,
    reserve: 28,
    spread: { hip: 0.048, ads: 0.036, move: 0.008, air: 0.02, crouch: 0.9, bloom: 0, bloomMax: 0, bloomDecay: 1 },
    recoil: { up: 0.07, side: 0.012, recover: 0.8, rate: 5, ads: 0.9 },
    adsFov: 62, adsTime: 0.2, scoped: false, draw: 0.5, mobility: 0.97, hip: [0.122, -0.132, 0.33],
  },
  marksman: {
    id: "marksman", title: "LR-9 Marksman", auto: false,
    damage: 64, zones: ZONES, range: 220, falloff: { start: 60, end: 160, min: 0.85 }, rpm: 170, mag: 10, reload: 2900, pellets: 1,
    reserve: 40,
    spread: { hip: 0.03, ads: 0.0003, move: 0.045, air: 0.09, crouch: 0.6, bloom: 0.006, bloomMax: 0.02, bloomDecay: 0.03 },
    recoil: { up: 0.034, side: 0.008, recover: 0.75, rate: 5.5, ads: 0.8 },
    adsFov: 19, adsTime: 0.26, scoped: true, draw: 0.6, mobility: 0.92, hip: [0.118, -0.142, 0.31],
  },
};
/** Keys 1, 2, 3 and the wheel go through these in order. */
export const LOADOUT = ["carbine", "shotgun", "marksman"] as const;
/** The model each weapon is drawn with (assets/weapons/<model>.glb, src/weapons/meta.json). */
export const WEAPON_MODEL: Record<string, string> = { carbine: "carbine", shotgun: "shotgun", marksman: "dmr" };

// ---- the match ----

export interface Rules {
  health: number;
  respawn: number;          // ms
  protect: number;          // ms
  scoreLimit: number;
  roundTime: number;        // ms
  intermission: number;     // ms
}

export const RULES: Record<Mode, Rules> = {
  tdm: { health: 100, respawn: 3500, protect: 1500, scoreLimit: 30, roundTime: 420_000, intermission: 10_000 },
  dm: { health: 100, respawn: 2500, protect: 1500, scoreLimit: 20, roundTime: 420_000, intermission: 10_000 },
};

/** How the hit volumes of a soldier are drawn around its pose (the feet): what the room needs to know of them. */
export const BODY = { radius: 0.5, height: 1.85, origin: 0, head: 0.42 } as const;

/** A room's `meta.rules`: the `fps` module's settings (@threert/net's README). `over` changes a few (tests, a custom room). */
export function roomRules(mode: Mode, over: Partial<Rules> = {}): Record<string, unknown> {
  const weapons: Record<string, unknown> = {};
  for (const w of Object.values(WEAPONS)) weapons[w.id] = { damage: w.damage, zones: w.zones, range: w.range, falloff: w.falloff, rpm: w.rpm, mag: w.mag, reload: w.reload, pellets: w.pellets };
  return { ...RULES[mode], ...over, friendlyFire: false, teams: [...TEAMS], body: { ...BODY }, weapons };
}

/** Damage of one pellet at `distance` m on `zone` (the room's formula, for practice and for the client's guess). */
export function damageAt(w: Pick<WeaponDef, "damage" | "zones" | "falloff">, zone: Zone, distance: number): number {
  const f = w.falloff;
  const fall = distance <= f.start ? 1 : distance >= f.end ? f.min : 1 - (1 - f.min) * ((distance - f.start) / (f.end - f.start));
  return Math.max(1, Math.round(w.damage * w.zones[zone] * fall));
}

/** The pose a player sends (an array: the room interpolates numbers): indices. */
export const POSE = { x: 0, y: 1, z: 2, yaw: 3, pitch: 4, speed: 5, flags: 6, weapon: 7 } as const;
export const FLAG = { crouch: 1, firing: 2, air: 4, ads: 8, reload: 16, sprint: 32 } as const;
