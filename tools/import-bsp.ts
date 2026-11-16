// Imports a GoldSrc map you own (Counter-Strike 1.x, Half-Life: BSP version 30) into this project (docs/MAPS.md).
//
//   node tools/import-bsp.ts <map.bsp> [--wad <dir or .wad>]... [--rad <lights.rad>] [--id <id>] [--out <project dir>] [--no-relight]
//   node tools/import-bsp.ts --remove <id> [--out <project dir>]
//
// Writes maps/<id>/map.json (a MapData) and assets/maps/<id>/map.glb, and lists the project's imported maps in
// maps/index.ts. The maps are copyrighted: both directories are git-ignored, and a project that has them is not
// published (tools/check-no-imported-maps.ts).
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { MapData } from "../src/maps/types.ts";
import { ImportError, parseBsp } from "../src/import/bsp.ts";
import { type Converted, convertBsp, mapJson, parseRad } from "../src/import/convert.ts";
import { verifyMap } from "./bsp/verify.ts";
import { type Wad, parseWad, wantedWads } from "../src/import/wad.ts";

export const ID_PATTERN = /^[a-z0-9_-]+$/;

const INDEX_HEADER = `// The imported maps the game bundles (docs/MAPS.md). tools/import-bsp.ts rewrites this file: one import of
// \`./<id>/map.json\` per map, listed in \`maps\`. Imported maps are your own copies of maps you own: \`maps/<id>/\` and
// \`assets/maps/\` are git-ignored, and a project with any map listed here is not published.
//
//   import de_dust2 from "./de_dust2/map.json";
//   export const maps: MapData[] = [de_dust2 as MapData];
import type { MapData } from "../src/maps/types.ts";
`;

const RESERVED = new Set("break case catch class const continue debugger default delete do else enum export extends false finally for function if import in instanceof let new null return static super switch this throw true try typeof var void while with yield await async of type".split(" "));

/** The text of maps/index.ts for a list of map ids. With none: the header and `export const maps: MapData[] = [];`. */
export function indexSource(ids: string[]): string {
  const sorted = [...ids].sort();
  // A map's name in the file: its id, made an identifier (ids may hold "-" and start with a digit).
  const names: string[] = [];
  for (const id of sorted) {
    let name = id.replace(/-/g, "_");
    if (/^[0-9]/.test(name) || RESERVED.has(name)) name = `map_${name}`;
    while (names.includes(name) || name === "maps") name += "_";
    names.push(name);
  }
  const imports = sorted.map((id, i) => `import ${names[i]} from "./${id}/map.json";\n`).join("");
  const list = names.map((name) => `${name} as unknown as MapData`).join(", ");
  return `${INDEX_HEADER}${imports}\nexport const maps: MapData[] = [${list}];\n`;
}

/** Ids of the maps imported into a project: the directories of maps/ that hold a map.json. */
export function importedIds(project: string): string[] {
  const dir = join(project, "maps");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((id) => ID_PATTERN.test(id) && existsSync(join(dir, id, "map.json"))).sort();
}

export function writeIndex(project: string): string[] {
  const ids = importedIds(project);
  mkdirSync(join(project, "maps"), { recursive: true });
  writeFileSync(join(project, "maps/index.ts"), indexSource(ids));
  return ids;
}


/** The .wad files in the places a map's textures can be: what --wad names, next to the map, and one directory up. */
export function findWads(bspPath: string, given: string[]): string[] {
  const places = [...given.map((g) => resolve(g)), dirname(bspPath), dirname(dirname(bspPath))];
  const files: string[] = [];
  const seen = new Set<string>();
  const add = (file: string) => {
    const key = basename(file).toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      files.push(file);
    }
  };
  for (const place of places) {
    if (!existsSync(place)) continue;
    if (statSync(place).isFile()) add(place);
    else for (const f of readdirSync(place).sort()) if (extname(f).toLowerCase() === ".wad" && statSync(join(place, f)).isFile()) add(join(place, f));
  }
  return files;
}

/** A lights.rad (the map compiler's list of texture lights): the one given, or one in the places WADs are looked for. */
export function findRad(bspPath: string, given: string[], rad?: string): string | undefined {
  if (rad) return resolve(rad);
  const places = [...given.map((g) => resolve(g)), dirname(bspPath), dirname(dirname(bspPath))];
  for (const place of places) {
    if (!existsSync(place) || !statSync(place).isDirectory()) continue;
    const file = readdirSync(place).find((f) => f.toLowerCase() === "lights.rad");
    if (file) return join(place, file);
  }
  return undefined;
}

