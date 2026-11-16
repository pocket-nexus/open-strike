// Maps, end to end, the real game in the engine's headless renderer with a script as its app (lib/app.ts, with a
// store in a temporary directory and scripted picks: lib/files.ts). The maps are made here (bsp/fixture.ts): no
// copyrighted file is read.
//
//   1. Importing in the game, as a player does: M opens the Maps menu, "Import from your game folder…" picks a
//      folder (a GoldSrc game's layout: cstrike/maps/*.bsp, cstrike/*.wad), the maps found are listed, "Import all"
//      converts them in the game a few milliseconds a frame and writes them to the store. What it wrote is what the
//      importer's code writes in Node from the same files (the same map.json, the same GLB, the same hash).
//   2. Practice on an imported map from the menu: the player stands on its floor, its wall stops a sprint. A new
//      session of the game finds the map in the store (launch `map` works with it).
//   3. A room opened on it from the menu names it by id and hash; a copy of the game without the map is told which
//      map and how to import it, and is not put in the room; one with the map joins and stands on it.
//   4. Removing it from the menu takes it off the store and out of the list; the player is put back on Foundry.
//   5. An app without files and store: the menu says importing needs a newer ThreeRT; a pick canceled says nothing.
//   6. A developer's import bundled with the game (maps/index.ts, tools/import-bsp.ts): practice on it.
//
//   node tools/test-maps.ts [--api http://127.0.0.1:8933]     (part 3 needs the platform's rooms; without them it is skipped)
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MOVE } from "../src/config.ts";
import { parseBsp } from "../src/import/bsp.ts";
import { convertBsp, mapJson } from "../src/import/convert.ts";
import { parseWad } from "../src/import/wad.ts";
import { buildBsp, buildWad, rectZ, wall, type FixtureMap, type FixtureTexture } from "./bsp/fixture.ts";
import { build } from "./build.ts";
import { App, World } from "./lib/app.ts";
import { ROOT } from "./lib/engine.ts";
import { checker } from "./lib/live.ts";

const args = process.argv.slice(2);
const api = args.includes("--api") ? args[args.indexOf("--api") + 1]! : "http://127.0.0.1:8933";
const { check, done } = checker();

// ---- the game folder: two maps and the WAD one of them takes its floor from ----
const UNIT = 0.0254;
const FLOOR_Z = 20, WALL_Y = 236;
const FLOOR = FLOOR_Z * UNIT;                 // 0.508 m up
const WALL = -WALL_Y * UNIT;                  // the wall's face, game z
const palette = (r: number, g: number, b: number) => { const p = new Uint8Array(768); for (let i = 0; i < 256; i++) p.set([(r * i) >> 8, (g * i) >> 8, (b * i) >> 8], i * 3); return p; };
const pixels = (w: number, h: number, at: (x: number, y: number) => number) => Uint8Array.from({ length: w * h }, (_, i) => at(i % w, Math.floor(i / w)));
const ROCK: FixtureTexture = { name: "ROCK", width: 32, height: 32, pixels: pixels(32, 32, (x, y) => 120 + ((x ^ y) & 15) * 6), palette: palette(230, 210, 180) };
function quarry(floorZ: number, external: boolean, title: string): FixtureMap {
  return {
    textures: [ROCK, external ? { name: "QUARRY", width: 64, height: 64 } : { name: "QUARRY", width: 64, height: 64, pixels: pixels(64, 64, (x, y) => 90 + ((x >> 3) + (y >> 3)) % 2 * 60), palette: palette(200, 190, 170) }],
    faces: [
      { texture: "QUARRY", vertices: rectZ(-800, -800, 800, 800, floorZ) },
      { texture: "ROCK", vertices: wall([300, WALL_Y], [-300, WALL_Y], floorZ, floorZ + 120) },
      { texture: "ROCK", vertices: wall([-300, WALL_Y + 16], [300, WALL_Y + 16], floorZ, floorZ + 120) },
    ],
    entities: [
      { classname: "worldspawn", wad: "\\games\\cs\\cstrike\\os_test.wad", message: title },
      { classname: "info_player_start", origin: `0 -236 ${floorZ + 36}`, angles: "0 90 0" },
      { classname: "info_player_deathmatch", origin: `120 -400 ${floorZ + 36}`, angles: "0 90 0" },
      { classname: "light_environment", angle: "200", pitch: "-40", _light: "255 240 220 80" },
      { classname: "light", origin: `0 0 ${floorZ + 100}`, _light: "255 200 150 120" },
    ],
  };
}
const WAD_TEXTURES: FixtureTexture[] = [{ name: "quarry", width: 64, height: 64, pixels: pixels(64, 64, (x, y) => 80 + ((x >> 3) + (y >> 3)) % 2 * 80), palette: palette(210, 200, 180) }];

