// Getting into a match, and playing it in a room of the platform (`@threert/net`, its README).
//
// How the game was opened decides where the player goes (`host.launch`, the app's `launch` message):
//   room: "K7Q4MZ"   that room
//   room: "new"      a private room of its own; its code and invitation are shown
//   (nothing)        quick play: the public room of this app with the most players and a free place, else a new
//                    public room
//   practice: true   no room at all
// and when there is no network, no platform, no such room, no place in it or not the room's map, the player is in
// practice on the built-in map and is told why. Other launch fields: name, mode ("tdm" | "dm"), map (an id), api
// (the platform's address; default https://threert.app), id (the player's stable id, when the app keeps one).
//
// In a room the `fps` rules module is the authority (README "Netcode"): this client sends its pose (20 a second), a
// `shot` for every shot and a `hit` for every pellet it saw land; the room checks each claim against the weapon
// table it was created with (config.ts `roomRules`) and both players' recent positions, and what it decides comes
// back as shared state (`players.<pid>`, `score`, `round`) and events (`damage`, `kill`, `respawn`, `round`,
// `reject`).
import { host } from "@threert/gameplay";
import { createRoom, hostTransport, joinRoom, type NetEvent, type Peer, type Room, type RoomInfo, type Transport } from "@threert/net";
import { APP, ENDPOINT, MAX_PLAYERS, POSE, RULES, TEAMS, VERSION, WEAPONS, inviteLink, roomRules, type Mode, type Rules, type Team, type WeaponDef, type Zone } from "./config.ts";
import { DEFAULT_MAP, findMap, mapById, type AnyMap } from "./maps/index.ts";
import { cleanName, type Actor, type Match, type Source } from "./match.ts";
import type { V3 } from "./vec.ts";

export interface Launch {
  room?: unknown; name?: unknown; api?: unknown; mode?: unknown; map?: unknown; practice?: unknown; id?: unknown;
  /** Overrides of the match rules of a room this player creates ({ scoreLimit, roundTime, respawn, … }). */
  rules?: unknown;
  /** The manifest's `platform` as the client passes it on: `rooms` is "wss://threert.app/api/v1/rooms/<name>". */
  platform?: unknown;
  /** Practice: how many bots (default 4), and whether they only stand there (targets). */
  bots?: unknown;
  targets?: unknown;
}

const CODE = /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/;
const WAIT = 9000;            // ms the platform has to answer before the player is put in practice

/** The platform's address: `launch.api`, else the manifest's `platform.rooms`, else threert.app. */
export function endpointOf(launch: Launch): string {
  if (typeof launch.api === "string" && /^https?:\/\//.test(launch.api)) return launch.api.replace(/\/+$/, "");
  const rooms = (launch.platform as { rooms?: unknown } | undefined)?.rooms;
  if (typeof rooms === "string") {
    const m = /^(wss?):\/\/([^/]+)/.exec(rooms);
    if (m) return `${m[1] === "ws" ? "http" : "https"}://${m[2]}`;
  }
  return ENDPOINT;
}

function playerId(launch: Launch, name: string, now: number): string {
  if (typeof launch.id === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(launch.id)) return launch.id;
  // The runtime keeps nothing between runs: an id for this run, from the clock, the name and what randomness there is.
  const abc = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let h = (now % 4294967296) >>> 0;
  for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 0x9e3779b1) >>> 0;
  let out = "";
  for (let i = 0; i < 22; i++) {
    h = (Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) + Math.floor(Math.random() * 4294967296)) >>> 0;
    out += abc[h % abc.length];
  }
  return out;
}

interface FpsPlayer { team?: string; health: number; alive: boolean; kills: number; deaths: number; respawn: number }

/** A room as the match's source. */
class Online implements Source {
  private readonly prev = { alive: false, round: -1, phase: "", spawned: false };
  private lastKill: { victim: number; killer: number; weapon: string } | null = null;
  private teams: string[] = [...TEAMS];
  private readonly room: Room;
  private readonly match: Match;

