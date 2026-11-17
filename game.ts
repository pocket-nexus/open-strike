// OpenStrikeRT: a path-traced team shooter, played together in rooms of threert.app.
//
// This file is the game's frame: it reads the input, moves the player (src/player.ts), fires the weapons
// (src/weapons.ts) and decides on this client what each shot met (the map's collision in the physics world, the other
// players' hit volumes as this player sees them), tells the match (src/match.ts: a room of the platform through
// src/net.ts, or practice), and shows what comes back: the other soldiers (src/soldiers.ts), the first-person weapon
// (src/viewmodel.ts), the effects (src/effects.ts), the HUD (src/hud.ts), the sound (src/sound.ts). The Maps menu
// (src/menu.ts, M) chooses a map to practise on or to open a room on, and imports maps from the player's own copy of
// Counter-Strike or Half-Life into the app's store on this device (src/import/).
// README.md has the netcode on a page; docs/MAPS.md what a map is.
import { DirectionalLight, PerspectiveCamera, Raycaster, Scene, Vector3 } from "@threert/scene";
import { defineGame, host, hud, type FrameContext, type Input } from "@threert/gameplay";
import { FLAG, LOADOUT, MOVE, TEAM, type WeaponDef } from "./src/config.ts";
import { Effects } from "./src/effects.ts";
import { show } from "./src/hud.ts";
import { Library } from "./src/import/library.ts";
import { DEFAULT_MAP, isUserMap, mapById, maps, type AnyMap } from "./src/maps/index.ts";
import { forgetMount, mountMap, type Mounted } from "./src/maps/mount.ts";
import { Match, type Actor, type RemoteShot } from "./src/match.ts";
import { Menu } from "./src/menu.ts";
import { Session, type Launch } from "./src/net.ts";
import { Player } from "./src/player.ts";
import { Practice } from "./src/practice.ts";
import { SLOTS, Soldiers, animate, newSoldier, type SoldierState } from "./src/soldiers.ts";
import { preloadSounds, sound, soundFrame } from "./src/sound.ts";
import { mad, norm, sub, viewAxes, type V3 } from "./src/vec.ts";
import { ViewModel, metaOf } from "./src/viewmodel.ts";
import { Arsenal, type Shot } from "./src/weapons.ts";

/** The view's vertical field, degrees (about 92 across at 16:9). */
const FOV = 60;

let scene: Scene, camera: PerspectiveCamera, sun: DirectionalLight;
let mounted: Mounted;
let effects: Effects, viewmodel: ViewModel, soldiers: Soldiers;
let match: Match, session: Session;
const player = new Player();
let arsenal = new Arsenal(1);
const raycaster = new Raycaster();
let started = false;
let sinceSpawn = 0;
let shots = 0, claims = 0, confirmed = 0;
/** The player's own body, shown when it is down (slot 0). */
const body: SoldierState = newSoldier(0, null);
/** While down: where the camera is and what it looks at. */
let deathCam: { from: V3; at: V3 } | null = null;
let firingUntil = 0;
let lastStepAt = 0;
/** The sounds' bookkeeping (presentation only): how many of the reload's in-between sounds have played; each other
 *  soldier's last footstep (its stride's half-turns) and flags; the round's phase and the countdown's last second. */
let reloadMarks = 0;
const stepOf = new Float64Array(SLOTS).fill(NaN);
const flagsOf = new Int32Array(SLOTS);
let phaseWas = "";
let tickAt = 0;
let target: { name: string; hostile: boolean } | null = null;
let targetIn = 0;
/** A picture without the weapon in it (the `place` handler, practice only). */
let bare = false;
/** How far the eye has adapted to standing in sunlight (0 in the shade .. 1), and the stops that takes off the exposure. */
let sunlit = 0;
const SUN_STOPS = 1;
/** The player's own maps (the store, imports) and the Maps menu. */
const library = new Library();
const menu = new Menu(library);
let foundWas: unknown = null;
// A row of the menu clicked or tapped (the app draws the menu: its table is selectable).
host.on("hud.choose", (m) => menu.choose((m as { item?: unknown }).item, (m as { row?: unknown }).row));

function useMap(map: AnyMap): void {
  if (mounted?.map === map) return;
  mounted = mountMap(scene, sun, camera, map, mounted);
  player.setMap(map);
  effects?.clear();
}

