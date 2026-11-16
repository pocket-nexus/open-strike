// The match: who is in it, on which side, with how much health, the score and the round. It has two sources:
//
// - a room of the platform (`@threert/net`, its README) under the `fps` rules module: the room is the
//   authority. This client sends its pose, its shots and the hits it claims; health, deaths, respawns, the score and
//   the rounds come back as shared state and events, and are shown as they come (net.ts);
// - practice (practice.ts): the same rules run here, against a few bots, when there is no room to play in.
//
// The game (game.ts) reads the match and is told of the moments that matter through `hooks`.
import { RULES, TEAMS, WEAPONS, type Mode, type Rules, type Team, type WeaponDef, type Zone } from "./config.ts";
import type { AnyMap } from "./maps/index.ts";
import { newSoldier, SLOTS, type SoldierState } from "./soldiers.ts";
import type { V3 } from "./vec.ts";

export interface Actor {
  id: number;
  name: string;
  team: Team | null;
  alive: boolean;
  health: number;
  kills: number;
  deaths: number;
  soldier: SoldierState;
  /** The pose to draw it at (interpolated), or null before the first one. */
  pose: ArrayLike<number> | null;
}

export interface Me {
  id: number;
  name: string;
  team: Team | null;
  alive: boolean;
  health: number;
  kills: number;
  deaths: number;
  /** Match time (ms) of the respawn while dead, and until which nothing hurts after a spawn. */
  respawnAt: number;
  protectedUntil: number;
}

export interface Round {
  n: number;
  phase: "waiting" | "live" | "over";
  /** Match time (ms) the phase ends at; 0: it does not. */
  end: number;
  winner?: number | string;
}

export interface FeedLine { id: string; text: string; tone: "default" | "good" | "bad" | "accent" | "dim" }

/** A shot someone else fired, as it is shown: from the muzzle to where each pellet ended. */
export interface RemoteShot { weapon: string; ends: V3[] }

/** What the game does at the match's moments. */
export interface Hooks {
  /** The player is (again) in the world: a join, a respawn, a new round. */
  spawn(why: "join" | "respawn" | "round"): void;
  died(by: Actor | null, weapon: string): void;
  /** Hit for `amount`, from `from` (where the shooter stood), if known. */
  hurt(amount: number, from: V3 | null): void;
  /** A hit this client claimed was taken. */
  confirmed(target: Actor | null, amount: number, zone: string, killed: boolean): void;
  shot(actor: Actor, shot: RemoteShot): void;
  /** The match is played on this map (mount it if it is not the one mounted). */
  map(map: AnyMap): void;
  /** The weapon table the match is played with changed (a room's own rules). */
  weapons(table: Record<string, WeaponDef>): void;
}

/** Where the match's numbers come from: a room, or practice. */
export interface Source {
  /** Match time, ms. */
  time(): number;
  update(now: number, dt: number): void;
  pose(pose: number[]): void;
  /** A shot left `ago` seconds before now: tell the others. Returns its match time. */
  fire(weapon: WeaponDef, ago: number, muzzle: V3, ends: V3[]): number;
  /** A pellet of the shot at `shotTime` met `actor` in `zone` at `point`, `distance` metres out. */
  claim(shotTime: number, weapon: WeaponDef, actor: Actor, zone: Zone, point: V3, distance: number): void;
  reload(weapon: WeaponDef, ago: number): void;
  die(cause: string): void;
  leave(): void;
}

export type Status = "starting" | "searching" | "joining" | "online" | "reconnecting" | "practice";

export class Match {
  status: Status = "starting";
  /** What the player should know about how they got here ("Room full", "This room plays de_dust2 …"). */
  notice: string | null = null;
  mode: Mode = "tdm";
  rules: Rules = { ...RULES.tdm };
  weapons: Record<string, WeaponDef> = WEAPONS;
  /** The room's code and invitation, when there is one; whether it is listed. */
  code: string | null = null;
  link: string | null = null;
  listed = false;
  /** Round trip to the room, ms. */
  rtt = 0;
  readonly me: Me = { id: 0, name: "Player", team: null, alive: false, health: 0, kills: 0, deaths: 0, respawnAt: 0, protectedUntil: 0 };
  readonly actors = new Map<number, Actor>();
  round: Round = { n: 0, phase: "waiting", end: 0 };
  score: Record<string, number> = {};
  readonly feed: FeedLine[] = [];
  /** Hit claims the room refused, by reason (shown by the debug report; a healthy match has few). */
  readonly rejects: Record<string, number> = {};
  source: Source | null = null;
  hooks: Hooks;
  private lines = 0;
  private readonly free: number[] = [];

