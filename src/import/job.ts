// Importing a map in the game: from a folder the player picked (their own copy of Counter-Strike or Half-Life) to a
// map in the app's store on this device (docs/MAPS.md "Importing in the game"). One generator for the whole of it,
// run a few milliseconds a frame (sliced.ts): read the BSP, find and read the WADs it needs, convert (convert.ts),
// write `maps/<id>/map.glb` and then `maps/<id>/map.json` (the map is there once its map.json is).
//
// Nothing of it leaves the device: the files are read from the player's pick and written to the app's store only.
import type { MapData } from "../maps/types.ts";
import { type Bsp, ImportError, parseBspSteps } from "./bsp.ts";
import { fromBase64, latin1, toBase64 } from "./bytes.ts";
import { type ConvertStats, convertSteps, mapJson, parseRad } from "./convert.ts";
import { type Entry, files, store } from "./host.ts";
import type { Progress } from "./sliced.ts";
import { type Wad, parseWad, wadDirectory, wadHeader, wantedWads } from "./wad.ts";

export const ID_PATTERN = /^[a-z0-9_-]+$/;
/** What the picker is asked for. */
export const ACCEPT = [".bsp", ".wad", ".rad"];

/** What a picked folder holds for the importer: the maps, the texture archives, a lights.rad. */
export interface Found {
  pick: string;
  name: string;
  bsps: Entry[];
  wads: Entry[];
  rads: Entry[];
}

const ext = (path: string) => /\.[^./]*$/.exec(path)?.[0]?.toLowerCase() ?? "";
export const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const dirOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

export function scan(pick: string, name: string, entries: Entry[]): Found {
  const of = (e: string) => entries.filter((x) => ext(x.path) === e).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { pick, name, bsps: of(".bsp"), wads: of(".wad"), rads: entries.filter((x) => baseName(x.path).toLowerCase() === "lights.rad") };
}

/** A map's id in the game from its file's name: lower case, other characters as "_". */
export function idOf(path: string): string {
  return baseName(path).replace(/\.[^.]*$/, "").toLowerCase().replace(/[^a-z0-9_-]+/g, "_").slice(0, 48) || "map";
}

/** Where a stored map's files are. */
export const storePaths = (id: string) => ({ dir: `maps/${id}`, json: `maps/${id}/map.json`, glb: `maps/${id}/map.glb` });

export interface Imported {
  id: string;
  map: MapData;
  stats: ConvertStats;
  warnings: string[];
  /** The WADs the map asks for that were not in the folder. */
  wadsMissing: string[];
  sizes: { json: number; glb: number };
}

/**
 * The WADs worth reading for a map, best first: those it names, nearest the map first, then any other next to it
 * or one directory up (as tools/import-bsp.ts looks). One per file name.
 */
export function wadsFor(found: Found, bspPath: string, asked: string[]): Entry[] {
  const here = dirOf(bspPath), up = dirOf(here);
  const near = (w: Entry) => (dirOf(w.path) === here ? 0 : dirOf(w.path) === up ? 1 : 2);
  const rank = (w: Entry) => {
    const i = asked.indexOf(baseName(w.path).toLowerCase());
    return (i < 0 ? asked.length : i) * 4 + near(w);
  };
  const out: Entry[] = [];
  const seen = new Set<string>();
  for (const w of [...found.wads].sort((a, b) => rank(a) - rank(b))) {
    const key = baseName(w.path).toLowerCase();
    if (seen.has(key) || (!asked.includes(key) && near(w) === 2)) continue;
    seen.add(key);
    out.push(w);
  }
  return out;
}

/** A file of the pick, as bytes (read through the app, then decoded a slice at a time). */
function* readFile(pick: string, entry: Entry, label: string, from: number, to: number): Generator<unknown, Uint8Array> {
  yield { label, done: from } satisfies Progress;
  return (yield* decoded(files.read(pick, entry.path), label, from, to)).bytes;
}