/** A place to come into the world: one of the team's (or anyone's), the one farthest from the nearest enemy. */
function spawnPoint(): { position: V3; yaw: number } {
  const all = mounted.map.spawns;
  const side = match.mode === "tdm" && match.me.team ? TEAM[match.me.team].side : "any";
  let list = all.filter((s) => s.team === side);
  if (!list.length) list = all;
  let best = list[0]!, bestScore = -1;
  for (const s of list) {
    let near = 1e9;
    for (const a of match.actors.values()) {
      if (!a.pose || !a.alive || !match.hostile(a)) continue;
      near = Math.min(near, Math.hypot(a.pose[0]! - s.position[0], a.pose[2]! - s.position[2]));
    }
    // (Among places equally safe, any: the same one twice in a row is where someone waits.)
    const score = Math.min(near, 40) + Math.random() * 6;
    if (score > bestScore) { best = s; bestScore = score; }
  }
  return best;
}

function spawn(why: "join" | "respawn" | "round"): void {
  const s = spawnPoint();
  player.place(s.position, s.yaw);
  if (why === "respawn") arsenal.settle();
  else arsenal.reset();
  match.me.protectedUntil = match.time() + match.rules.protect;
  deathCam = null;
  body.dead = -1;
  soldiers.hide(0);
  sinceSpawn = 0;
  sound(why === "round" ? "round.start" : "respawn");
}

function died(by: Actor | null, _weapon: string): void {
  arsenal.restock();
  // The body stays where it fell; the camera steps back from it, turned so that whoever did it is in the picture.
  const feet: V3 = [player.position.x, player.position.y, player.position.z];
  Object.assign(body, { team: match.me.team, position: feet, yaw: player.yaw, pitch: 0, speed: 0, flags: 0, weapon: arsenal.current, crouch: player.crouched ? 1 : 0, dead: 0 });
  let away: V3 = [Math.sin(player.yaw), 0, Math.cos(player.yaw)];
  if (by?.pose) away = norm([feet[0] - by.pose[0]!, 0, feet[2] - by.pose[2]!]);
  const head: V3 = [feet[0], feet[1] + 1.5, feet[2]];
  const want = mad(mad(head, away, 3.4), [0, 1, 0], 1.0);
  const d = sub(want, head);
  const far = Math.hypot(d[0], d[1], d[2]);
  raycaster.set(new Vector3(...head), new Vector3(d[0] / far, d[1] / far, d[2] / far));
  raycaster.far = far;
  const wall = raycaster.intersectPhysics()[0];
  const k = wall ? Math.max(0.3, wall.distance - 0.25) / far : 1;
  deathCam = { from: mad(head, d, k), at: mad(feet, away, -1.2) };
  deathCam.at[1] += 0.6;
  sound("death");
}

function hurt(amount: number, from: V3 | null): void {
  let angle: number | undefined;
  if (from) {
    // Clockwise from straight ahead, as the HUD wants it.
    const dx = from[0] - player.position.x, dz = from[2] - player.position.z;
    const yaw = Math.atan2(-dx, -dz);
    let d = player.yaw - yaw;
    d -= Math.PI * 2 * Math.round(d / (Math.PI * 2));
    angle = Math.round(d * 100) / 100;
  }
  hud.flash("damage", angle);
  sound("hurt", undefined, 0.75 + Math.min(0.5, amount / 100));
}

function remoteShot(actor: Actor, shot: RemoteShot): void {
  const slot = actor.soldier.slot;
  const muzzle = soldiers.muzzles[slot]!;
  actor.soldier.fired = 0;
  const first = shot.ends[0];
  if (first) effects.flash(muzzle, norm(sub(first, muzzle)), 1);
  shot.ends.slice(0, 4).forEach((end, i) => {
    effects.tracer(muzzle, end);
    if (i > 1) return;
    // Where it ended, if that is a wall: the surface there, for the sparks and the mark.
    const d = sub(end, muzzle);
    const far = Math.hypot(d[0], d[1], d[2]);
    if (far < 0.5) return;
    raycaster.set(new Vector3(...muzzle), new Vector3(d[0] / far, d[1] / far, d[2] / far));
    raycaster.far = far + 0.25;
    const h = raycaster.intersectPhysics()[0];
    if (h && h.normal && h.distance > far - 0.25) {
      effects.impact([h.point.x, h.point.y, h.point.z], [h.normal.x, h.normal.y, h.normal.z]);
      if (i === 0) sound("impact.wall", h.point, 0.7);
    }
  });
  sound(`weapon.${shot.weapon}.fire.far`, muzzle);
}