const tmp = mkdtempSync(join(tmpdir(), "os-test-maps-"));
const game = join(tmp, "Half-Life");
mkdirSync(join(game, "cstrike/maps"), { recursive: true });
const files = {
  quarry: buildBsp(quarry(FLOOR_Z, true, "Test Quarry")),
  yard: buildBsp(quarry(40, false, "Test Yard")),
  wad: buildWad(WAD_TEXTURES),
};
writeFileSync(join(game, "cstrike/maps/os_quarry.bsp"), files.quarry);
writeFileSync(join(game, "cstrike/maps/os_yard.bsp"), files.yard);
writeFileSync(join(game, "cstrike/os_test.wad"), files.wad);
writeFileSync(join(game, "cstrike/readme.txt"), "not a map");
// What the importer's code makes of the same files in Node.
const expected = convertBsp(parseBsp(files.quarry, "os_quarry.bsp"), { id: "os_quarry", wads: [parseWad(files.wad, "os_test.wad")], source: "os_quarry.bsp", glb: "user:maps/os_quarry/map.glb" });
const store = join(tmp, "store");

const world = new World();
const report = async (app: App) => (await app.report()) as any;
const menu = async (app: App) => (await report(app)).menu as { open: boolean; items: any[] };
async function press(app: App, ...keys: string[]): Promise<void> {
  for (const k of keys) { app.press(k); await world.frames(2); }
}
/** Moves the menu's choice to the row whose first cell matches, and takes it. */
async function choose(app: App, row: string | RegExp): Promise<boolean> {
  for (let tries = 0; tries < 40; tries++) {
    const t = (await menu(app)).items[0];
    if (!t?.rows) return false;
    const at = t.rows.findIndex((r: any[]) => (typeof row === "string" ? r[0] === row : row.test(String(r[0]))));
    if (at === t.highlight) { await press(app, "Enter"); return true; }
    await press(app, at >= 0 && at < t.highlight ? "Up" : "Down");
  }
  return false;
}
const noErrors = (app: App) => {
  const e = app.live.errors();
  check(e.length === 0, `${app.name}: no script error${e[0] ? `: ${e[0]}` : ""}`);
};