/** An answer's bytes, decoded a slice at a time; with where they start in the file, and the file's size. */
function* decoded(answer: ReturnType<typeof files.read>, label: string, from: number, to: number): Generator<unknown, { bytes: Uint8Array; offset: number; size: number }> {
  yield answer;
  const { data, offset, size } = answer.result();
  const g = fromBase64(data);
  for (;;) {
    const r = g.next();
    if (r.done) return { bytes: r.value, offset, size: size >= 0 ? size : r.value.length };
    yield { label, done: from + (to - from) * r.value } satisfies Progress;
  }
}

/** A WAD as far as it has been read: its directory, and the textures read from it so far. */
export interface WadPart { wad: Wad; directory: Map<string, { at: number; size: number }> | null }

/**
 * The textures of `wanted` that a WAD of the pick has, read by ranges: its header and directory once, then each
 * texture's record (all of them asked for at once). halflife.wad is 38 MB; a map needs a megabyte or two of it. An
 * app that answers a range with the whole file (one from before ranged reads) gets the whole file read once.
 */
function* readWad(pick: string, entry: Entry, wanted: Set<string>, cache: Map<string, WadPart | null>, label: string): Generator<unknown, Wad | null> {
  const name = baseName(entry.path);
  let part = cache.get(entry.path);
  if (part === null) return null;
  try {
    if (!part) {
      const head = yield* decoded(files.read(pick, entry.path, { offset: 0, length: 12 }), label, 0, 0);
      if (head.bytes.length === head.size && head.size > 12) {
        part = { wad: parseWad(head.bytes, name), directory: null };
      } else {
        const { count, directory } = wadHeader(head.bytes, head.size, name);
        const dir = yield* decoded(files.read(pick, entry.path, { offset: directory, length: count * 32 }), label, 0, 0);
        part = { wad: { name, entries: new Map() }, directory: wadDirectory(dir.bytes, count, head.size) };
      }
      cache.set(entry.path, part);
    }
    const dir = part.directory;
    if (dir) {
      const reads = [...wanted].filter((t) => dir.has(t) && !part!.wad.entries.has(t)).map((t) => ({ t, r: dir.get(t)!, p: files.read(pick, entry.path, dir.get(t)!.size ? { offset: dir.get(t)!.at, length: dir.get(t)!.size } : undefined) }));
      for (const q of reads) {
        const got = yield* decoded(q.p, label, 0, 0);
        if (got.bytes.length === q.r.size) part.wad.entries.set(q.t, got.bytes);
      }
    }
    return part.wad;
  } catch {
    cache.set(entry.path, null);          // (an archive that cannot be read is one that is not there)
    return null;
  }
}

/**
 * Imports one map of a pick into the store under `id`. `wadCache` keeps the archives read for one map for the next
 * (importing all of a folder reads halflife.wad once). Throws ImportError for a file that is not a map it can read.
 */