  constructor(room: Room, match: Match) {
    this.room = room;
    this.match = match;
    room.on("join", (p) => { this.enter(p); match.say(`${p.name} joined`, "dim"); });
    room.on("leave", (p) => { match.exit(p.pid); match.say(`${p.name} left`, "dim"); });
    room.on("event", (e) => this.event(e));
  }

  time(): number {
    return this.room.time;
  }

  private enter(p: Peer): void {
    this.match.enter(p.pid, cleanName(p.name, `player ${p.pid}`));
  }

  /** The room said `open` (or took this player back after a reconnection): everything is read anew. */
  opened(): void {
    const m = this.match, room = this.room;
    m.me.id = room.pid;
    m.me.name = cleanName(room.name, m.me.name);
    for (const id of [...m.actors.keys()]) if (!room.peers.has(id)) m.exit(id);
    for (const p of room.peers.values()) this.enter(p);
    const rules = (room.state.rules ?? {}) as Partial<Rules> & { teams?: unknown; weapons?: Record<string, Partial<WeaponDef>> };
    this.teams = Array.isArray(rules.teams) ? rules.teams.map(String) : [...TEAMS];
    const mode: Mode = room.state.mode === "dm" ? "dm" : "tdm";
    m.mode = mode;
    m.rules = { ...RULES[mode] };
    for (const k of Object.keys(m.rules) as (keyof Rules)[]) if (typeof rules[k] === "number") m.rules[k] = rules[k]!;
    // The weapons as the room counts them: its numbers over this client's table (the same, unless the room was made
    // by another version of the game).
    const table: Record<string, WeaponDef> = {};
    for (const [id, w] of Object.entries(WEAPONS)) {
      const theirs = rules.weapons?.[id];
      table[id] = theirs ? { ...w, ...pick(theirs, ["damage", "zones", "range", "falloff", "rpm", "mag", "reload", "pellets"]) } : w;
    }
    m.weapons = table;
    m.hooks.weapons(table);
  }

  private team(name: string | undefined): Team | null {
    const i = name === undefined ? -1 : this.teams.indexOf(name);
    return i >= 0 && i < TEAMS.length ? TEAMS[i]! : null;
  }

  private event(e: NetEvent): void {
    const m = this.match, d = (e.d ?? {}) as Record<string, any>;
    if (e.from !== 0) {
      const actor = m.actors.get(e.from);
      if (e.k === "shot" && actor && Array.isArray(d.e)) m.hooks.shot(actor, { weapon: String(d.weapon), ends: (d.e as unknown[]).filter((p): p is V3 => Array.isArray(p) && p.length === 3).slice(0, 12) });
      return;
    }
    switch (e.k) {
      case "damage": {
        if (d.target === m.me.id) {
          const by = m.actors.get(d.by);
          m.hooks.hurt(Number(d.amount) || 0, by?.pose ? [by.pose[POSE.x]!, by.pose[POSE.y]!, by.pose[POSE.z]!] : null);
        }
        if (d.by === m.me.id) m.hooks.confirmed(m.actors.get(d.target) ?? null, Number(d.amount) || 0, String(d.zone), d.health <= 0);
        return;
      }
      case "kill": {
        this.lastKill = { victim: d.victim, killer: d.killer, weapon: String(d.weapon) };
        const how = m.weapons[String(d.weapon)]?.title ?? String(d.weapon);
        const text = d.killer && d.killer !== d.victim ? `${m.nameOf(d.killer)}  ›  ${m.nameOf(d.victim)}   ${how}${d.zone === "head" ? " · headshot" : ""}` : `${m.nameOf(d.victim)} ${d.weapon === "team" ? "changed sides" : "fell"}`;
        m.say(text, d.killer === m.me.id ? "accent" : d.victim === m.me.id ? "bad" : "default");
        return;
      }
      case "reject": {
        const why = `${d.k}:${d.why}`;
        m.rejects[why] = (m.rejects[why] ?? 0) + 1;
        return;
      }
      case "round":
        if (d.phase === "live") m.say(`Round ${d.n}`, "dim");
        return;
    }
  }