export interface ImportArgs {
  bsp: string;
  wad?: string[];
  rad?: string;
  id?: string;
  out: string;
  relight?: boolean;
}

export interface Imported extends Converted {
  id: string;
  files: { map: string; glb: string; index: string };
  sizes: { map: number; glb: number };
  wadsMissing: string[];
}

/** Converts a map and writes it into a project. Throws ImportError for what the person who ran it can fix. */
export function importBsp(args: ImportArgs): Imported {
  const bspPath = resolve(args.bsp);
  const id = args.id ?? basename(bspPath).replace(/\.[^.]*$/, "").toLowerCase();
  if (!ID_PATTERN.test(id)) throw new ImportError(`"${id}" cannot be a map id: an id is lower-case letters, digits, "_" and "-" (${ID_PATTERN.source}). Give one with --id.`);
  if (!existsSync(bspPath) || !statSync(bspPath).isFile()) throw new ImportError(`${bspPath}: no such file.`);
  const bsp = parseBsp(new Uint8Array(readFileSync(bspPath)), basename(bspPath));

  // WADs: the ones the map asks for first, in its order; then any other that is around.
  const world = bsp.entities.find((e) => e.classname === "worldspawn");
  const asked = wantedWads(world?.keys.wad);
  const external = bsp.textures.some((t) => t.name && !t.data);
  const found = external ? findWads(bspPath, args.wad ?? []) : [];
  const rank = (file: string) => {
    const i = asked.indexOf(basename(file).toLowerCase());
    return i < 0 ? asked.length : i;
  };
  found.sort((a, b) => rank(a) - rank(b));
  const wads: Wad[] = found.map((file) => parseWad(new Uint8Array(readFileSync(file)), basename(file)));
  const have = new Set(wads.map((w) => w.name.toLowerCase()));

  const radFile = findRad(bspPath, args.wad ?? [], args.rad);
  if (radFile && !existsSync(radFile)) throw new ImportError(`${radFile}: no such file.`);
  const lightTextures = radFile ? parseRad(readFileSync(radFile, "latin1")) : undefined;
  const converted = convertBsp(bsp, { id, wads, lightTextures, relight: args.relight, source: basename(bspPath) });
  const project = resolve(args.out);
  const files = { map: join(project, "maps", id, "map.json"), glb: join(project, "assets/maps", id, "map.glb"), index: join(project, "maps/index.ts") };
  mkdirSync(dirname(files.map), { recursive: true });
  mkdirSync(dirname(files.glb), { recursive: true });
  const json = mapJson(converted.map);
  writeFileSync(files.map, json);
  writeFileSync(files.glb, converted.glb);
  writeIndex(project);
  return { ...converted, id, files, sizes: { map: Buffer.byteLength(json), glb: converted.glb.length }, wadsMissing: asked.filter((w) => !have.has(w)) };
}

/** Takes an imported map out of a project. */
export function removeMap(project: string, id: string): boolean {
  if (!ID_PATTERN.test(id)) throw new ImportError(`"${id}" is not a map id.`);
  const dirs = [join(project, "maps", id), join(project, "assets/maps", id)];
  const there = dirs.some((d) => existsSync(d));
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  const assets = join(project, "assets/maps");
  if (existsSync(assets) && readdirSync(assets).length === 0) rmSync(assets, { recursive: true });
  writeIndex(project);
  return there;
}

const USAGE = `usage: node tools/import-bsp.ts <map.bsp> [--wad <dir or .wad>]... [--rad <lights.rad>] [--id <id>] [--out <project dir>] [--no-relight]
       node tools/import-bsp.ts --remove <id> [--out <project dir>]

  --wad         where the map's texture archives are (also looked for next to the map and one directory up)
  --rad         the game's lights.rad: the textures it lists glow (also looked for where the WADs are; without one,
                textures named as lights do: ~..., skkylite...)
  --id          the map's id in the game (default: the file's name); ${ID_PATTERN.source}
  --out         the project to import into (default: this one)
  --no-relight  do not turn the map's light entities into lamps
  --remove      take an imported map out again`;