/** One shot: where each pellet goes and what it meets, on this client; then the match is told. */
function fire(shot: Shot, eye: V3, ax: { f: V3; r: V3; u: V3 }, ago: number): void {
  const w = shot.weapon;
  shots++;
  const hostile: number[] = [];
  const bySlot = new Map<number, Actor>();
  for (const a of match.actors.values()) {
    if (!a.alive || !a.pose || !match.hostile(a)) continue;
    hostile.push(a.soldier.slot);
    bySlot.set(a.soldier.slot, a);
  }
  const ends: V3[] = [];
  const hits: { actor: Actor; zone: "head" | "body" | "limb"; point: V3; distance: number }[] = [];
  shot.pellets.forEach(([px, py], i) => {
    const dir = norm([ax.f[0] + ax.r[0] * px + ax.u[0] * py, ax.f[1] + ax.r[1] * px + ax.u[1] * py, ax.f[2] + ax.r[2] * px + ax.u[2] * py]);
    raycaster.set(new Vector3(...eye), new Vector3(...dir));
    raycaster.far = w.range;
    const wall = raycaster.intersectPhysics()[0];
    const reach = wall ? wall.distance : w.range;
    const h = soldiers.hit(eye, dir, reach, hostile);
    if (h) {
      hits.push({ actor: bySlot.get(h.slot)!, zone: h.zone, point: h.point, distance: h.distance });
      effects.puff(h.point, [-dir[0], 0, -dir[2]]);
      if (hits.length <= 2) sound("impact.body", h.point, hits.length === 1 ? 1 : 0.6);
      ends.push(h.point);
    } else if (wall && wall.normal) {
      const p: V3 = [wall.point.x, wall.point.y, wall.point.z];
      effects.impact(p, [wall.normal.x, wall.normal.y, wall.normal.z]);
      if (i === 0) sound("impact.wall", p, 0.6);
      ends.push(p);
    } else ends.push(mad(eye, dir, Math.min(w.range, 90)));
    if (i < 4) effects.tracer(viewmodel.muzzle, ends[ends.length - 1]!);
  });
  effects.flash(viewmodel.muzzle, viewmodel.forward, w.pellets > 1 ? 1.5 : 1);
  if (!viewmodel.scoped) effects.casing(viewmodel.port, [viewmodel.portDir[0] * 2.2 + player.velocity.x, viewmodel.portDir[1] * 2.2 + 1.2, viewmodel.portDir[2] * 2.2 + player.velocity.z], player.position.y);
  sound(`weapon.${w.id}.fire`);
  const src = match.source;
  if (!src) return;
  const shotTime = src.fire(w, ago, viewmodel.muzzle, ends);
  for (const h of hits) {
    claims++;
    src.claim(shotTime, w, h.actor, h.zone, h.point, h.distance);
  }
}

/** Who is under the crosshair and in sight (looked for ten times a second). */
function lookFor(eye: V3, f: V3): void {
  target = null;
  const slots: number[] = [];
  const bySlot = new Map<number, Actor>();
  for (const a of match.actors.values()) if (a.alive && a.pose) { slots.push(a.soldier.slot); bySlot.set(a.soldier.slot, a); }
  if (!slots.length) return;
  const h = soldiers.hit(eye, f, 120, slots);
  if (!h) return;
  raycaster.set(new Vector3(...eye), new Vector3(...f));
  raycaster.far = h.distance;
  if (raycaster.intersectPhysics().length) return;
  const a = bySlot.get(h.slot)!;
  target = { name: a.name, hostile: match.hostile(a) };
}

/** A number from a string (a seed that differs between players). */
function f64(v: unknown): number {
  let h = 2166136261;
  for (const ch of String(v ?? "")) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h >>> 0;
}

const KEYS = ["1", "2", "3"];
function weaponKey(input: Input): number | null {
  for (let i = 0; i < LOADOUT.length; i++) if (input.pressed(KEYS[i]!)) return i;
  return null;
}

