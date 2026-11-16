// A parsed GoldSrc map as the game takes it (docs/MAPS.md): a GLB to draw, and MapData (collision triangles, spawns,
// the sun, the lamps, ladders, bounds, the hash). Plain TypeScript, run by the game itself (its Maps menu) and by
// tools/import-bsp.ts: `convertSteps` is the conversion a slice at a time (a generator that yields its progress, so
// the game can spread it over frames), `convertBsp` the same all at once.
//
// GoldSrc: Z up, units of about an inch, yaw counter-clockwise from +X. The game: Y up, metres, yaw 0 looks down -Z and
// turns left. (x, y, z) -> (x, z, -y) * 0.0254 is a rotation, so nothing is mirrored.
import { Sha256, collisionBytes } from "../maps/hash.ts";
import type { MapData, MapLight, MapSpawn, Vec3 } from "../maps/types.ts";
import { type Bsp, type Entity, type Face, type Model, CONTENTS_EMPTY, numbers, pointContents } from "./bsp.ts";
import { drain } from "./bytes.ts";
import { GlbWriter, type Json } from "./glb.ts";
import { encodeIndexedPngSteps } from "./png.ts";
import { floorsBelow } from "./rays.ts";
import { type Texture, type Wad, decodeMiptex, wantedWads } from "./wad.ts";

/** Metres per GoldSrc unit. */
export const UNIT = 0.0254;
/** A GoldSrc player's origin is the middle of a 72-unit box: the feet are 36 units below it. */
export const ORIGIN_TO_FEET = 36;

/** A GoldSrc position in the game's space (metres, Y up). */
export function toGame(x: number, y: number, z: number): Vec3 {
  return [x * UNIT, z * UNIT, -y * UNIT];
}

/** A GoldSrc direction in the game's axes (no scale). */
export function toGameDirection(x: number, y: number, z: number): Vec3 {
  return [x, z, -y];
}

/**
 * A GoldSrc yaw (degrees, counter-clockwise from +X seen from above) as the game's (radians, 0 looks down -Z, positive
 * turns left), in (-pi, pi]. GoldSrc 90 (north, +Y) is the game's 0 (-Z).
 */
export function yawFromQuake(degrees: number): number {
  let yaw = ((degrees - 90) * Math.PI) / 180;
  yaw = yaw % (2 * Math.PI);
  if (yaw > Math.PI) yaw -= 2 * Math.PI;
  if (yaw <= -Math.PI) yaw += 2 * Math.PI;
  return yaw;
}

// ------------------------------------------------------------------------------------------------ the light mapping

/** Sun: lux per GoldSrc brightness unit of a white `light_environment`. */
export const SUN_LUX_PER_UNIT = 1000;
export const SUN_LUX_RANGE: [number, number] = [400, 120000];
/** The illuminance a lightmap at full scale (255) stands for, in lux: what ties `light` entities to physical units. */
export const FULL_LIGHTMAP_LUX = 5000;
/**
 * Candela per cubed GoldSrc brightness. The map compiler lights a surface `d` units from a `light` of brightness `b`
 * with b^3 / (10 d^2) on the lightmap's 0..255 scale (it multiplies a light's brightness by its square over ten, then
 * applies the inverse square law in units). With 255 standing for FULL_LIGHTMAP_LUX and d in metres, that is a lamp
 * of this many candela.
 */
export const CANDELA_PER_CUBED_BRIGHTNESS = (FULL_LIGHTMAP_LUX / 255) * UNIT * UNIT / 10;
/** A lamp is at most this bright (a floodlight); below the lower bound it is not worth a light. */
export const LIGHT_CANDELA_RANGE: [number, number] = [0.4, 5000];
/** A `light_environment` that shines upward is a mapper's overcast day: lux of the sky per brightness unit, and its range. */
export const OVERCAST_LUX_PER_UNIT = 100;
export const OVERCAST_LUX_RANGE: [number, number] = [2000, 20000];
export const MAX_LIGHTS = 64;
/** Lights closer than this are one lamp. */
export const LIGHT_MERGE_DISTANCE = 0.5;
/**
 * Texture lights: luminance of a full-white texel, nits. A lamp in these maps is a small texture that stands for a
 * strong fitting (a high-bay lamp, a bare tube), and such textures are what lights most rooms; a sky-light panel is a
 * piece of bright sky in a ceiling; a screen is a screen.
 */
export const TEXTURE_NITS = { lamp: 20000, skylight: 5000, screen: 150 } as const;
/**
 * How much of a texture's saturation its base colour keeps. GoldSrc textures were painted to be lit once, by a
 * lightmap. A path tracer bounces light off them again and again, and every bounce multiplies the colour in: rooms lit
 * by bounced light turn far more orange (or red, or green) than the texture is.
 */
export const ALBEDO_SATURATION = 0.75;

/**
 * GoldSrc textures are dark: the engine drew them through a gamma ramp, under lightmaps that made up for it. Taken as
 * they are, a brick wall reflects 5 % of the light and a room of them stays black whatever lights it. Each texture's
 * mean reflectance is doubled, then kept inside what its material can be (ALBEDO_RANGE), and never lowered or raised
 * more than ALBEDO_MAX_GAIN times.
 */
export const ALBEDO_GAIN = 2;
export const ALBEDO_MAX_GAIN = 4;

/** The gain for a texture of mean linear luminance `mean`, by its material class. */
export function albedoGain(mean: number, material: MaterialClass): number {
  const range = ALBEDO_RANGE[material];
  if (!range || !(mean > 0)) return 1;
  return clamp(clamp(ALBEDO_GAIN * mean, range[0], range[1]) / mean, 1, ALBEDO_MAX_GAIN);
}

/**
 * A palette (256 x RGB) as a base colour, in linear light: lifted by `gain` (x -> g x / (1 + (g - 1) x): dark tones
 * rise g times, white stays white, nothing clips), then `keep` of its saturation kept.
 */