  update(now: number, dt: number): void {
    const m = this.match, room = this.room;
    room.update(now);
    if (room.status !== "open" && room.status !== "reconnecting") return;
    m.rtt = room.rtt;
    const st = room.state as { mode?: string; round?: Match["round"]; players?: Record<string, FpsPlayer>; score?: Record<string, number> };
    if (st.round) m.round = { n: st.round.n, phase: st.round.phase, end: st.round.end, ...(st.round.winner !== undefined ? { winner: typeof st.round.winner === "string" ? (this.team(st.round.winner) ?? st.round.winner) : st.round.winner } : {}) };
    m.score = {};
    for (const [name, n] of Object.entries(st.score ?? {})) m.score[this.team(name) ?? name] = n;
    for (const a of m.actors.values()) {
      const p = st.players?.[a.id];
      const was = a.alive;
      a.team = this.team(p?.team);
      a.soldier.team = a.team;
      a.alive = !!p?.alive;
      a.health = p?.health ?? 0;
      a.kills = p?.kills ?? 0;
      a.deaths = p?.deaths ?? 0;
      if (was && !a.alive) a.soldier.dead = 0;
      if (a.alive) a.soldier.dead = -1;
      else if (a.soldier.dead >= 0) a.soldier.dead += dt;
      else if (p) a.soldier.dead = 5;                 // already down when this client came in
      a.pose = (room.peers.get(a.id)?.pose as number[] | null) ?? null;
    }
    const p = st.players?.[room.pid];
    if (!p) return;
    const me = m.me, prev = this.prev;
    me.team = this.team(p.team);
    me.health = p.health;
    me.kills = p.kills;
    me.deaths = p.deaths;
    me.respawnAt = p.respawn;
    me.alive = p.alive;
    const live = m.round.phase === "live";
    if (!prev.spawned) {
      prev.spawned = true;
      if (p.alive) m.hooks.spawn("join");
    } else if (m.round.n !== prev.round && live && prev.round >= 0) {
      m.hooks.spawn("round");
    } else if (p.alive && !prev.alive) {
      m.hooks.spawn("respawn");
    } else if (!p.alive && prev.alive) {
      const k = this.lastKill && this.lastKill.victim === me.id ? this.lastKill : null;
      m.hooks.died(k && k.killer ? (m.actors.get(k.killer) ?? null) : null, k?.weapon ?? "world");
    }
    prev.alive = p.alive;
    prev.round = m.round.n;
    prev.phase = m.round.phase;
  }

  pose(pose: number[]): void {
    this.room.pose(pose);
  }

  fire(weapon: WeaponDef, ago: number, muzzle: V3, ends: V3[]): number {
    const shotTime = Math.round((this.room.time - ago * 1000) * 10) / 10;
    this.match.me.protectedUntil = 0;
    this.room.send("shot", { weapon: weapon.id, shotTime, o: muzzle.map(cm), e: ends.map((p) => p.map(cm)) }, "room");
    return shotTime;
  }

  claim(shotTime: number, weapon: WeaponDef, actor: Actor, zone: Zone, point: V3): void {
    this.room.send("hit", { target: actor.id, weapon: weapon.id, zone, at: point.map(cm), shotTime }, "room");
  }

  reload(weapon: WeaponDef, ago: number): void {
    this.room.send("reload", { weapon: weapon.id, time: this.room.time - ago * 1000 }, "room");
  }

  die(cause: string): void {
    this.room.send("die", { cause }, "room");
  }

  leave(): void {
    this.room.leave();
  }
}

const cm = (v: number) => Math.round(v * 100) / 100;
function pick<T extends object>(o: T, keys: string[]): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const k of keys) if ((o as Record<string, unknown>)[k] !== undefined) out[k] = (o as Record<string, unknown>)[k];
  return out as Partial<T>;
}

/** From the launch to a match: looks for a room, joins or makes one, falls back to practice; and back again. */
export class Session {
  private stage: "idle" | "list" | "lookup" | "connect" | "in" | "practice" = "idle";
  private deadline = 0;
  private now = 0;
  private quick = false;
  private retried = false;
  private launch: Launch = {};
  private endpoint = ENDPOINT;
  private id = "";
  private transport: Transport | null = null;
  private room: Room | null = null;
  private online: Online | null = null;
  private call = 0;
  private readonly match: Match;
  private readonly practice: (notice: string | null, launch: Launch) => Source;