function frame(f: FrameContext<unknown>): void {
  const dt = f.dt, input = f.input;
  // The game starts once the maps in the store are known (a room may play one of them).
  if (!started && dt > 0) {
    library.begin(f.now);
    if (library.ready(f.now)) {
      started = true;
      session.start(host.launch as Launch, f.now);
    }
  }
  if (dt > 0) library.update(f.now);
  menu.current = mounted.map.id;
  menu.online = match.status === "online" || match.status === "reconnecting";
  const chosen = menu.update(input);
  if (library.found !== foundWas) {
    foundWas = library.found;
    if (library.found) { if (!menu.open) menu.show(); menu.picked(); }
  }
  if (chosen && started) session.restart(chosen.kind === "practice" ? { practice: true, map: chosen.id } : { room: "new", map: chosen.id });
  // While the menu is open its keys are its own: the player stands, does not look round or shoot.
  const free = !menu.open;
  if (dt > 0 && started) {
    session.update(f.now, dt);
    match.source?.update(f.now, dt);
  }
  const me = match.me;
  const playing = match.status === "online" || match.status === "practice" || match.status === "reconnecting";
  const alive = playing && me.alive;
  sinceSpawn += dt;

  // ---- the player ----
  let lookX = 0, lookY = 0;
  const live = alive && match.round.phase !== "waiting";
  const hands = live && input.captured && free;
  if (dt > 0 && live) {
    lookX = free ? input.look.dx : 0;
    lookY = free ? input.look.dy : 0;
    player.look(lookX, lookY);
    const wantAds = hands && input.button(2);
    const trigger = hands && input.button(0);
    const crouch = free && (input.down("C") || input.down("Ctrl"));
    const w = arsenal.def;
    const wasGrounded = player.grounded;
    player.update(dt, {
      x: free ? input.move.x : 0, y: free ? input.move.y : 0, jump: free && input.pressed("Space"), crouch,
      sprint: free && input.down("Shift") && !trigger && !wantAds && arsenal.reloading === 0,
      limit: w.mobility * (1 - (1 - MOVE.adsSpeed) * arsenal.ads),
    });
    if (player.fell) match.source?.die("fall");
    if (wasGrounded && !player.grounded && !player.onLadder && player.velocity.y > MOVE.jump * 0.5) sound("jump");
    if (player.landed && player.landed.speed > 4) sound("land", undefined, Math.min(1.3, 0.55 + (player.landed.speed - 4) / 8));
    else if (player.landed && player.landed.speed > 2) { lastStepAt = player.walked; sound("step", undefined, 0.8); }
    if (player.grounded && player.walked - lastStepAt > (player.sprinting ? 2.1 : 1.7)) { lastStepAt = player.walked; sound("step", undefined, player.crouched ? 0.3 : player.sprinting ? 0.85 : 0.7); }

    const before = arsenal.clock;
    const fired = arsenal.update(dt, {
      trigger, pressed: hands && input.pressed("Mouse0"), ads: wantAds, reload: free && input.pressed("R"),
      select: free ? weaponKey(input) : null, wheel: !free ? 0 : input.wheel > 0 ? -1 : input.wheel < 0 ? 1 : 0,
    }, { speed: player.speed, runSpeed: MOVE.run, grounded: player.grounded, crouched: player.crouched, sprinting: player.sprinting });
    // Each shot goes where the view pointed as it left: the aim, and the kick of the shots before it (not its own).
    if (fired.length) {
      const feet = player.feet(new Vector3());
      const eye: V3 = [feet.x, feet.y + player.eye, feet.z];
      const round = match.round.phase === "live";
      for (const s of fired) {
        const ax = viewAxes(player.yaw + s.off[1], Math.min(1.55, player.pitch + s.off[0]));
        if (round || match.status === "practice") fire(s, eye, ax, Math.max(0, before + dt - s.at));
      }
      firingUntil = arsenal.clock + 0.15;
    }
    // The recoil that stays is the player's aim from now on.
    player.pitch = Math.min(1.52, player.pitch + arsenal.climbPitch);
    player.yaw += arsenal.climbYaw;
    arsenal.climbPitch = arsenal.climbYaw = 0;
  }
  reloadSounds();

  // ---- the camera ----
  const feet = player.feet(new Vector3());
  const eye: V3 = [feet.x, feet.y + player.eye, feet.z];
  const yaw = player.yaw + arsenal.kickYaw, pitch = Math.max(-1.55, Math.min(1.55, player.pitch + arsenal.kickPitch));
  const ax = viewAxes(yaw, pitch);
  if (!alive && deathCam) {
    body.dead += dt;
    soldiers.pose(body);
    f.camera.position.set(...deathCam.from);
    f.camera.lookAt(...deathCam.at);
    f.camera.fov = FOV;
  } else {
    f.camera.position.set(eye[0], eye[1], eye[2]);
    f.camera.rotation.set(pitch, yaw, 0, "YXZ");
    const k = arsenal.ads * arsenal.ads * (3 - 2 * arsenal.ads);
    f.camera.fov = FOV + (arsenal.def.adsFov - FOV) * k;
  }
  // Behind a scope most of the picture is its black mask: the exposure meters the picture, so it is held down by what
  // the mask would add (a map with a fixed exposure needs none of this).
  const dim = viewmodel.scoped && alive;
  // In the open the eye stands in sunlight: the meter, which averages a picture that is mostly shade and dark ground,
  // would burn out whatever the sun is on (a soldier, the weapon in the hands), so the exposure is brought down as
  // the eye comes into the sun and let back up in the shade.
  const sunAt = mounted.map.sun;
  let open = 0;
  if (sunAt && sunAt.elevation > 3 && sunAt.illuminance > 20000) {
    const e = (sunAt.elevation * Math.PI) / 180, a = (sunAt.azimuth * Math.PI) / 180;
    raycaster.set(new Vector3(...eye), new Vector3(Math.cos(e) * Math.sin(a), Math.sin(e), Math.cos(e) * Math.cos(a)));
    raycaster.far = 80;
    open = raycaster.intersectPhysics()[0] ? 0 : 1;
  }
  sunlit += (open - sunlit) * (1 - Math.exp(-dt * 2.2));
  const compensation = Math.round((dim ? -1.7 : 0) * 10 - SUN_STOPS * sunlit * 10) / 10;
  const exposure = f.camera.exposure;
  if (mounted.map.exposure === undefined && exposure.mode === "auto" && exposure.compensation !== compensation) f.camera.setAutoExposure(compensation, 7, 15);
  viewmodel.update(f.camera, arsenal, {
    dt, eye, f: ax.f, r: ax.r, u: ax.u, lookX, lookY, speed: player.speed, walked: player.walked, grounded: player.grounded, sprinting: player.sprinting,
    vy: player.velocity.y, hidden: !alive || bare,
  });

  // ---- everyone else ----
  const used = new Uint8Array(soldiers.volumes.length);
  used[0] = !alive && deathCam ? 1 : 0;
  for (const a of match.actors.values()) {
    if (!a.pose) continue;
    a.soldier.fired += dt;
    animate(a.soldier, a.pose, dt);
    soldierSounds(a);
    soldiers.pose(a.soldier);
    used[a.soldier.slot] = 1;
  }
  for (let s = 0; s < used.length; s++) if (!used[s]) soldiers.hide(s);
  effects.update(dt);

  // ---- what the others get of this player ----
  if (dt > 0 && playing && me.id) {
    const r3 = (v: number) => Math.round(v * 1000) / 1000;
    const flags = (player.crouched ? FLAG.crouch : 0) | (arsenal.clock < firingUntil ? FLAG.firing : 0) | (player.grounded || player.onLadder ? 0 : FLAG.air) | (arsenal.ads > 0.5 ? FLAG.ads : 0) | (arsenal.reloading > 0 ? FLAG.reload : 0) | (player.sprinting ? FLAG.sprint : 0);
    match.source?.pose([r3(player.position.x), r3(player.position.y), r3(player.position.z), r3(player.yaw), r3(player.pitch), Math.round(player.speed * 10) / 10, flags, arsenal.current]);
  }

  // ---- the HUD ----
  targetIn -= dt;
  if (alive && targetIn <= 0) { targetIn = 0.1; lookFor(eye, ax.f); }
  if (!alive) target = null;
  show({
    match, arsenal, captured: input.captured, board: input.down("Tab"), scoped: viewmodel.scoped, target, map: mounted.map.title, sinceSpawn,
    menu: menu.items(), importing: library.progress, notice: menu.open ? null : library.recent(), imported: isUserMap(mounted.map),
    spread: arsenal.spread({ speed: player.speed, runSpeed: MOVE.run, grounded: player.grounded, crouched: player.crouched, sprinting: player.sprinting }),
  });
  roundSounds(match.time());
  soundFrame(f.camera.position);
}