export function baseColorPalette(palette: Uint8Array, gain: number, keep: number): Uint8Array {
  const out = palette.slice();
  const lift = (x: number) => (gain * x) / (1 + (gain - 1) * x);
  for (let i = 0; i + 2 < out.length; i += 3) {
    const r = lift(srgbToLinear(out[i] / 255)), g = lift(srgbToLinear(out[i + 1] / 255)), b = lift(srgbToLinear(out[i + 2] / 255));
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    out[i] = Math.round(clamp(linearToSrgb(Math.max(0, y + (r - y) * keep)), 0, 1) * 255);
    out[i + 1] = Math.round(clamp(linearToSrgb(Math.max(0, y + (g - y) * keep)), 0, 1) * 255);
    out[i + 2] = Math.round(clamp(linearToSrgb(Math.max(0, y + (b - y) * keep)), 0, 1) * 255);
  }
  return out;
}

/** Mean linear luminance of a texture's opaque texels (`masked`: palette index 255 is the key colour). */
export function meanLuminance(t: Texture, masked: boolean): number {
  const weights = new Float64Array(256);
  let count = 0;
  for (let i = 0; i < t.pixels.length; i++) {
    if (masked && t.pixels[i] === 255) continue;
    weights[t.pixels[i]]++;
    count++;
  }
  let sum = 0;
  for (let k = 0; k < 256; k++) {
    if (weights[k]) sum += weights[k] * (0.2126 * srgbToLinear(t.palette[k * 3] / 255) + 0.7152 * srgbToLinear(t.palette[k * 3 + 1] / 255) + 0.0722 * srgbToLinear(t.palette[k * 3 + 2] / 255));
  }
  return count ? sum / count : 0;
}

const srgbToLinear = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const linearToSrgb = (v: number) => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);
const hex = (r: number, g: number, b: number) => (Math.round(Math.min(1, Math.max(0, r)) * 255) << 16) | (Math.round(Math.min(1, Math.max(0, g)) * 255) << 8) | Math.round(Math.min(1, Math.max(0, b)) * 255);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * A `_light` value as the map compiler reads it: "r g b brightness" is the colour scaled so that 255 is `brightness`;
 * "r g b" is taken as it is; one number is a grey. Returns the brightest channel (GoldSrc brightness) and the colour
 * with that channel at 1; null when there is no light in it.
 */
export function parseLight(value: string | undefined, fallback = 300): { brightness: number; color: Vec3 } | null {
  const v = numbers(value);
  let rgb: Vec3;
  if (v.length === 0) rgb = [fallback, fallback, fallback];
  else if (v.length < 3) rgb = [v[0], v[0], v[0]];
  else if (v.length === 3) rgb = [v[0], v[1], v[2]];
  else rgb = [(v[0] / 255) * v[3], (v[1] / 255) * v[3], (v[2] / 255) * v[3]];
  const peak = Math.max(rgb[0], rgb[1], rgb[2]);
  if (!(peak > 0)) return null;
  return { brightness: peak, color: [Math.max(0, rgb[0]) / peak, Math.max(0, rgb[1]) / peak, Math.max(0, rgb[2]) / peak] };
}

/** The direction a `light_environment` or `light_spot` shines in, GoldSrc axes: "angle" (or the yaw of "angles") and "pitch". */
function lightDirection(keys: Record<string, string>): Vec3 {
  const angles = numbers(keys.angles);
  let yaw = numbers(keys.angle)[0] ?? 0;
  let dir: Vec3;
  if (yaw === -1) dir = [0, 0, 1];
  else if (yaw === -2) dir = [0, 0, -1];
  else {
    if (!yaw) yaw = angles[1] ?? 0;
    dir = [Math.cos((yaw * Math.PI) / 180), Math.sin((yaw * Math.PI) / 180), 0];
  }
  const pitch = ((numbers(keys.pitch)[0] || angles[0] || 0) * Math.PI) / 180;
  if (pitch) dir = [dir[0] * Math.cos(pitch), dir[1] * Math.cos(pitch), Math.sin(pitch)];
  return dir;
}

/** `light_environment` -> the sun. Azimuth and elevation say where the sun stands, as `setSunAngles` takes them. */
export function sunFromEntity(e: Entity): NonNullable<MapData["sun"]> | null {
  const env = environment(e);
  if (!env || env.elevation <= 0) return null;
  const round = (v: number, k: number) => Math.round(v * k) / k || 0;
  const illuminance = clamp(SUN_LUX_PER_UNIT * env.brightness * env.luminance, SUN_LUX_RANGE[0], SUN_LUX_RANGE[1]);
  return { azimuth: round(env.azimuth, 100), elevation: round(env.elevation, 100), illuminance: Math.round(illuminance), color: env.color };
}

/**
 * A `light_environment` that shines upward lights nothing directly: mappers use it for an overcast day, where only
 * the sky lights the map. It becomes a uniform sky (colour, luminance in nits) and no sun; null for any other.
 */
export function overcastFromEntity(e: Entity): { color: number; intensity: number } | null {
  const env = environment(e);
  if (!env || env.elevation > 0) return null;
  const lux = clamp(OVERCAST_LUX_PER_UNIT * env.brightness * env.luminance, OVERCAST_LUX_RANGE[0], OVERCAST_LUX_RANGE[1]);
  // A uniform sky of luminance L lights the ground with pi L lux.
  return { color: env.color, intensity: Math.round(lux / Math.PI) };
}

function environment(e: Entity): { azimuth: number; elevation: number; brightness: number; luminance: number; color: number } | null {
  const light = parseLight(e.keys._light, 200);
  if (!light) return null;
  const travel = lightDirection(e.keys);
  const d = toGameDirection(-travel[0], -travel[1], -travel[2]);
  const length = Math.hypot(d[0], d[1], d[2]) || 1;
  const lin = light.color.map(srgbToLinear) as Vec3;
  // GoldSrc suns are painted with a saturated colour because nothing else tinted the scene. The game's sky adds its
  // own blue, so the sun keeps half of its saturation.
  const soft = lin.map((c) => linearToSrgb(0.5 + 0.5 * c)) as Vec3;
  return {
    azimuth: (Math.atan2(d[0], d[2]) * 180) / Math.PI,
    elevation: (Math.asin(clamp(d[1] / length, -1, 1)) * 180) / Math.PI,
    brightness: light.brightness,
    luminance: 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2],
    color: hex(soft[0], soft[1], soft[2]),
  };
}

