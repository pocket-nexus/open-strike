// How long importing maps takes in the game, as a player does it: the game runs in the engine's headless renderer at
// 60 frames a second of real time, a script is its app (lib/app.ts) with a store in a temporary directory, and the
// player opens the Maps menu, picks the folder and imports the maps named. Prints each import's time (wall clock, and
// the milliseconds of work in the game's runtime), the slowest frames while it ran, and the map's numbers. Reads your
// own files; writes nothing outside the temporary store (removed after).
//
//   node tools/time-import.ts <folder with .bsp and .wad files> [de_dust2 de_inferno ...] [--keep <store dir>]
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "./build.ts";
import { App, World } from "./lib/app.ts";

const args = process.argv.slice(2);
const keep = args.includes("--keep") ? resolve(args[args.indexOf("--keep") + 1]!) : null;
const rest = args.filter((a, i) => a !== "--keep" && args[i - 1] !== "--keep");
const folder = rest[0];
if (!folder) { console.error("usage: node tools/time-import.ts <folder> [map ...] [--keep <store dir>]"); process.exit(2); }
const wanted = rest.slice(1);
const store = keep ?? mkdtempSync(join(tmpdir(), "os-store-"));

const bundle = (await build()).out;
const world = new World();
const app = world.add(await App.start(bundle, { practice: true, bots: 0, name: "Timer" }, { files: { store, picks: [resolve(folder)] } }));
try {
  await world.until(async () => (await app.report()).status === "practice", 10);
  const menu = async () => ((await app.report()) as any).menu;
  app.press("M");
  await world.frames(2);
  app.press("Up");                          // (from the map being played, up wraps round to "Import from your game folder…")
  await world.frames(2);
  app.press("Enter");
  await world.until(async () => /maps found/.test((await menu()).items[0]?.title ?? ""), 20, 2);
  const table = (await menu()).items[0];
  const names: string[] = table.rows.map((r: any[]) => String(r[0]));
  console.log(`${table.title}: ${names.filter((n) => !/^(Import all|Choose another|Back)/.test(n)).join(", ")}`);
  for (const name of wanted.length ? wanted : names.filter((n) => !/^(Import all|Choose another|Back)/.test(n)).slice(0, 1)) {
    const now = (await menu()).items[0];
    const at = now.rows.findIndex((r: any[]) => r[0] === name);
    if (at < 0) { console.log(`${name}: not in the folder`); continue; }
    for (let k = now.highlight; k !== at; k += at > k ? 1 : -1) { app.press(at > k ? "Down" : "Up"); await world.frames(1); }
    const before = ((await app.report()) as any).imports.length;
    const times: number[] = [];
    app.press("Enter");
    const t0 = performance.now();
    for (;;) {
      const f0 = performance.now();
      await world.frames(1);
      times.push(performance.now() - f0);
      if (times.length % 30 === 0 && ((await app.report()) as any).imports.length > before) break;
      if (performance.now() - t0 > 300_000) { console.log(`${name}: still running after 300 s`); break; }
    }
    const r = (await app.report()) as any;
    const done = r.imports[r.imports.length - 1];
    times.sort((a, b) => b - a);
    const over = times.filter((t) => t > 1000 / 60 + 4).length;
    console.log(`${name}: ${done?.ok ? "imported" : `failed (${done?.error})`} in ${(done?.ms / 1000).toFixed(2)} s over ${done?.frames} frames, ${(done?.busy / 1000).toFixed(2)} s of it working in the game's runtime (longest step ${done?.longest} ms: ${done?.longestAt}); ` +
      `slowest frames ${times.slice(0, 5).map((t) => t.toFixed(0)).join(", ")} ms, ${over} over 20 ms; ${done?.triangles} triangles, ${done?.textures} textures${done?.missing ? `, ${done.missing} missing` : ""}`);
    for (const w of done?.warnings ?? []) console.log(`  warning: ${w}`);
    for (const w of done?.slow ?? []) console.log(`  slow step: ${w}`);
  }
  const r = (await app.report()) as any;
  console.log(`store: ${r.user.map((u: any) => `${u.id} ${u.hash.slice(0, 12)}…`).join(", ")}`);
  const e = app.live.errors();
  if (e.length) console.log(`script errors: ${e.slice(0, 3).join(" | ")}`);
} finally {
  await app.quit();
  if (!keep) rmSync(store, { recursive: true, force: true });
}