  constructor(match: Match, practice: (notice: string | null, launch: Launch) => Source) {
    this.match = match;
    this.practice = practice;
  }

  /** The room, for the debug report. */
  get roomStatus(): string {
    return this.room?.status ?? "none";
  }

  start(launch: Launch, now: number): void {
    this.launch = launch;
    this.now = now;
    const m = this.match;
    m.me.name = cleanName(launch.name, m.me.name !== "Player" ? m.me.name : `Player${100 + Math.floor(Math.random() * 900)}`);
    m.mode = launch.mode === "dm" ? "dm" : "tdm";
    this.endpoint = endpointOf(launch);
    this.id ||= playerId(launch, m.me.name, now);
    const app = typeof (globalThis as { __host_post?: unknown }).__host_post === "function";
    if (launch.practice === true || launch.practice === "1" || !app) return this.toPractice(app ? null : "No network here: practice");
    this.transport = hostTransport(host as never);
    const want = typeof launch.room === "string" ? launch.room.trim().toUpperCase() : "";
    if (want === "NEW") this.create(false);
    else if (CODE.test(want)) this.lookup(want);
    else if (want) this.toPractice(`"${want}" is not a room code: practice`);
    else this.list();
  }

  /**
   * Somewhere else, as the player chose in the Maps menu: practice on a map (`{ practice: true, map }`) or a new room
   * on it (`{ room: "new", map }`). The room or the practice now is left first. The rest of the launch (the name, the
   * platform's address, the player's id) stays.
   */
  restart(over: Launch): void {
    const m = this.match;
    this.call++;
    this.deadline = 0;
    this.retried = false;
    if (this.room) { const r = this.room; this.room = null; this.online = null; r.leave(); }
    else m.source?.leave();
    m.source = null;
    m.clear();
    m.notice = null;
    const { room: _room, practice: _practice, map: _map, ...kept } = this.launch;
    this.start({ ...kept, ...over }, this.now);
  }

  private toPractice(notice: string | null): void {
    const m = this.match;
    if (this.room) { const r = this.room; this.room = null; this.online = null; r.leave(); }
    m.clear();
    m.status = "practice";
    m.notice = notice;
    this.stage = "practice";
    m.source = this.practice(notice, this.launch);
  }

  private request(path: string, done: (status: number, body: any) => void): void {
    const call = ++this.call;
    this.deadline = this.now + WAIT;
    this.transport!.request("GET", `${this.endpoint}${path}`, undefined, (status, body) => { if (call === this.call) { this.deadline = 0; done(status, body); } });
  }

  /** Quick play: the fullest public room with a free place whose map this copy of the game has. */
  private list(): void {
    this.quick = true;
    this.stage = "list";
    this.match.status = "searching";
    this.request(`/api/v1/apps/${APP}/rooms`, (status, body) => {
      if (status !== 200 || !Array.isArray(body?.rooms)) return this.toPractice(status === 0 ? "No connection to threert.app: practice" : `The platform answered ${status}: practice`);
      const mode = typeof this.launch.mode === "string" ? this.launch.mode : null;
      const open = (body.rooms as RoomInfo[])
        .filter((r) => r.players < r.max && (!mode || r.mode === mode) && "map" in findMap((r.meta as { map?: unknown } | null)?.map))
        .sort((a, b) => b.players - a.players || a.age - b.age);
      if (open[0]) this.join(open[0].code, true);
      else this.create(true);
    });
  }

  /** A room by its code: what it plays is looked at before the player is put into it. */
  private lookup(code: string): void {
    this.quick = false;
    this.stage = "lookup";
    this.match.status = "joining";
    this.request(`/api/v1/rooms/${APP}/${code}`, (status, body) => {
      if (status === 404) return this.toPractice(`There is no room ${code}: practice`);
      if (status !== 200) return this.toPractice(status === 0 ? "No connection to threert.app: practice" : `The platform answered ${status}: practice`);
      const found = findMap((body?.meta as { map?: unknown } | null)?.map);
      if ("missing" in found) return this.toPractice(missingMap(code, found.missing));
      if (typeof body?.players === "number" && body.players >= body.max) return this.toPractice(`Room ${code} is full: practice`);
      this.join(code, body?.public === true);
    });
  }