/** Candela of a `light` / `light_spot` of a GoldSrc brightness, along its axis for a spot. */
export function candelaFromBrightness(brightness: number): number {
  return clamp(CANDELA_PER_CUBED_BRIGHTNESS * brightness ** 3, 0, LIGHT_CANDELA_RANGE[1]);
}

/** `MapLight.power`: the lumens of a point light of that many candela (all round), or of a spot's cone (half angle, radians). */
export function lumens(candela: number, coneHalfAngle?: number): number {
  return candela * (coneHalfAngle === undefined ? 4 * Math.PI : 2 * Math.PI * (1 - Math.cos(coneHalfAngle)));
}

function lightsFromEntities(entities: Entity[]): { lights: MapLight[]; found: number; merged: number; dropped: number } {
  const targets = new Map<string, Vec3>();
  for (const e of entities) {
    const o = numbers(e.keys.origin);
    if (e.keys.targetname && o.length === 3 && !targets.has(e.keys.targetname)) targets.set(e.keys.targetname, [o[0], o[1], o[2]]);
  }
  interface Lamp {
    type: "point" | "spot";
    position: Vec3;
    color: Vec3;
    candela: number;
    direction?: Vec3;
    angle?: number;
  }
  const lamps: Lamp[] = [];
  let found = 0;
  for (const e of entities) {
    if (e.classname !== "light" && e.classname !== "light_spot") continue;
    found++;
    const o = numbers(e.keys.origin);
    const light = parseLight(e.keys._light);
    // Spawn flag 1: the light starts dark (a switched light nobody has switched on).
    if (o.length !== 3 || !light || (Number(e.keys.spawnflags) & 1) === 1 || numbers(e.keys._sky)[0]) continue;
    const candela = candelaFromBrightness(light.brightness);
    if (candela < LIGHT_CANDELA_RANGE[0]) continue;
    const lamp: Lamp = { type: "point", position: toGame(o[0], o[1], o[2]), color: light.color, candela };
    const aim = e.keys.target ? targets.get(e.keys.target) : undefined;
    if (e.classname === "light_spot" || aim) {
      let d: Vec3 = aim ? [aim[0] - o[0], aim[1] - o[1], aim[2] - o[2]] : lightDirection(e.keys);
      const length = Math.hypot(d[0], d[1], d[2]);
      if (length < 1e-6) d = [0, 0, -1];
      else d = [d[0] / length, d[1] / length, d[2] / length];
      const inner = numbers(e.keys._cone)[0] || 10;
      const outer = Math.max(inner, numbers(e.keys._cone2)[0] || 0);
      lamp.type = "spot";
      lamp.direction = toGameDirection(d[0], d[1], d[2]);
      lamp.angle = (clamp(outer, 1, 89) * Math.PI) / 180;
    }
    lamps.push(lamp);
  }
  // Lamps that share a place are one lamp: the brightest first, the others add to it.
  lamps.sort((a, b) => b.candela - a.candela);
  const merged: (Lamp & { weight: number })[] = [];
  for (const l of lamps) {
    const near = merged.find((m) => m.type === l.type && Math.hypot(m.position[0] - l.position[0], m.position[1] - l.position[1], m.position[2] - l.position[2]) < LIGHT_MERGE_DISTANCE);
    if (!near) {
      merged.push({ ...l, weight: l.candela });
      continue;
    }
    const w = l.candela / (near.weight + l.candela);
    near.position = near.position.map((v, i) => v + (l.position[i] - v) * w) as Vec3;
    near.color = near.color.map((v, i) => v + (l.color[i] - v) * w) as Vec3;
    near.weight += l.candela;
    near.candela = Math.min(LIGHT_CANDELA_RANGE[1], near.candela + l.candela);
  }
  merged.sort((a, b) => b.candela - a.candela);
  const kept = merged.slice(0, MAX_LIGHTS);
  const r3 = (v: Vec3) => v.map((c) => Math.round(c * 1000) / 1000 || 0) as Vec3;
  const lights = kept.map((l): MapLight => {
    const out: MapLight = { type: l.type, position: r3(l.position), color: hex(l.color[0], l.color[1], l.color[2]), power: Math.round(lumens(l.candela, l.type === "spot" ? l.angle : undefined)), radius: 0.05 };
    if (l.type === "spot" && l.direction) {
      out.target = r3([l.position[0] + l.direction[0], l.position[1] + l.direction[1], l.position[2] + l.direction[2]]);
      out.angle = Math.round(l.angle! * 10000) / 10000;
    }
    return out;
  });
  return { lights, found, merged: lamps.length - merged.length, dropped: merged.length - kept.length };
}

// ------------------------------------------------------------------------------------------------ what a texture is

export type Surface = "sky" | "tool" | "water" | "masked" | "opaque";

/** A texture name without its markers: `{` (masked), `+0` .. `+9` / `+a` .. `+j` (animated, toggled), `-0` .. `-9` (random tiling). */
export function baseName(name: string): { base: string; frame: string } {
  let n = name.toLowerCase();
  let frame = "";
  if (n.startsWith("{")) n = n.slice(1);
  if ((n[0] === "+" || n[0] === "-") && n.length > 2) {
    frame = n.slice(0, 2);
    n = n.slice(2);
  }
  return { base: n, frame };
}

const TOOL_TEXTURES = new Set(["clip", "origin", "aaatrigger", "null", "hint", "skip", "bevel", "trigger", "noclip", "solidhint", "boundingbox", "contentempty", "contentwater", "translucent"]);

/** How faces with a texture are treated, by its name (the engine's own rules: sky*, !*, water*, {*). */
export function surfaceOf(name: string): Surface {
  const n = name.toLowerCase();
  if (n.startsWith("sky")) return "sky";
  if (TOOL_TEXTURES.has(n)) return "tool";
  if (n.startsWith("!") || n.startsWith("water") || n.startsWith("laser")) return "water";
  if (n.startsWith("{")) return "masked";
  return "opaque";
}

/**
 * A texture light, and what kind. The map compiler takes them from a list (lights.rad) that is not in the map; the
 * names follow a convention, which is what is used here: `~` marks a light, `skkylite` panels are sky lights. `listed`
 * adds the names of a lights.rad (lower case) when there is one.
 */