function main(argv: string[]): number {
  const wad: string[] = [];
  let bsp: string | undefined, id: string | undefined, remove: string | undefined, rad: string | undefined, relight = true;
  let out = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) throw new ImportError(`${a} needs a value.\n${USAGE}`);
      return argv[++i];
    };
    if (a === "--wad" || a === "--wads") wad.push(value());
    else if (a === "--id") id = value();
    else if (a === "--rad") rad = value();
    else if (a === "--out") out = resolve(value());
    else if (a === "--remove") remove = value();
    else if (a === "--no-relight") relight = false;
    else if (a === "-h" || a === "--help") {
      console.log(USAGE);
      return 0;
    } else if (a.startsWith("-")) throw new ImportError(`unknown option ${a}.\n${USAGE}`);
    else if (bsp) throw new ImportError(`one map at a time: ${bsp} and ${a}.\n${USAGE}`);
    else bsp = a;
  }
  if (remove !== undefined) {
    const there = removeMap(out, remove);
    console.log(there ? `removed ${remove}; maps/index.ts lists ${importedIds(out).length} map(s)` : `${remove} was not imported; maps/index.ts lists ${importedIds(out).length} map(s)`);
    return 0;
  }
  if (!bsp) throw new ImportError(USAGE);

  const t0 = performance.now();
  const r = importBsp({ bsp, wad, rad, id, out, relight });
  const checked = verifyMap(r.map, r.glb);
  const ms = performance.now() - t0;

  const s = r.stats, m = r.map;
  const mb = (n: number) => `${(n / 1048576).toFixed(2)} MB`;
  const v3 = (v: number[]) => v.map((c) => c.toFixed(1)).join(", ");
  const size = m.bounds.max.map((c, i) => c - m.bounds.min[i]);
  console.log(`${r.id}: "${m.title}" imported in ${(ms / 1000).toFixed(2)} s`);
  console.log(`  drawn      ${s.facesDrawn} of ${s.faces} faces, ${s.triangles} triangles in ${s.primitives} primitives (${s.skyFaces} sky faces left to the game's sky${s.water ? `, ${s.water} water faces as glass` : ""})`);
  console.log(`  textures   ${s.textures.used} used: ${s.textures.embedded} from the map, ${s.textures.fromWads} from ${s.textures.wadsUsed.join(", ") || "WADs"}, ${s.textures.missing.length} missing${s.emissiveTextures.length ? `; ${s.emissiveTextures.length} glow (${s.emissiveTextures.join(", ")})` : ""}`);
  console.log(`  brushes    ${s.brushEntities.drawn} brush entities drawn, ${s.brushEntities.solid} solid, ${s.brushEntities.skipped} left out (triggers, zones), ${s.ladders} ladder(s)`);
  console.log(`  collision  ${s.collision.triangles} triangles, ${s.collision.vertices} vertices, hash ${m.hash.slice(0, 16)}...`);
  console.log(`  spawns     ${s.spawns.a} team a (info_player_start), ${s.spawns.b} team b (info_player_deathmatch)${s.spawns.any ? `, ${s.spawns.any} for anyone` : ""}`);
  const colour = (c: number) => `#${c.toString(16).padStart(6, "0")}`;
  console.log(`  sun        ${m.sun ? `elevation ${m.sun.elevation} deg, azimuth ${m.sun.azimuth} deg, ${m.sun.illuminance} lux, ${colour(m.sun.color ?? 0xffffff)}` : typeof m.sky === "object" ? `none: an overcast sky, ${m.sky.intensity} nits, ${colour(m.sky.color)}` : "none in the map: night, lit by its lamps"}`);
  console.log(`  lights     ${relight ? `${s.lights.kept} kept of ${s.lights.found} light entities (${s.lights.merged} merged, ${s.lights.dropped} over the limit)` : `none written (--no-relight; the map has ${s.lights.found})`}`);
  console.log(`  bounds     ${v3(m.bounds.min)} .. ${v3(m.bounds.max)} m (${v3(size)}), killY ${m.killY}`);
  console.log(`  files      ${r.files.map} (${mb(r.sizes.map)}), ${r.files.glb} (${mb(r.sizes.glb)}, ${mb(checked.glb.imageBytes)} of it textures)`);
  console.log(`  checked    GLB read back: ${checked.glb.primitives} primitives, ${checked.glb.triangles} triangles, ${checked.glb.images} images decoded; ${checked.spawns.checked} spawns on the floor (largest gap ${(checked.spawns.maxFloorGap * 100).toFixed(1)} cm, drawn floor within ${(checked.spawns.maxDrawnGap * 100).toFixed(1)} cm)`);
  for (const w of r.warnings) console.log(`  warning    ${w}`);
  for (const p of checked.problems.slice(0, 20)) console.log(`  problem    ${p}`);
  if (checked.problems.length > 20) console.log(`  problem    ... and ${checked.problems.length - 20} more`);
  console.log(`  maps/index.ts lists ${importedIds(out).join(", ")}. Imported maps stay on this machine: they are never committed or published.`);
  return 0;
}

if (import.meta.main ?? (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url))) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    if (e instanceof ImportError) {
      console.error(`import-bsp: ${e.message}`);
      process.exitCode = 1;
    } else throw e;
  }
}