  private options() {
    return { app: APP, endpoint: this.endpoint, name: this.match.me.name, id: this.id, angles: [POSE.yaw], discrete: [POSE.flags, POSE.weapon], host: host as never };
  }

  private join(code: string, listed: boolean): void {
    this.match.listed = listed;
    this.attach(joinRoom({ ...this.options(), code }));
  }

  private create(listed: boolean): void {
    const mode: Mode = this.launch.mode === "dm" ? "dm" : "tdm";
    const map = (typeof this.launch.map === "string" && mapById(this.launch.map)) || mapById(DEFAULT_MAP)!;
    const over = (this.launch.rules && typeof this.launch.rules === "object" ? this.launch.rules : {}) as Partial<Rules>;
    this.match.listed = listed;
    this.attach(createRoom({
      ...this.options(), public: listed, max: MAX_PLAYERS, mode, rules: "fps", version: VERSION,
      meta: { map: { id: map.id, hash: map.hash, title: map.title }, rules: roomRules(mode, over) },
    }));
  }

  private attach(room: Room): void {
    const m = this.match;
    this.room = room;
    this.stage = "connect";
    this.deadline = this.now + WAIT + 4000;
    m.status = "joining";
    const online = new Online(room, m);
    this.online = online;
    room.on("open", () => {
      if (this.room !== room) return;
      // The room's map, once more (a room made between the look and the join, a quick-play race).
      const found = findMap(room.info?.meta?.map);
      if ("missing" in found) return this.toPractice(missingMap(room.code ?? "", found.missing));
      this.deadline = 0;
      this.stage = "in";
      m.status = "online";
      m.notice = null;
      m.code = room.code;
      m.link = room.code ? inviteLink(room.code) : null;
      m.source = online;
      m.hooks.map(found.map);
      online.opened();
    });
    room.on("reconnecting", () => { if (this.room === room) m.status = "reconnecting"; });
    room.on("reconnected", () => { if (this.room === room) { m.status = "online"; online.opened(); } });
    room.on("error", (e) => { if (this.room === room && e.code !== "rate") m.say(e.message || e.code, "dim"); });
    room.on("close", (e) => {
      if (this.room !== room) return;
      this.room = null;
      this.online = null;
      // No place left in a room quick play chose: make one instead (once).
      if (this.quick && !this.retried && (e.code === 4003 || e.code === 4004) && this.stage === "connect") {
        this.retried = true;
        return this.create(true);
      }
      this.toPractice(e.code === 4003 ? "The room is full: practice" : e.code === 4004 ? "The room has closed: practice" : e.code === 4001 ? "This player joined from somewhere else: practice"
        : e.reason === "create" ? "No room could be made: practice" : this.stage === "in" ? "The connection to the room was lost: practice" : "No connection to the room: practice");
    });
  }

  update(now: number, dt: number): void {
    this.now = now;
    if (this.stage === "connect" && this.online && this.match.source !== this.online) this.room?.update(now);       // (until it opens, nothing else drives it)
    if (this.deadline && now > this.deadline) {
      this.deadline = 0;
      this.call++;
      this.toPractice("The platform did not answer: practice");
    }
    void dt;
  }
}

/** What a player is told when a room plays a map this copy of the game does not have (nothing is ever sent over). */
export function missingMap(code: string, missing: { id: string; why: "absent" | "version" }): string {
  return missing.why === "absent"
    ? `Room ${code} plays the map "${missing.id}", which is not on this device. Import it from your own copy of the game (M: Maps, Import) to join. Practice meanwhile`
    : `Room ${code} plays another version of the map "${missing.id}". Import it again from the same file as the room's maker (M: Maps) to join. Practice meanwhile`;
}