/** The sounds a reload makes on its way: the magazine going in a little past half, or each shell the shotgun loads. */
function reloadSounds(): void {
  const s = arsenal.slot, w = s.def;
  if (arsenal.reloading <= 0) { reloadMarks = 0; return; }
  const done = 1 - arsenal.reloading / (w.reload / 1000);
  const shells = w.id === "shotgun";
  const marks = shells ? Math.min(w.mag - s.ammo, s.reserve) : 1;
  const at = (k: number) => (shells ? 0.12 + (0.72 * (k + 0.5)) / marks : 0.55);
  while (reloadMarks < marks && done >= at(reloadMarks)) {
    sound(shells ? "weapon.shotgun.shell" : `weapon.${w.id}.reload.in`);
    reloadMarks++;
  }
}

/** Another soldier, heard: footsteps with its stride, a landing, the start of a reload. */
function soldierSounds(a: Actor): void {
  const s = a.soldier, slot = s.slot;
  const feet = s.position;
  const was = flagsOf[slot]!, now = s.flags;
  flagsOf[slot] = now;
  const step = Math.floor(s.stride / Math.PI);
  const prev = stepOf[slot]!;
  stepOf[slot] = step;
  if (!a.alive || Number.isNaN(prev)) return;
  if (step !== prev && Math.abs(step - prev) < 3 && s.speed > 1.2 && !(now & FLAG.air)) sound("step", feet, now & FLAG.crouch ? 0.35 : now & FLAG.sprint ? 1 : 0.75);
  if (was & FLAG.air && !(now & FLAG.air)) sound("land", feet, 0.6);
  if (now & FLAG.reload && !(was & FLAG.reload)) sound(`weapon.${LOADOUT[s.weapon] ?? "carbine"}.reload`, [feet[0], feet[1] + 1.2, feet[2]], 0.8);
}