export function* importMap(found: Found, bsp: Entry, id: string, wadCache: Map<string, WadPart | null>): Generator<unknown, Imported> {
  if (!ID_PATTERN.test(id)) throw new ImportError(`"${id}" cannot be a map id`);
  const name = baseName(bsp.path);
  const bytes = yield* readFile(found.pick, bsp, `${id}: reading ${name}`, 0, 0.06);
  const parsing = parseBspSteps(bytes, name);
  let parsed: Bsp;
  for (;;) {
    const r = parsing.next();
    if (r.done) { parsed = r.value; break; }
    yield { label: `${id}: reading ${name}`, done: 0.06 + 0.04 * r.value } satisfies Progress;
  }

  // The textures the map does not carry, from the WADs it names (and any lying next to it).
  const world = parsed.entities.find((e) => e.classname === "worldspawn");
  const asked = wantedWads(world?.keys.wad);
  const outside = new Set(parsed.textures.filter((t) => t.name && !t.data).map((t) => t.name.toLowerCase()));
  const wads: Wad[] = [];
  const candidates = outside.size ? wadsFor(found, bsp.path, asked) : [];
  for (const [k, w] of candidates.entries()) {
    if (!outside.size) break;
    const label = `${id}: reading ${baseName(w.path)}`;
    yield { label, done: 0.1 + (0.2 * k) / candidates.length } satisfies Progress;
    const wad = yield* readWad(found.pick, w, outside, wadCache, label);
    if (!wad) continue;
    const before = outside.size;
    for (const t of [...outside]) if (wad.entries.has(t)) outside.delete(t);
    if (outside.size < before || asked.includes(baseName(w.path).toLowerCase())) wads.push(wad);
  }
  const have = new Set(wads.map((w) => w.name.toLowerCase()));

  // A lights.rad next to the map or one directory up: the textures it names glow.
  const here = dirOf(bsp.path);
  const rad = found.rads.find((r) => dirOf(r.path) === here) ?? found.rads.find((r) => dirOf(r.path) === dirOf(here));
  let lightTextures: Set<string> | undefined;
  if (rad) {
    try {
      const bytes = yield* readFile(found.pick, rad, `${id}: reading lights.rad`, 0.3, 0.3);
      lightTextures = parseRad(latin1(bytes));
    } catch { /* without it, the names say which textures glow */ }
  }

  const paths = storePaths(id);
  const converting = convertSteps(parsed, { id, wads, lightTextures, source: name, glb: store.uri(paths.glb) });
  let converted;
  for (;;) {
    const r = converting.next();
    if (r.done) { converted = r.value; break; }
    yield { label: `${id}: ${r.value.stage === "faces" ? "faces" : r.value.stage === "textures" ? "textures" : r.value.stage === "spawns" ? "spawns" : "checking"}`, done: 0.3 + 0.55 * r.value.done } satisfies Progress;
  }

  // The GLB first, then map.json: a map is listed once its map.json is there.
  const encoding = toBase64(converted.glb);
  let data: string;
  for (;;) {
    const r = encoding.next();
    if (r.done) { data = r.value; break; }
    yield { label: `${id}: saving`, done: 0.85 + 0.1 * r.value } satisfies Progress;
  }
  const wroteGlb = store.write(paths.glb, { data });
  yield wroteGlb;
  wroteGlb.result();
  data = "";
  const json = mapJson(converted.map);
  const wroteJson = store.write(paths.json, { text: json });
  yield wroteJson;
  wroteJson.result();
  yield { label: `${id}: saved`, done: 1 } satisfies Progress;
  return { id, map: converted.map, stats: converted.stats, warnings: converted.warnings, wadsMissing: asked.filter((w) => !have.has(w) && outside.size > 0), sizes: { json: json.length, glb: converted.glb.length } };
}

/** The maps in the store: each `maps/<id>/map.json`, read and checked, its GLB named as a `user:` asset. */
export function* loadStored(): Generator<unknown, { maps: MapData[]; problems: string[] }> {
  const listed = store.list("maps/");
  yield listed;
  const ids: string[] = [];
  for (const e of listed.result()) {
    const m = /^maps\/([a-z0-9_-]+)\/map\.json$/.exec(e.path);
    if (m) ids.push(m[1]!);
  }
  const maps: MapData[] = [];
  const problems: string[] = [];
  for (const id of ids.sort()) {
    const read = store.readText(storePaths(id).json);
    yield read;
    try {
      const map = JSON.parse(read.result()) as MapData;
      if (!map || map.id !== id || !map.collision || !Array.isArray(map.collision.positions) || !Array.isArray(map.spawns) || typeof map.hash !== "string") throw new Error("not a map");
      map.glb = store.uri(storePaths(id).glb);
      maps.push(map);
    } catch (e) {
      problems.push(`${id}: ${e instanceof Error ? e.message : String(e)}`);
    }
    yield { label: "maps", done: maps.length / ids.length } satisfies Progress;
  }
  return { maps, problems };
}
