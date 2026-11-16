// Sound: the game names a moment (`sound("weapon.carbine.fire")`, `sound("impact.wall", point)`) and this file turns
// it into the engine's `audio.play` (@threert/gameplay; docs/RUNTIME.md "Sound"): which file, how loud, how far it
// carries, and a little variation of pitch and level each time so nothing repeats exactly. The engine decodes, places
// and mixes; the listener is the camera, nothing is sent for it. The files are in assets/sounds/, synthesized by
// tools/sounds.ts.
//
// Played from the frame and the match's hooks (presentation), never from a handler. The variation comes from this
// file's own generator: nothing of the game's state is read or changed for it.
//
// Names (game.ts calls them; a `weapon.<id>.<x>` without a cue of its own plays `weapon.<x>`):
//   weapon.<id>.fire        the player's own shot (in the head)
//   weapon.<id>.fire.far    someone else's, at the muzzle: the close file near, the distant one far, blended between
//   weapon.dry              the trigger on an empty magazine
//   weapon.reload           a reload starts: the magazine out (the shotgun: the hand going for shells)
//   weapon.reload.in        the magazine in, part way through (game.ts)
//   weapon.shotgun.shell    a shell into the tube, one per shell the reload loads (game.ts)
//   weapon.reloaded         the reload's end: the charging handle (the shotgun: the pump)
//   weapon.switch           another weapon in hand
//   impact.wall, impact.body  where a round met a wall, a body
//   step, jump, land        the player's (in the head) or another soldier's (at the feet)
//   hurt, death, hit, kill  hit, down; the hit marker, a kill confirmed
//   respawn, round.start, round.won, round.lost, ui.tick
import { audio, type AudioPoint } from "@threert/gameplay";

const DIR = "assets/sounds/";

interface Cue {
  /** Files (assets/sounds/<name>.ogg); one is picked a play, not the same twice in a row. */
  files: readonly string[];
  /** Level at gain 1, and ± the share it varies by. */
  gain: number;
  vary?: number;
  /** ± the playback rate's variation (0.04: four percent either way). */
  pitch?: number;
  /** Metres it keeps its level out to, when it has a place. */
  falloff?: number;
  /** At most once a frame (a shotgun's nine pellets are one hit marker, one hurt). */
  once?: boolean;
}

const GUN_FALLOFF = 8;

const CUES: Record<string, Cue> = {
  "weapon.carbine.fire": { files: ["carbine-1", "carbine-2", "carbine-3"], gain: 0.8, vary: 0.06, pitch: 0.035, falloff: GUN_FALLOFF },
  "weapon.carbine.fire.far": { files: ["carbine-far"], gain: 0.9, vary: 0.08, pitch: 0.04, falloff: GUN_FALLOFF },
  "weapon.shotgun.fire": { files: ["shotgun"], gain: 0.85, vary: 0.05, pitch: 0.03, falloff: GUN_FALLOFF + 2 },
  "weapon.shotgun.fire.far": { files: ["shotgun-far"], gain: 0.9, vary: 0.06, pitch: 0.04, falloff: GUN_FALLOFF + 2 },
  "weapon.marksman.fire": { files: ["marksman"], gain: 0.85, vary: 0.04, pitch: 0.025, falloff: GUN_FALLOFF + 4 },
  "weapon.marksman.fire.far": { files: ["marksman-far"], gain: 0.95, vary: 0.06, pitch: 0.03, falloff: GUN_FALLOFF + 4 },
  "weapon.dry": { files: ["dry"], gain: 1, vary: 0.1, pitch: 0.04, falloff: 2 },
  "weapon.reload": { files: ["mag-out"], gain: 1, vary: 0.1, pitch: 0.04, falloff: 2 },
  "weapon.shotgun.reload": { files: ["switch"], gain: 0.6, vary: 0.1, pitch: 0.06, falloff: 2 },
  "weapon.reload.in": { files: ["mag-in"], gain: 1, vary: 0.1, pitch: 0.04, falloff: 2 },
  "weapon.shotgun.shell": { files: ["shell"], gain: 1, vary: 0.15, pitch: 0.06, falloff: 2 },
  "weapon.reloaded": { files: ["bolt"], gain: 1, vary: 0.08, pitch: 0.03, falloff: 2 },
  "weapon.shotgun.reloaded": { files: ["pump"], gain: 1, vary: 0.08, pitch: 0.03, falloff: 2 },
  "weapon.switch": { files: ["switch"], gain: 1, vary: 0.1, pitch: 0.05, falloff: 2 },
  "impact.wall": { files: ["impact-wall-1", "impact-wall-2", "impact-wall-3"], gain: 0.9, vary: 0.15, pitch: 0.08, falloff: 3 },
  "impact.body": { files: ["impact-body-1", "impact-body-2"], gain: 0.9, vary: 0.1, pitch: 0.07, falloff: 3 },
  "step": { files: ["step-1", "step-2", "step-3", "step-4"], gain: 1, vary: 0.15, pitch: 0.06, falloff: 2.5 },
  "jump": { files: ["jump"], gain: 1, vary: 0.1, pitch: 0.05, falloff: 2.5, once: true },
  "land": { files: ["land"], gain: 1, vary: 0.1, pitch: 0.05, falloff: 3 },
  "hurt": { files: ["hurt"], gain: 0.9, vary: 0.1, pitch: 0.06, once: true },
  "death": { files: ["death"], gain: 1, once: true },
  "hit": { files: ["hit"], gain: 1, vary: 0.05, pitch: 0.02, once: true },
  "kill": { files: ["kill"], gain: 1, once: true },
  "respawn": { files: ["respawn"], gain: 1, once: true },
  "round.start": { files: ["round-start"], gain: 1, once: true },
  "round.won": { files: ["round-won"], gain: 1, once: true },
  "round.lost": { files: ["round-lost"], gain: 1, once: true },
  "ui.tick": { files: ["ui-tick"], gain: 1, pitch: 0.01, once: true },
};