export function textureLight(name: string, listed?: ReadonlySet<string>): keyof typeof TEXTURE_NITS | null {
  const { base, frame } = baseName(name);
  // `+a` .. `+j` are the frames of a light that has been switched off.
  if (frame[0] === "+" && frame[1] >= "a") return null;
  if (/^~?(skkylite|skylite)/.test(base)) return "skylight";
  if (!base.startsWith("~") && !listed?.has(name.toLowerCase())) return null;
  return /comp|crt|scrn|screen|monitor|_pan|lock|elev|tv/.test(base) ? "screen" : "lamp";
}

/** The texture names of a lights.rad file ("name r g b brightness" lines), lower case. */
export function parseRad(text: string): Set<string> {
  const names = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const words = line.replace(/\/\/.*$/, "").trim().split(/\s+/);
    if (words.length >= 2 && words[0] && Number.isFinite(Number(words[1]))) names.add(words[0].toLowerCase());
  }
  return names;
}

export type MaterialClass = "concrete" | "painted" | "metal" | "wood" | "ground" | "glass" | "black";

/** What a surface is made of, guessed from the texture's name. */
export function materialClass(name: string): MaterialClass {
  const n = baseName(name).base.replace(/^~/, "");
  const has = (...keys: string[]) => keys.some((k) => n.includes(k));
  if (n === "black") return "black";
  if (has("glass", "skkylite", "skylite", "skkylight", "window", "wndw")) return "glass";
  if (has("crate", "box", "wood", "plank", "pallet", "barrel") && !has("out_box")) return "wood";
  if (has("galv", "silo", "duct", "vent", "drkmtl", "rail", "ladder", "fence", "razor", "tension", "grate", "pipe", "metal", "mtl", "steel", "tankrear", "trk_rim", "trk_grille", "trk_bumper", "pfab", "rung", "gate")) return "metal";
  if (has("trk_", "container", "out_box", "out_dmp", "door", "sign", "stripes", "generic", "comp", "recharg", "viewscreen", "pow", "paint")) return "painted";
  if (has("grss", "grass", "gravel", "dirt", "sand", "pave", "sidewlk", "flr", "floor", "stp", "grnd", "ground", "road", "mud")) return "ground";
  return "concrete";
}

/** Mean reflectance a material can have (linear); none: the texture is left as it is. */
const ALBEDO_RANGE: Record<MaterialClass, [number, number] | null> = {
  concrete: [0.16, 0.45],
  painted: [0.1, 0.5],
  metal: [0.2, 0.55],
  wood: [0.12, 0.4],
  ground: [0.1, 0.4],
  glass: null,
  black: null,
};

const LOOKS: Record<MaterialClass, { roughness: number; metalness: number }> = {
  concrete: { roughness: 0.9, metalness: 0 },
  painted: { roughness: 0.55, metalness: 0 },
  metal: { roughness: 0.45, metalness: 0.6 },
  wood: { roughness: 0.75, metalness: 0 },
  ground: { roughness: 0.95, metalness: 0 },
  glass: { roughness: 0.08, metalness: 0 },
  black: { roughness: 0.6, metalness: 0 },
};

// ------------------------------------------------------------------------------------------------ brush entities

export interface BrushRole {
  /** Its faces are drawn. */
  draw: boolean;
  /** Bodies and bullets hit it. */
  solid: boolean;
  ladder: boolean;
  water: boolean;
  /** Translucent (render mode "texture" with an amount below opaque): how much light passes, 0..1. */
  transmission: number;
}

const ZONES = new Set(["func_buyzone", "func_bomb_target", "func_hostage_rescue", "func_escapezone", "func_vip_safetyzone", "func_monsterclip", "func_mortar_field", "func_friction", "func_grencatch", "func_weaponcheck", "func_rain", "func_snow"]);
const NOT_SOLID = new Set(["func_illusionary", "func_water"]);

/** What a brush entity is to the map. Doors, buttons, breakables and trains stay where the map file has them, closed and whole. */
export function brushRole(e: Entity): BrushRole {
  const c = e.classname;
  const role: BrushRole = { draw: true, solid: true, ladder: false, water: false, transmission: 0 };
  if (c === "func_ladder") return { ...role, draw: false, solid: false, ladder: true };
  // Volumes that are felt, not seen or hit; and what is not there when the map starts.
  if (c.startsWith("trigger") || c.startsWith("env_") || ZONES.has(c) || (c === "func_wall_toggle" && (Number(e.keys.spawnflags) & 1) === 1)) return { ...role, draw: false, solid: false };
  if (NOT_SOLID.has(c)) role.solid = false;
  if (c === "func_water") role.water = true;
  const mode = Number(e.keys.rendermode) || 0;
  const amount = Number(e.keys.renderamt) || 0;
  if (mode === 3 || mode === 5) role.draw = false;            // glow, additive: light effects, not surfaces
  else if (mode !== 0 && amount <= 0) role.draw = false;      // an invisible wall
  else if ((mode === 1 || mode === 2) && amount < 250 && !role.water) role.transmission = clamp(1 - amount / 255, 0.2, 0.95);
  return role;
}

// ------------------------------------------------------------------------------------------------ the conversion

export interface ConvertOptions {
  id: string;
  /** WAD archives to take textures from, in order. */
  wads?: Wad[];
  /** Texture names a lights.rad lists as lights (lower case), on top of the naming convention. */
  lightTextures?: ReadonlySet<string>;
  /** false: no `lights` (--no-relight). */
  relight?: boolean;
  /** What the map file was called, for the credits. */
  source?: string;
  /** `MapData.glb`: where the game finds the GLB (default `assets/maps/<id>/map.glb`; the game's own store: `user:maps/<id>/map.glb`). */
  glb?: string;
}

/** How far a conversion is: what it is doing, and the fraction of the whole done (0..1). */
export interface ConvertProgress {
  stage: "faces" | "textures" | "spawns" | "hash";
  done: number;
}

export interface ConvertStats {
  faces: number;
  facesDrawn: number;
  skyFaces: number;
  triangles: number;
  primitives: number;
  textures: { used: number; embedded: number; fromWads: number; missing: string[]; wadsAsked: string[]; wadsUsed: string[] };
  emissiveTextures: string[];
  brushEntities: { drawn: number; solid: number; skipped: number };
  collision: { vertices: number; triangles: number };
  spawns: { a: number; b: number; any: number; inSolid: number; noFloor: number };
  lights: { found: number; merged: number; dropped: number; kept: number };
  ladders: number;
  water: number;
}