try {
  const bundle = (await build()).out;

  // ---- 1. importing in the game ----
  const a = world.add(await App.start(bundle, { practice: true, bots: 0, name: "Ada" }, { files: { store, picks: [game] } }));
  check(await world.until(async () => (await report(a)).status === "practice", 10), "the game starts (practice), its store read");
  check((await report(a)).library === "ready" && a.hud().items?.some((i: any) => i.text === "M: maps"), "the HUD says where the maps are (M)");
  await press(a, "M");
  let m = await menu(a);
  check(m.open && m.items[0]?.type === "table" && m.items[0].title === "Maps" && m.items[0].rows[0][0] === "Foundry", `M opens the Maps menu: ${m.items[0]?.rows.map((r: any[]) => r[0]).join(" | ")}`);
  check(m.items.some((i: any) => /Uses your own copy; stays on this device/.test(i.text ?? "")), "it says imported maps stay on this device");
  check(await choose(a, /^Import from your game folder/), "Import from your game folder…");
  check(await world.until(async () => /maps found/.test((await menu(a)).items[0]?.title ?? ""), 5, 2), "the folder is picked (files.pick), the maps in it listed");
  m = await menu(a);
  check(JSON.stringify(m.items[0].rows.map((r: any[]) => r[0])) === JSON.stringify(["os_quarry", "os_yard", "Import all 2", "Choose another folder…", "Back"]) && m.items[0].rows[0][1] === "cstrike/maps", `the maps found: ${m.items[0].rows.map((r: any[]) => r.join(" ")).join(" | ")}`);
  check(a.files!.seen["files.pick"] === 1 && !a.files!.seen["files.read"], "nothing is read before the player chooses");
  check(await choose(a, "Import all 2"), "Import all");
  let sawBar = false;
  const imported = await world.until(async () => {
    sawBar ||= (a.hud().items ?? []).some((i: any) => i.type === "bar" && /^Importing os_/.test(i.label ?? ""));
    return (await report(a)).imports.length >= 2;
  }, 30, 3);
  const r1 = await report(a);
  check(imported && r1.imports.every((i: any) => i.ok), `both are imported in the game: ${r1.imports.map((i: any) => `${i.id} ${i.ms} ms over ${i.frames} frames (longest step ${i.longest} ms)${i.error ? ` ${i.error}` : ""}`).join(", ")}`);
  check(sawBar, "the HUD shows the import's progress while it runs");
  check(r1.imports.every((i: any) => i.longest < 40), `no frame waits long on it (longest step ${Math.max(...r1.imports.map((i: any) => i.longest))} ms)`);
  check(a.files!.seen["files.read"] === 3, `the two maps and the one WAD are read, once each (${a.files!.seen["files.read"]} reads)`);
  const listed = a.files!.list("maps/").map((e) => e.path);
  check(JSON.stringify(listed) === JSON.stringify(["maps/os_quarry/map.glb", "maps/os_quarry/map.json", "maps/os_yard/map.glb", "maps/os_yard/map.json"]), `the store holds them: ${listed.join(", ")}`);
  const json = readFileSync(join(store, "maps/os_quarry/map.json"), "utf8");
  check(json === mapJson(expected.map), `map.json is what the importer's code makes in Node (hash ${expected.map.hash.slice(0, 12)}…, glb ${expected.map.glb})`);
  check(Buffer.compare(readFileSync(join(store, "maps/os_quarry/map.glb")), Buffer.from(expected.glb)) === 0, `and so is the GLB (${expected.glb.length} bytes, its floor's texture from the WAD)`);
  check(r1.maps.includes("os_quarry") && r1.maps.includes("os_yard") && r1.user.find((u: any) => u.id === "os_quarry")?.hash === expected.map.hash, `the map list has them: ${r1.maps.join(", ")}`);

  // ---- 2. practice on it, from the menu ----
  if (!(await menu(a)).open) await press(a, "M");
  await press(a, "Backspace");
  check(await choose(a, "Test Quarry"), "the map is chosen in the list");
  m = await menu(a);
  check(JSON.stringify(m.items[0]?.rows.map((r: any[]) => r[0])) === JSON.stringify(["Practise here", "Open a new room here", "Remove from this device", "Back"]), `what can be done with it: ${m.items[0]?.rows.map((r: any[]) => r[0]).join(" | ")}`);
  await press(a, "Enter");
  check(await world.until(async () => { const r = await report(a); return r.map === "os_quarry" && r.status === "practice" && r.me.alive; }, 5), "Practise here: practice on the imported map");
  await world.run(0.6);
  let r = await report(a);
  check(!(await menu(a)).open && r.grounded && Math.abs(r.at[1] - FLOOR - MOVE.skin) < 3e-3, `the player stands on its floor (y ${r.at[1].toFixed(3)}: ${FLOOR} m up)`);
  check(a.hud().items?.some((i: any) => i.label === "Practice" && i.text === "Test Quarry") && a.hud().items?.some((i: any) => /your own copy, on this device/.test(i.text ?? "")), "the HUD names it, and says it is the player's own copy");
  a.keys = ["W", "Shift"];
  await world.run(3);
  a.keys = [];
  r = await report(a);
  const face = WALL + MOVE.radius;
  check(r.at[2] >= face - 1e-3 && r.at[2] - face < 0.05, `its wall stops a sprint (${(r.at[2] - face).toFixed(3)} m off its face)`);
  noErrors(a);
  await a.quit();
  world.remove(a);

  // A new session of the game finds the maps in the store before it starts.
  const b = world.add(await App.start(bundle, { practice: true, bots: 0, name: "Bea", map: "os_yard" }, { files: { store } }));
  check(await world.until(async () => (await report(b)).status === "practice", 10), "a new session starts");
  r = await report(b);
  check(r.map === "os_yard" && r.maps.includes("os_quarry"), `the stored maps are there from the start (launch map: ${r.map})`);
  noErrors(b);
  await b.quit();
  world.remove(b);

  // ---- 3. a room on it ----
  let rooms = false;
  try { rooms = (await fetch(`${api}/api/v1/apps/openstrike/rooms`)).status === 200; } catch { /* none */ }
  if (!rooms) console.log(`(no rooms at ${api}: part 3, a room on an imported map, is not run)`);
  else {
    const host = world.add(await App.start(bundle, { practice: true, bots: 0, name: "Host", api, id: "maps-host-000001" }, { files: { store } }));
    await world.until(async () => (await report(host)).status === "practice", 10);
    await press(host, "M");
    await choose(host, "Test Quarry");
    await choose(host, "Open a new room here");
    const online = await world.until(async () => (await report(host)).status === "online", 12);
    const h = await report(host);
    check(online, `Open a new room here: a room is made on the imported map${online ? "" : ` (${h.status}, ${h.map}: ${h.notice})`}`);
    if (!online) throw new Error("no room: the rest of part 3 cannot run");
    const summary = (await (await fetch(`${api}/api/v1/rooms/openstrike/${h.code}`)).json()) as { meta: { map: { id: string; hash: string } } };
    check(h.map === "os_quarry" && summary.meta.map.id === "os_quarry" && summary.meta.map.hash === expected.map.hash, `the room names the map by id and hash (${expected.map.hash.slice(0, 12)}…)`);
    const without = world.add(await App.start(bundle, { room: h.code, name: "Without", api, id: "maps-without-0001" }));
    check(await world.until(async () => (await report(without)).status === "practice", 12), "a copy of the game without the map: practice");
    const w = await report(without);
    check(w.map === "foundry" && (w.notice ?? "").includes('"os_quarry"') && (w.notice ?? "").includes("M: Maps") && w.me.alive, `on Foundry, told: "${w.notice}"`);
    check((await report(host)).actors.length === 0, "and never in the room");
    const store2 = join(tmp, "store2");
    cpSync(store, store2, { recursive: true });
    const withIt = world.add(await App.start(bundle, { room: h.code, name: "With", api, id: "maps-with-000001" }, { files: { store: store2 } }));
    check(await world.until(async () => (await report(withIt)).status === "online", 12), "a copy that imported the same map joins");
    await world.run(1);
    const j = await report(withIt);
    check(j.map === "os_quarry" && j.grounded && Math.abs(j.at[1] - FLOOR - MOVE.skin) < 3e-3, `it stands on the map: ${j.map}, ${j.at[1].toFixed(3)} m up`);
    check((await report(host)).actors[0]?.name === "With", "and the two see each other");
    for (const app of [...world.apps]) { noErrors(app); await app.quit(); world.remove(app); }
  }

  // ---- 4. removing it ----
  const c = world.add(await App.start(bundle, { practice: true, bots: 0, name: "Cy", map: "os_quarry" }, { files: { store } }));
  await world.until(async () => (await report(c)).map === "os_quarry", 10);
  await press(c, "M");
  await choose(c, "Test Quarry");
  await choose(c, "Remove from this device");
  m = await menu(c);
  check(m.items[0]?.rows[2]?.[0] === "Press again to remove it", "removing asks once more");
  await press(c, "Enter");
  check(await world.until(async () => !(await report(c)).maps.includes("os_quarry"), 5), "Remove: the map is out of the list");
  r = await report(c);
  check(!c.files!.list("maps/").some((e) => e.path.startsWith("maps/os_quarry/")) && c.files!.list("maps/").some((e) => e.path.startsWith("maps/os_yard/")), "and off the store (the other stays)");
  check(await world.until(async () => (await report(c)).map === "foundry", 5), "the player, who was on it, is put back on Foundry");
  noErrors(c);
  await c.quit();
  world.remove(c);

  // ---- 5. an app without files and store; a canceled pick ----
  const d = world.add(await App.start(bundle, { practice: true, bots: 0, name: "Dee" }));
  await world.until(async () => (await report(d)).status === "practice", 10);
  await press(d, "M");
  m = await menu(d);
  check(m.items[0]?.rows.some((row: any[]) => /needs a newer ThreeRT/.test(row[0])), "without files and store, the menu says importing needs a newer ThreeRT");
  check(!d.live.posts.some((p) => /^(files|store)\./.test(p.t)), "and the game asks the app nothing of either");
  noErrors(d);
  await d.quit();
  world.remove(d);
  const e = world.add(await App.start(bundle, { practice: true, bots: 0, name: "Eve" }, { files: { store, picks: [] } }));
  await world.until(async () => (await report(e)).status === "practice", 10);
  await press(e, "M");
  await choose(e, /^Import from your game folder/);
  await world.frames(10);
  check(e.files!.seen["files.pick"] === 1 && (await menu(e)).items[0]?.title === "Maps" && !(await report(e)).notice2, "a pick the player cancels changes nothing");
  noErrors(e);
  await e.quit();
  world.remove(e);

  // ---- 6. a developer's import, bundled ----
  const dir = join(ROOT, "out/imported");
  mkdirSync(join(dir, "os_quarry"), { recursive: true });
  writeFileSync(join(dir, "os_quarry/map.json"), mapJson({ ...expected.map, glb: "assets/maps/os_quarry/map.glb" }));
  writeFileSync(join(dir, "index.ts"), `import type { MapData } from "../../src/maps/types.ts";\nimport os_quarry from "./os_quarry/map.json";\nexport const maps: MapData[] = [os_quarry as unknown as MapData];\n`);
  mkdirSync(join(ROOT, "assets/maps/os_quarry"), { recursive: true });
  writeFileSync(join(ROOT, "assets/maps/os_quarry/map.glb"), expected.glb);
  const bundled = (await build(join(ROOT, "out/openstrike-imported.js"), undefined, join(dir, "index.ts"))).out;
  const f = world.add(await App.start(bundled, { practice: true, bots: 0, name: "Fay", map: "os_quarry" }));
  await world.until(async () => (await report(f)).status === "practice", 10);
  await world.run(0.6);
  r = await report(f);
  check(r.map === "os_quarry" && r.grounded && Math.abs(r.at[1] - FLOOR - MOVE.skin) < 3e-3, "a map bundled by tools/import-bsp.ts: practice on it");
  await press(f, "M");
  check((await menu(f)).items[0]?.rows.some((row: any[]) => row[0] === "Test Quarry" && row[1] === "Bundled"), "the menu lists it as bundled");
  noErrors(f);
  await f.quit();
  world.remove(f);
} finally {
  for (const app of world.apps) await app.quit().catch(() => {});
  rmSync(tmp, { recursive: true, force: true });
  rmSync(join(ROOT, "out/imported"), { recursive: true, force: true });
  rmSync(join(ROOT, "out/openstrike-imported.js"), { force: true });
  rmSync(join(ROOT, "assets/maps/os_quarry"), { recursive: true, force: true });
  try { rmdirSync(join(ROOT, "assets/maps")); } catch { /* not empty, or not there */ }
}
done("maps");