  constructor(hooks: Hooks) {
    this.hooks = hooks;
    for (let s = SLOTS - 1; s >= 1; s--) this.free.push(s);      // (slot 0 is the player's own body)
  }

  time(): number {
    return this.source?.time() ?? 0;
  }

  say(text: string, tone: FeedLine["tone"] = "default"): void {
    this.feed.push({ id: `f${++this.lines}`, text, tone });
    if (this.feed.length > 6) this.feed.shift();
  }

  nameOf(id: number): string {
    return id === this.me.id ? this.me.name : (this.actors.get(id)?.name ?? "someone");
  }

  teamOf(id: number): Team | null {
    return id === this.me.id ? this.me.team : (this.actors.get(id)?.team ?? null);
  }

  /** Adds someone to the match (or returns who is there under that id). Null when every body is taken. */
  enter(id: number, name: string): Actor | null {
    const known = this.actors.get(id);
    if (known) {
      known.name = name;
      return known;
    }
    const slot = this.free.pop();
    if (slot === undefined) return null;
    const actor: Actor = { id, name, team: null, alive: false, health: 0, kills: 0, deaths: 0, soldier: newSoldier(slot, null), pose: null };
    this.actors.set(id, actor);
    return actor;
  }

  exit(id: number): Actor | null {
    const a = this.actors.get(id);
    if (!a) return null;
    this.actors.delete(id);
    this.free.push(a.soldier.slot);
    return a;
  }

  /** Everyone gone, nothing known: before another source takes over. */
  clear(): void {
    for (const id of [...this.actors.keys()]) this.exit(id);
    this.me.id = 0;
    this.me.team = null;
    this.me.alive = false;
    this.me.health = 0;
    this.me.kills = this.me.deaths = 0;
    this.round = { n: 0, phase: "waiting", end: 0 };
    this.score = {};
    this.code = this.link = null;
    this.rtt = 0;
  }

  /** The scoreboard: everyone, best first; in a team match grouped by side. */
  board(): { id: number; name: string; team: Team | null; kills: number; deaths: number; alive: boolean; me: boolean }[] {
    const rows = [
      { id: this.me.id, name: this.me.name, team: this.me.team, kills: this.me.kills, deaths: this.me.deaths, alive: this.me.alive, me: true },
      ...[...this.actors.values()].map((a) => ({ id: a.id, name: a.name, team: a.team, kills: a.kills, deaths: a.deaths, alive: a.alive, me: false })),
    ];
    const side = (t: Team | null) => (t ? TEAMS.indexOf(t) : 9);
    return rows.sort((a, b) => side(a.team) - side(b.team) || b.kills - a.kills || a.deaths - b.deaths || a.id - b.id);
  }

  /** Who is ahead: a team's or a player's score against the best of the rest ("12 : 9"). */
  standing(): { mine: number; theirs: number; limit: number } {
    if (this.mode === "tdm") {
      const mine = this.me.team ? (this.score[this.me.team] ?? 0) : 0;
      let theirs = 0;
      for (const t of TEAMS) if (t !== this.me.team) theirs = Math.max(theirs, this.score[t] ?? 0);
      return { mine, theirs, limit: this.rules.scoreLimit };
    }
    let theirs = 0;
    for (const a of this.actors.values()) theirs = Math.max(theirs, a.kills);
    return { mine: this.me.kills, theirs, limit: this.rules.scoreLimit };
  }

  /** Whether `actor` is someone to shoot at. */
  hostile(actor: Actor): boolean {
    return this.mode !== "tdm" || actor.team === null || actor.team !== this.me.team;
  }
}

/** A nickname as shown: no control characters, at most 24 characters. */
export function cleanName(name: unknown, fallback: string): string {
  if (typeof name !== "string") return fallback;
  let out = "";
  for (const ch of name.slice(0, 64)) out += ch.codePointAt(0)! < 0x20 ? " " : ch;
  out = out.replace(/\s+/g, " ").trim().slice(0, 24);
  return out || fallback;
}