export interface Converted {
  map: MapData;
  glb: Uint8Array;
  stats: ConvertStats;
  warnings: string[];
}

interface Bucket {
  texture: number;
  variant: string;
  positions: number[];
  normals: number[];
  uvs: number[];
  indices: number[];
}

/** A stand-in for a texture no WAD has: a checker nobody takes for a wall. */
function placeholder(name: string, width: number, height: number): Texture {
  const w = width > 0 && width <= 1024 ? width : 64, h = height > 0 && height <= 1024 ? height : 64;
  const pixels = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) pixels[y * w + x] = ((x >> 3) + (y >> 3)) & 1;
  const palette = new Uint8Array(768);
  palette.set([255, 0, 255, 24, 0, 24]);
  return { name, width: w, height: h, pixels, palette };
}

/** map.json: one line per field (the collision arrays are long). */
export function mapJson(map: MapData): string {
  return `{\n${Object.entries(map).map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(",\n")}\n}\n`;
}

/** The conversion all at once. */
export function convertBsp(bsp: Bsp, options: ConvertOptions): Converted {
  return drain(convertSteps(bsp, options));
}

/** The conversion a slice at a time: yields its progress every millisecond or so of work, returns the map. */
export function* convertSteps(bsp: Bsp, options: ConvertOptions): Generator<ConvertProgress, Converted> {
  const warnings: string[] = [];
  const world = bsp.entities.find((e) => e.classname === "worldspawn") ?? { classname: "worldspawn", keys: {} };

  // -------------------------------------------------------------------------------------------- textures
  const wads = options.wads ?? [];
  const wadsAsked = wantedWads(world.keys.wad);
  const wadsUsed = new Set<string>();
  const missing: string[] = [];
  let embedded = 0, fromWads = 0;
  const sources = new Map<number, string>();
  const counted = new Set<number>();
  const resolved = new Map<number, Texture>();
  const texture = (index: number): Texture => {
    let t = resolved.get(index);
    if (t) return t;
    const entry = bsp.textures[index] ?? { name: "", width: 0, height: 0, data: null };
    let decoded = entry.data ? decodeMiptex(entry.data) : null;
    let source = decoded ? "map" : "missing";
    if (!decoded) {
      for (const wad of wads) {
        const record = wad.entries.get(entry.name.toLowerCase());
        decoded = record ? decodeMiptex(record) : null;
        if (decoded) {
          source = wad.name;
          break;
        }
      }
    }
    if (!decoded) decoded = placeholder(entry.name, entry.width, entry.height);
    sources.set(index, source);
    t = { ...decoded, name: entry.name || decoded.name };
    resolved.set(index, t);
    return t;
  };

  // -------------------------------------------------------------------------------------------- faces
  // The models that are part of the static map: the world, and the brush entities that stand in it.
  const included: { model: Model; offset: Vec3; role: BrushRole }[] = [{ model: bsp.models[0], offset: [0, 0, 0], role: { draw: true, solid: true, ladder: false, water: false, transmission: 0 } }];
  const ladders: NonNullable<MapData["ladders"]> = [];
  const brushStats = { drawn: 0, solid: 0, skipped: 0 };
  for (const e of bsp.entities) {
    const match = /^\*(\d+)$/.exec(e.keys.model ?? "");
    if (!match) continue;
    const model = bsp.models[Number(match[1])];
    if (!model || Number(match[1]) === 0) continue;
    const o = numbers(e.keys.origin);
    const offset: Vec3 = o.length === 3 ? [o[0], o[1], o[2]] : [0, 0, 0];
    const role = brushRole(e);
    if (role.ladder) {
      const a = toGame(model.mins[0] + offset[0], model.mins[1] + offset[1], model.mins[2] + offset[2]);
      const b = toGame(model.maxs[0] + offset[0], model.maxs[1] + offset[1], model.maxs[2] + offset[2]);
      const r = (v: number) => Math.round(v * 1e4) / 1e4 || 0;
      ladders.push({ min: [r(Math.min(a[0], b[0])), r(Math.min(a[1], b[1])), r(Math.min(a[2], b[2]))], max: [r(Math.max(a[0], b[0])), r(Math.max(a[1], b[1])), r(Math.max(a[2], b[2]))] });
      continue;
    }
    if (!role.draw && !role.solid) {
      brushStats.skipped++;
      continue;
    }
    if (role.draw) brushStats.drawn++;
    if (role.solid) brushStats.solid++;
    included.push({ model, offset, role });
  }

  const buckets = new Map<string, Bucket>();
  const collisionPositions: number[] = [];
  const collisionIndices: number[] = [];
  const welded = new Map<string, number>();
  const seenTriangles = new Set<string>();
  const weld = (p: Vec3): number => {
    const x = Math.round(p[0] * 1e5), y = Math.round(p[1] * 1e5), z = Math.round(p[2] * 1e5);
    const key = `${x},${y},${z}`;
    let index = welded.get(key);
    if (index === undefined) {
      index = collisionPositions.length / 3;
      // (x || 0: no negative zero in the file.)
      collisionPositions.push(x / 1e5 || 0, y / 1e5 || 0, z / 1e5 || 0);
      welded.set(key, index);
    }
    return index;
  };
  // Water is drawn once: the compiler writes each water face twice, back to back.
  const waterSeen = new Set<string>();
  let facesDrawn = 0, skyFaces = 0, triangles = 0, waterFaces = 0, faceCount = 0;
  const transparentTextures = new Set<number>();
  const isBlank = (index: number): boolean => {
    // A masked texture with no opaque texel ({invisible, {blue): nothing to draw.
    const t = texture(index);
    for (let i = 0; i < t.pixels.length; i++) if (t.pixels[i] !== 255) return false;
    return true;
  };

  const allFaces = included.reduce((n, m) => n + m.model.numFaces, 0) || 1;
  for (const { model, offset, role } of included) {
    for (let fi = model.firstFace; fi < model.firstFace + model.numFaces; fi++) {
      const face: Face = bsp.faces[fi];
      faceCount++;
      if (faceCount % 40 === 0) yield { stage: "faces", done: 0.45 * (faceCount / allFaces) };
      const info = bsp.texinfo[face.texinfo];
      const entry = bsp.textures[info.miptex] ?? { name: "", width: 0, height: 0, data: null };
      const surface = role.water && surfaceOf(entry.name) !== "tool" && surfaceOf(entry.name) !== "sky" ? "water" : surfaceOf(entry.name);

      // The polygon, in the model's own space (texture coordinates are taken there).
      const poly: Vec3[] = [];
      for (let k = 0; k < face.numEdges; k++) {
        const se = bsp.surfedges[face.firstEdge + k];
        const v = se >= 0 ? bsp.edges[se * 2] : bsp.edges[-se * 2 + 1];
        const p: Vec3 = [bsp.vertices[v * 3], bsp.vertices[v * 3 + 1], bsp.vertices[v * 3 + 2]];
        const last = poly[poly.length - 1];
        if (!last || last[0] !== p[0] || last[1] !== p[1] || last[2] !== p[2]) poly.push(p);
      }
      if (poly.length < 3) continue;
      const sign = face.side ? -1 : 1;
      const n: Vec3 = [bsp.planes[face.plane * 4] * sign, bsp.planes[face.plane * 4 + 1] * sign, bsp.planes[face.plane * 4 + 2] * sign];
      // Which way the vertices go round, against the plane's normal (Newell): triangles are written counter-clockwise
      // seen from the front, as glTF and the game want them. GoldSrc winds clockwise.
      let nx = 0, ny = 0, nz = 0;
      for (let k = 0; k < poly.length; k++) {
        const a = poly[k], b = poly[(k + 1) % poly.length];
        nx += (a[1] - b[1]) * (a[2] + b[2]);
        ny += (a[2] - b[2]) * (a[0] + b[0]);
        nz += (a[0] - b[0]) * (a[1] + b[1]);
      }
      const reversed = nx * n[0] + ny * n[1] + nz * n[2] < 0;
      const turn = reversed ? -1 : 1;
      // A fan from the first vertex (faces are convex). Slivers on collinear points (the compiler adds vertices along
      // edges where other faces meet them) have no area to speak of and are left out.
      const fan: [number, number, number][] = [];
      for (let k = 1; k + 1 < poly.length; k++) {
        const a = poly[0], b = poly[k], c = poly[k + 1];
        const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
        const along = ((uy * vz - uz * vy) * n[0] + (uz * vx - ux * vz) * n[1] + (ux * vy - uy * vx) * n[2]) * turn;
        if (along < 0.02) continue;
        fan.push(reversed ? [0, k + 1, k] : [0, k, k + 1]);
      }
      if (fan.length === 0) continue;
      const placed = poly.map((p) => toGame(p[0] + offset[0], p[1] + offset[1], p[2] + offset[2]));

      // Collision: everything solid, drawn or not (the sky's faces close the map in; water is not solid).
      if (role.solid && surface !== "water" && surface !== "tool") {
        const ids = placed.map(weld);
        for (const [a, b, c] of fan) {
          const i = ids[a], j = ids[b], k = ids[c];
          if (i === j || j === k || i === k) continue;
          // The same triangle twice (two brushes back to back) is kept once; the same corners wound the other way is
          // another side and stays.
          const key = i < j && i < k ? `${i},${j},${k}` : j < k ? `${j},${k},${i}` : `${k},${i},${j}`;
          if (seenTriangles.has(key)) continue;
          seenTriangles.add(key);
          collisionIndices.push(i, j, k);
        }
      }

      // What is drawn.
      if (surface === "sky") {
        skyFaces++;
        continue;
      }
      if (!role.draw || surface === "tool") continue;
      if (surface === "masked") {
        if (!transparentTextures.has(info.miptex) && isBlank(info.miptex)) transparentTextures.add(info.miptex);
        if (transparentTextures.has(info.miptex)) continue;
      }
      if (surface === "water") {
        // A sheet of water faces up, whichever of the pair comes first.
        if (n[2] < -0.5) {
          n[0] = -n[0];
          n[1] = -n[1];
          n[2] = -n[2];
          for (const tri of fan) [tri[1], tri[2]] = [tri[2], tri[1]];
        }
        const key = placed.map((p) => p.map((c) => Math.round(c * 1e4)).join(",")).sort().join(";");
        if (waterSeen.has(key)) continue;
        waterSeen.add(key);
        waterFaces++;
      }
      const variant = surface === "water" ? "water" : role.transmission > 0 ? `glass${Math.round(role.transmission * 100)}` : surface;
      const bucketKey = `${info.miptex}:${variant}`;
      let bucket = buckets.get(bucketKey);
      if (!bucket) buckets.set(bucketKey, (bucket = { texture: info.miptex, variant, positions: [], normals: [], uvs: [], indices: [] }));
      const tex = texture(info.miptex);
      const base = bucket.positions.length / 3;
      const normal = toGameDirection(n[0], n[1], n[2]);
      const us: number[] = [], vs: number[] = [];
      for (const p of poly) {
        us.push((p[0] * info.s[0] + p[1] * info.s[1] + p[2] * info.s[2] + info.sShift) / tex.width);
        vs.push((p[0] * info.t[0] + p[1] * info.t[1] + p[2] * info.t[2] + info.tShift) / tex.height);
      }
      // Whole repeats are taken off, so coordinates stay near zero (the texture tiles).
      const u0 = Math.floor(Math.min(...us)), v0 = Math.floor(Math.min(...vs));
      for (let k = 0; k < poly.length; k++) {
        bucket.positions.push(placed[k][0], placed[k][1], placed[k][2]);
        bucket.normals.push(normal[0], normal[1], normal[2]);
        bucket.uvs.push(us[k] - u0, vs[k] - v0);
      }
      for (const [a, b, c] of fan) bucket.indices.push(base + a, base + b, base + c);
      triangles += fan.length;
      facesDrawn++;
    }
  }

  // -------------------------------------------------------------------------------------------- the GLB
  const glb = new GlbWriter();
  const images: Json[] = [], textures: Json[] = [], materials: Json[] = [], primitives: Json[] = [];
  const extensions = new Set<string>();
  const emissiveTextures: string[] = [];
  const imageOf = new Map<string, number>();
  const image = function* (index: number, masked: boolean): Generator<unknown, number> {
    const key = `${index}:${masked}`;
    let at = imageOf.get(key);
    if (at !== undefined) return at;
    const t = texture(index);
    if (!counted.has(index)) {
      // Counted when drawn: the map also lists textures nothing visible uses.
      counted.add(index);
      const source = sources.get(index)!;
      if (source === "map") embedded++;
      else if (source === "missing") missing.push(t.name || `#${index}`);
      else {
        fromWads++;
        wadsUsed.add(source);
      }
    }
    // Lamps keep their colour; everything else is a surface light bounces off.
    let palette = textureLight(t.name, options.lightTextures) || sources.get(index) === "missing" ? t.palette : baseColorPalette(t.palette, albedoGain(meanLuminance(t, masked), materialClass(t.name)), ALBEDO_SATURATION);
    if (masked) {
      // Palette entry 255 is the key colour (blue). It is made transparent, and given the texture's mean colour so
      // that filtering does not bleed blue into the edges.
      const sum = [0, 0, 0];
      let count = 0;
      for (let i = 0; i < t.pixels.length; i++) {
        const k = t.pixels[i];
        if (k === 255) continue;
        sum[0] += palette[k * 3];
        sum[1] += palette[k * 3 + 1];
        sum[2] += palette[k * 3 + 2];
        count++;
      }
      palette = palette.slice();
      for (let c = 0; c < 3; c++) palette[765 + c] = count ? Math.round(sum[c] / count) : 0;
    }
    yield;
    const png = yield* encodeIndexedPngSteps(t.width, t.height, t.pixels, palette, masked ? 255 : undefined);
    images.push({ name: t.name, bufferView: glb.view(png), mimeType: "image/png" });
    textures.push({ source: images.length - 1, sampler: 0 });
    at = textures.length - 1;
    imageOf.set(key, at);
    return at;
  };

  const ordered = [...buckets.values()].sort((a, b) => a.texture - b.texture || (a.variant < b.variant ? -1 : a.variant > b.variant ? 1 : 0));
  for (const [k, b] of ordered.entries()) {
    const done = 0.45 + 0.35 * (k / ordered.length);
    yield { stage: "textures", done };
    const t = texture(b.texture);
    const masked = b.variant === "masked" || (b.variant !== "water" && surfaceOf(t.name) === "masked");
    const look = LOOKS[materialClass(t.name)];
    const tex = yield* progress(image(b.texture, masked), () => ({ stage: "textures", done }));
    const material: Json = { name: b.variant === "opaque" || b.variant === "masked" ? t.name : `${t.name} (${b.variant})`, pbrMetallicRoughness: { baseColorTexture: { index: tex }, metallicFactor: look.metalness, roughnessFactor: look.roughness } };
    if (masked) {
      material.alphaMode = "MASK";
      material.alphaCutoff = 0.5;
      material.doubleSided = true;
    }
    if (b.variant === "water") {
      material.pbrMetallicRoughness.metallicFactor = 0;
      material.pbrMetallicRoughness.roughnessFactor = 0.03;
      material.extensions = { KHR_materials_transmission: { transmissionFactor: 0.8 }, KHR_materials_ior: { ior: 1.33 } };
      material.doubleSided = true;
      extensions.add("KHR_materials_transmission").add("KHR_materials_ior");
    } else if (b.variant.startsWith("glass")) {
      material.pbrMetallicRoughness.metallicFactor = 0;
      material.pbrMetallicRoughness.roughnessFactor = 0.05;
      material.extensions = { KHR_materials_transmission: { transmissionFactor: Number(b.variant.slice(5)) / 100 } };
      material.doubleSided = true;
      extensions.add("KHR_materials_transmission");
    }
    const lit = textureLight(t.name, options.lightTextures);
    if (lit && b.variant !== "water" && sources.get(b.texture) !== "missing") {
      material.emissiveTexture = { index: tex };
      material.emissiveFactor = [1, 1, 1];
      material.extensions = { ...material.extensions, KHR_materials_emissive_strength: { emissiveStrength: TEXTURE_NITS[lit] } };
      extensions.add("KHR_materials_emissive_strength");
      if (!emissiveTextures.includes(t.name)) emissiveTextures.push(t.name);
    }
    materials.push(material);
    primitives.push({
      attributes: { POSITION: glb.attribute(new Float32Array(b.positions), 3, true), NORMAL: glb.attribute(new Float32Array(b.normals), 3), TEXCOORD_0: glb.attribute(new Float32Array(b.uvs), 2) },
      indices: glb.indices(new Uint32Array(b.indices), b.positions.length / 3),
      material: materials.length - 1,
      mode: 4,
    });
  }
  const doc: Json = { asset: { version: "2.0", generator: "OpenStrikeRT tools/import-bsp.ts" }, scene: 0, scenes: [{ nodes: primitives.length ? [0] : [] }] };
  if (primitives.length) {
    doc.nodes = [{ name: options.id, mesh: 0 }];
    doc.meshes = [{ name: options.id, primitives }];
    doc.materials = materials;
    doc.textures = textures;
    doc.images = images;
    doc.samplers = [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }];
  }
  if (extensions.size) doc.extensionsUsed = [...extensions].sort();
  yield { stage: "textures", done: 0.8 };
  const glbBytes = yield* progress(glb.finishSteps(doc), () => ({ stage: "textures", done: 0.8 }));
  yield { stage: "spawns", done: 0.8 };

  // -------------------------------------------------------------------------------------------- map data
  const collision = { positions: collisionPositions, indices: collisionIndices };
  yield { stage: "spawns", done: 0.8 };
  const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < collisionPositions.length; i++) {
    const k = i % 3;
    if (collisionPositions[i] < min[k]) min[k] = collisionPositions[i];
    if (collisionPositions[i] > max[k]) max[k] = collisionPositions[i];
  }
  if (collisionPositions.length === 0) {
    const a = toGame(...bsp.models[0].mins), b = toGame(...bsp.models[0].maxs);
    for (let k = 0; k < 3; k++) {
      min[k] = Math.round(Math.min(a[k], b[k]) * 1e5) / 1e5 || 0;
      max[k] = Math.round(Math.max(a[k], b[k]) * 1e5) / 1e5 || 0;
    }
    warnings.push("the map has no solid faces: nothing to stand on");
  }

  // Spawns: info_player_start is where Counter-Strike puts the counter-terrorists, info_player_deathmatch the
  // terrorists. A map with only one of the two (a deathmatch map) spawns anyone anywhere.
  yield { stage: "spawns", done: 0.8 };
  const starts = bsp.entities.filter((e) => e.classname === "info_player_start" || e.classname === "info_player_deathmatch");
  const both = starts.some((e) => e.classname === "info_player_start") && starts.some((e) => e.classname === "info_player_deathmatch");
  const spawns: MapSpawn[] = [];
  const spawnStats = { a: 0, b: 0, any: 0, inSolid: 0, noFloor: 0 };
  const starting = starts.filter((e) => numbers(e.keys.origin).length === 3);
  const centres = starting.map((e) => {
    const o = numbers(e.keys.origin);
    return toGame(o[0], o[1], o[2]);
  });
  const floors = yield* progress(floorsBelow(collision, centres, ORIGIN_TO_FEET * UNIT + 2), (f) => ({ stage: "spawns", done: 0.8 + 0.1 * f }));
  for (const [k, e] of starting.entries()) {
    const o = numbers(e.keys.origin);
    const angles = numbers(e.keys.angles);
    const yaw = yawFromQuake(angles.length >= 2 ? angles[1] : numbers(e.keys.angle)[0] ?? 0);
    const team = both ? (e.classname === "info_player_start" ? "a" : "b") : "any";
    const centre = toGame(o[0], o[1], o[2]);
    if (pointContents(bsp, bsp.models[0], o[0], o[1], o[2]) !== CONTENTS_EMPTY) spawnStats.inSolid++;
    // The entity's origin is the middle of the player; mappers leave it a little above the ground and the player
    // drops. The feet go on the floor that is under it (a centimetre above).
    const nominal = centre[1] - ORIGIN_TO_FEET * UNIT;
    const floor = floors[k];
    if (floor === null) spawnStats.noFloor++;
    const feet = floor === null ? nominal : floor + 0.01;
    const r = (v: number) => Math.round(v * 1e4) / 1e4 || 0;
    spawns.push({ team, position: [r(centre[0]), r(feet), r(centre[2])], yaw: Math.round(yaw * 1e4) / 1e4 || 0 });
    spawnStats[team]++;
  }
  if (spawns.length === 0) warnings.push("the map has no info_player_start or info_player_deathmatch: no spawns");
  if (spawnStats.inSolid) warnings.push(`${spawnStats.inSolid} spawn(s) are inside a solid in the map file`);
  if (spawnStats.noFloor) warnings.push(`${spawnStats.noFloor} spawn(s) have no floor within 2 m under them`);

  const sunEntity = bsp.entities.find((e) => e.classname === "light_environment");
  const sun = sunEntity ? sunFromEntity(sunEntity) : null;
  const overcast = sunEntity && !sun ? overcastFromEntity(sunEntity) : null;
  const lit = options.relight === false ? { lights: [], found: bsp.entities.filter((e) => e.classname === "light" || e.classname === "light_spot").length, merged: 0, dropped: 0 } : lightsFromEntities(bsp.entities);

  // The hash (collisionBytes' bytes), a slice at a time.
  const hashed = new Sha256();
  const chunk = 1 << 13;
  for (const [list, float] of [[collisionPositions, true], [collisionIndices, false]] as const) {
    for (let at = 0; at < list.length; at += chunk / 4) {
      const part = list.slice(at, at + chunk / 4);
      hashed.update(float ? collisionBytes(part, []) : collisionBytes([], part));
      yield { stage: "hash", done: 0.9 + 0.1 * (float ? 0.4 * (at / list.length) : 0.4 + 0.6 * (at / list.length)) };
    }
  }
  const title = (world.keys.message ?? "").trim() || options.id;
  const map: MapData = {
    id: options.id,
    title,
    credits: `Imported from ${options.source ?? "a GoldSrc map"}. The map belongs to its authors; this copy is for the person who imported it and is not to be shared.`,
    glb: options.glb ?? `assets/maps/${options.id}/map.glb`,
    collision,
    spawns,
    ...(sun ? { sun } : {}),
    sky: overcast ?? "atmosphere",
    lights: lit.lights,
    bounds: { min, max },
    killY: Math.round((min[1] - 5) * 100) / 100,
    ...(ladders.length ? { ladders } : {}),
    hash: hashed.hex(),
  };

  if (missing.length) {
    const asked = wadsAsked.length ? `The map asks for ${wadsAsked.join(", ")}` : "The map names no WAD";
    const have = new Set(wads.map((w) => w.name.toLowerCase()));
    const absent = wadsAsked.filter((w) => !have.has(w));
    warnings.push(`${missing.length} texture(s) not found, drawn as a magenta checker: ${missing.slice(0, 12).join(", ")}${missing.length > 12 ? ", ..." : ""}. ${asked}${absent.length ? `; not found: ${absent.join(", ")} (give their directory with --wad)` : ""}.`);
  }

  return {
    map,
    glb: glbBytes,
    warnings,
    stats: {
      faces: faceCount,
      facesDrawn,
      skyFaces,
      triangles,
      primitives: primitives.length,
      textures: { used: counted.size, embedded, fromWads, missing, wadsAsked, wadsUsed: [...wadsUsed] },
      emissiveTextures,
      brushEntities: brushStats,
      collision: { vertices: collisionPositions.length / 3, triangles: collisionIndices.length / 3 },
      spawns: spawnStats,
      lights: { found: lit.found, merged: lit.merged, dropped: lit.dropped, kept: lit.lights.length },
      ladders: ladders.length,
      water: waterFaces,
    },
  };
}

/** A generator's progress (a fraction) as the conversion's own. */
function* progress<R, Y>(g: Generator<Y, R>, as: (f: Y) => ConvertProgress): Generator<ConvertProgress, R> {
  for (;;) {
    const r = g.next();
    if (r.done) return r.value;
    yield as(r.value);
  }
}