/** The round over (won, lost), and the last three seconds before the next one ticking. */
function roundSounds(now: number): void {
  const r = match.round, me = match.me;
  if (r.phase === "over" && phaseWas === "live" && r.winner !== undefined && me.id) sound(r.winner === me.team || r.winner === me.id ? "round.won" : "round.lost");
  phaseWas = r.phase;
  if (r.phase !== "over" || !r.end) return;
  const left = Math.ceil((r.end - now) / 1000);
  if (left >= 1 && left <= 3 && left !== tickAt) sound("ui.tick");
  tickAt = left;
}

export default defineGame({
  state: {},
  pointer: "look",
  setup() {
    scene = new Scene();
    sun = new DirectionalLight(0xffffff, 90000);
    sun.name = "sun";
    scene.add(sun);
    camera = new PerspectiveCamera(FOV, 16 / 9, 0.03, 400);
    scene.add(camera);
    mounted = undefined as unknown as Mounted;
    useMap(mapById(DEFAULT_MAP)!);
    effects = new Effects(scene);
    viewmodel = new ViewModel(scene);
    soldiers = new Soldiers(scene);
    started = false;
    preloadSounds();

    match = new Match({
      spawn, died, hurt,
      confirmed(_target, _amount, _zone, killed) {
        confirmed++;
        hud.flash(killed ? "kill" : "hit");
        sound(killed ? "kill" : "hit");
      },
      shot: remoteShot,
      map: useMap,
      weapons(table: Record<string, WeaponDef>) {
        // The room's numbers for the weapons in hand (the same, unless another version of the game made the room).
        for (const slot of arsenal.slots) {
          slot.def = table[slot.def.id] ?? slot.def;
          slot.ammo = Math.min(slot.ammo, slot.def.mag);
        }
      },
    });
    arsenal = new Arsenal((f64(host.launch.name) ^ 0x9e3779b9) >>> 0);
    arsenal.onReload = (def, at) => match.source?.reload(def, Math.max(0, arsenal.clock - at));
    arsenal.onSound = (name) => sound(`weapon.${arsenal.def.id}.${name}`);
    library.onChange = (id, added) => {
      // A map taken off this device while it is being played: back to the built-in one.
      if (!added && mounted.map.id === id && started) session.restart({ practice: true, map: DEFAULT_MAP });
      if (mounted.map.id !== id) forgetMount(id);
    };
    session = new Session(match, (_notice, launch) => {
      const wanted = typeof launch.map === "string" ? mapById(launch.map) : undefined;
      if (wanted) useMap(wanted);
      else if (!maps().includes(mounted.map)) useMap(mapById(DEFAULT_MAP)!);
      const bots = typeof launch.bots === "number" ? launch.bots : 4;
      return new Practice(match, () => mounted.map, launch.mode === "dm" ? "dm" : "tdm", bots, launch.targets === true);
    });
    // Before the match says where: a look over the hall.
    const s = mounted.map.spawns[0]!;
    player.place(s.position, s.yaw);
    camera.position.set(s.position[0], s.position[1] + MOVE.eye, s.position[2]);
    camera.rotation.set(0, s.yaw, 0, "YXZ");
    return { scene, camera, options: { name: "openstrike", width: 1280, height: 720 } };
  },
  on: {
    /** The state of the game on the console, for scripted tests (`osrt {...}`). */
    report() {
      const r = (v: number) => Math.round(v * 1e4) / 1e4;
      const s = arsenal.slot;
      console.log(`osrt ${JSON.stringify({
        at: [r(player.position.x), r(player.position.y), r(player.position.z)], v: [r(player.velocity.x), r(player.velocity.y), r(player.velocity.z)],
        yaw: r(player.yaw), pitch: r(player.pitch), kick: [r(arsenal.kickPitch), r(arsenal.kickYaw)], grounded: player.grounded, crouched: player.crouched, ladder: player.onLadder, eye: r(player.eye),
        weapon: s.def.id, ammo: s.ammo, reserve: s.reserve, reloading: r(arsenal.reloading), ads: r(arsenal.ads), bloom: r(arsenal.bloom), clock: r(arsenal.clock),
        shots, claims, confirmed, rejects: match.rejects,
        status: match.status, notice: match.notice, room: session.roomStatus, code: match.code, mode: match.mode, map: mounted.map.id, time: Math.round(match.time()),
        me: { id: match.me.id, team: match.me.team, alive: match.me.alive, health: match.me.health, kills: match.me.kills, deaths: match.me.deaths },
        actors: [...match.actors.values()].map((a) => ({ id: a.id, name: a.name, team: a.team, alive: a.alive, health: a.health, kills: a.kills, at: a.pose ? [r(a.pose[0]!), r(a.pose[1]!), r(a.pose[2]!)] : null, yaw: a.pose ? r(a.pose[3]!) : 0, flags: a.pose?.[6] ?? 0, weapon: a.pose?.[7] ?? 0 })),
        round: match.round, score: match.score, rtt: Math.round(match.rtt),
        maps: maps().map((m) => m.id), user: maps().filter(isUserMap).map((m) => ({ id: m.id, hash: m.hash, glb: m.glb })), library: library.status,
        imports: library.done, importing: library.progress, notice2: library.notice?.text ?? null, menu: { open: menu.open, items: menu.items() },
      })}`);
    },
    /** Practice only: puts the player somewhere ({ at: [x, y, z], yaw?, pitch? }): staging a picture, a test. */
    place(_world, ev: { at?: V3; yaw?: number; pitch?: number; bare?: boolean; crouch?: boolean }) {
      if (match.status !== "practice" || !Array.isArray(ev?.at)) return;
      player.place(ev.at, ev.yaw ?? player.yaw);
      player.pitch = ev.pitch ?? 0;
      bare = ev.bare === true;
    },
    /** Practice only: the bots where a picture wants them (src/practice.ts `stage`). */
    stage(_world, ev: { bots?: Parameters<Practice["stage"]>[0] }) {
      if (match.status === "practice" && match.source instanceof Practice && Array.isArray(ev?.bots)) match.source.stage(ev.bots);
    },
  },
  frame,
});