/** Someone else's shot: the close file within NEAR metres, the distant one beyond FAR, both in between. */
const NEAR = 10, FAR = 26;
/** Plays a frame at most (the engine takes 32; a shotgun's pellets and a firefight stay under it). */
const PER_FRAME = 28;

let seed = 0x5eed5;
function random(): number {
  seed = (seed + 0x6d2b79f5) >>> 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const spread = (share = 0) => 1 + share * (2 * random() - 1);

const last = new Map<string, number>();
const once = new Set<string>();
let played = 0;
const ears = { x: 0, y: 0, z: 0 };

function cueOf(name: string): Cue | undefined {
  const cue = CUES[name];
  if (cue) return cue;
  const m = /^weapon\.[^.]+\.(.+)$/.exec(name);
  return m ? CUES[`weapon.${m[1]}`] : undefined;
}

function pick(name: string, cue: Cue): string {
  const n = cue.files.length;
  let i = n > 1 ? Math.floor(random() * n) : 0;
  if (n > 1 && i === last.get(name)) i = (i + 1 + Math.floor(random() * (n - 1))) % n;
  last.set(name, i);
  return DIR + cue.files[i] + ".ogg";
}

function play(name: string, cue: Cue, at: [number, number, number] | undefined, gain: number, pitch: number): void {
  if (played >= PER_FRAME || gain <= 0.02 || (cue.once && once.has(name))) return;
  if (cue.once) once.add(name);
  // (The kill's sound has the hit's tick in it.)
  if (name === "hit" && once.has("kill")) return;
  played++;
  audio.play(pick(name, cue), {
    gain: Math.min(4, cue.gain * gain * spread(cue.vary)),
    pitch,
    ...(at ? { at, falloff: cue.falloff ?? 2 } : {}),
  });
}

function point(p: AudioPoint): [number, number, number] {
  return Array.isArray(p) ? [p[0], p[1], p[2]] as [number, number, number] : [(p as { x: number }).x, (p as { y: number }).y, (p as { z: number }).z];
}

/** Plays `name`: at a place in the world (metres), or (without one) in the player's head. */
export function sound(name: string, at?: AudioPoint, gain = 1): void {
  const cue = cueOf(name);
  if (!cue) return;
  const p = at === undefined ? undefined : point(at);
  const pitch = spread(cue.pitch);
  // Someone else's shot: as it sounds from here.
  if (p && name.endsWith(".fire.far")) {
    const d = Math.hypot(p[0] - ears.x, p[1] - ears.y, p[2] - ears.z);
    const k = Math.min(1, Math.max(0, (d - NEAR) / (FAR - NEAR)));
    const near = CUES[name.slice(0, -4)];
    if (near && k < 1) play(name.slice(0, -4), near, p, gain * Math.sqrt(1 - k), pitch);
    if (k > 0) play(name, cue, p, gain * Math.sqrt(k), pitch);
    return;
  }
  play(name, cue, p, gain, pitch);
}

/** Once a frame, at its end: where the ears were (for near and far shots), and the frame's count starts again. */
export function soundFrame(camera: { x: number; y: number; z: number }): void {
  ears.x = camera.x; ears.y = camera.y; ears.z = camera.z;
  played = 0;
  once.clear();
}

/** Every file, decoded ahead (in setup: a first shot should not wait for its file). */
export function preloadSounds(): void {
  audio.preload([...new Set(Object.values(CUES).flatMap((c) => c.files))].map((f) => DIR + f + ".ogg"));
}
