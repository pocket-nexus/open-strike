// Pictures of imported maps for the README (media/imported-*.jpg, media/maps-menu.jpg). Reads YOUR OWN copy of the
// classic maps: the game imports them in the headless renderer (the Maps menu, a scripted pick of the folder) into a
// temporary store, practises on them, and the pictures are traced there. The maps stay in the temporary store, which
// is removed after; only the pictures are written.
//
// The engine's own window draws no HUD (the app does): the menu picture has the menu drawn over the traced frame by
// this tool, from the HUD description the game posted, in the look of ThreeRT for macOS.
//
//   node tools/shots-imported.ts <folder with de_dust2.bsp, de_inferno.bsp and their WADs> [--out media] [--width 1600 --height 900] [--frames 72]
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "./build.ts";
import { App, World } from "./lib/app.ts";
import { ROOT, engineRequire } from "./lib/engine.ts";
import { startLive } from "./lib/live.ts";
import { take, type Picture } from "./shots.ts";

const args = process.argv.slice(2);
const flag = (k: string, d: string) => (args.includes(k) ? args[args.indexOf(k) + 1]! : d);
const folder = args[0];
if (!folder || folder.startsWith("--")) { console.error("usage: node tools/shots-imported.ts <folder> [--out media] [--width 1600 --height 900] [--frames 72]"); process.exit(2); }
const outDir = resolve(ROOT, flag("--out", "media"));
const width = Number(flag("--width", "1600")), height = Number(flag("--height", "900")), frames = Number(flag("--frames", "72"));
const deg = (d: number) => (d * Math.PI) / 180;

const PICTURES: { map: string; name: string; picture: Picture; menu?: boolean }[] = [
  { map: "de_dust2", name: "imported-de_dust2", picture: { name: "dust2", at: [-21.1, 3.3, 20.3], yaw: deg(-70), pitch: 0.04, bare: false, bots: [{ at: [-13.6, 3.3, 17.6], yaw: deg(110), team: "azure", weapon: 0 }, { at: [-11.2, 3.3, 15.4], yaw: deg(80), team: "azure", weapon: 2, flags: 1 }] } },
  { map: "de_inferno", name: "imported-de_inferno", picture: { name: "inferno", at: [-42.06, -1.6, -13.0], yaw: deg(-150), pitch: 0.05, bare: false, bots: [{ at: [-38.6, -1.6, -19.6], yaw: deg(20), team: "azure", weapon: 0 }] } },
  { map: "de_dust2", name: "maps-menu", menu: true, picture: { name: "menu", at: [-21.1, 3.3, 17.9], yaw: deg(100), pitch: 0.02, bare: true, bots: [] } },
];

const store = mkdtempSync(join(tmpdir(), "os-shots-"));
mkdirSync(outDir, { recursive: true });
try {
  const { out } = await build();
  // ---- the maps, imported in the game ----
  const world = new World();
  const app = world.add(await App.start(out, { practice: true, bots: 0, name: "Ada" }, { files: { store, picks: [resolve(folder)] } }));
  await world.until(async () => (await app.report()).status === "practice", 10);
  const menu = async () => ((await app.report()) as any).menu;
  for (const k of ["M", "Up", "Enter"]) { app.press(k); await world.frames(2); }
  await world.until(async () => /maps found/.test((await menu()).items[0]?.title ?? ""), 20, 2);
  for (const id of [...new Set(PICTURES.map((p) => p.map))]) {
    for (let tries = 0; tries < 60; tries++) {
      const t = (await menu()).items[0];
      const at = t.rows.findIndex((r: any[]) => r[0] === id);
      if (at < 0) throw new Error(`${id} is not in ${folder}`);
      if (at === t.highlight) break;
      app.press(at > t.highlight ? "Down" : "Up");
      await world.frames(1);
    }
    const before = ((await app.report()) as any).imports.length;
    app.press("Enter");
    await world.until(async () => ((await app.report()) as any).imports.length > before, 120, 10);
    const done = ((await app.report()) as any).imports.at(-1);
    console.log(`${id}: imported in the game in ${(done.ms / 1000).toFixed(1)} s${done.ok ? "" : ` (failed: ${done.error})`}`);
  }
  await app.quit();

  // ---- the pictures ----
  const sharp = engineRequire("sharp") as typeof import("sharp");
  for (const p of PICTURES) {
    const live = await startLive(out, { launch: { practice: true, bots: 4, targets: true, map: p.map, name: "Ada" }, width, height, scale: "1", files: { store } });
    await live.step(30);
    let overlay: Buffer | null = null;
    if (p.menu) {
      live.input({ keys: ["M"], pressed: ["M"] });
      await live.step(1);
      live.input({ keys: [] });
      await live.step(2);
      overlay = Buffer.from(menuSvg(live.hud(), width, height));
    }
    const png = join(outDir, `${p.name}.png`);
    await take(live, p.picture, png, frames);
    const jpg = png.replace(/\.png$/, ".jpg");
    let image = sharp(png);
    if (overlay) image = sharp(await image.composite([{ input: overlay }]).png().toBuffer());
    await image.jpeg({ quality: 84, mozjpeg: true }).toFile(jpg);
    rmSync(png);
    const errors = live.errors();
    if (errors.length) console.error(errors.slice(0, 3).join("\n"));
    await live.quit();
    console.log(jpg.replace(ROOT + "/", ""));
  }
} finally {
  rmSync(store, { recursive: true, force: true });
}

/** The HUD's centre items (the menu) as ThreeRT for macOS draws them: a table on dark glass, small lines under it. */
function menuSvg(hud: any, w: number, h: number): string {
  const s = w / 1100;                             // (the HUD's points, at this picture's size)
  const items = (hud.items ?? []).filter((i: any) => i.anchor === "center");
  const table = items.find((i: any) => i.type === "table");
  const lines = items.filter((i: any) => i.type === "text");
  const tone: Record<string, string> = { default: "#ece8e1", good: "#7fe0a6", warn: "#f2c45c", bad: "#ff8a84", accent: "#9ecbff", dim: "#bdb8af" };
  const esc = (t: unknown) => String(t ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const cw = table.columns.map((c: string, k: number) => Math.ceil(Math.max(c.length * 7.2, ...table.rows.map((r: unknown[]) => String(r[k] ?? "").length * 7.3)) + 4));
  const tw = 34 + cw.reduce((a: number, b: number) => a + b + 16, -16);
  const th = 16 + 26 + 24 * (table.rows.length + 1) + 4 * table.rows.length + 16;
  const lh = lines.length * 18 + 8;
  const x0 = (w / s - tw) / 2, y0 = (h / s - th - lh) / 2;
  let out = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><g transform="scale(${s})" font-family="Menlo, monospace">`;
  out += `<rect x="${x0}" y="${y0}" width="${tw}" height="${th}" rx="16" fill="#0b0c10" fill-opacity="0.9" stroke="#ece8e1" stroke-opacity="0.12"/>`;
  out += `<text x="${x0 + 17}" y="${y0 + 32}" font-family="Helvetica Neue, Helvetica, Arial" font-weight="700" font-size="14" fill="#ece8e1">${esc(table.title)}</text>`;
  const row = (y: number, cells: unknown[], cls: "head" | "own" | "row") => {
    let x = x0 + 17 + 8, t = "";
    if (cls === "own") t += `<rect x="${x0 + 17}" y="${y}" width="${tw - 34}" height="24" rx="6" fill="#ece8e1" fill-opacity="0.1"/>`;
    cells.forEach((c, k) => {
      t += `<text x="${x}" y="${y + 16}" font-size="${cls === "head" ? 10 : 12}" fill="${cls === "own" ? "#ece8e1" : cls === "head" ? "#bdb8af" : "#bdb8af"}" ${cls === "head" ? 'letter-spacing="1"' : ""}>${esc(cls === "head" ? String(c).toUpperCase() : c)}</text>`;
      x += cw[k] + 16;
    });
    return t;
  };
  let y = y0 + 42;
  out += row(y, table.columns, "head");
  y += 28;
  table.rows.forEach((r: unknown[], n: number) => { out += row(y, r, n === table.highlight ? "own" : "row"); y += 28; });
  y = y0 + th + 22;
  for (const l of lines) {
    const lw = String(l.text).length * 6.1 + 20;
    out += `<rect x="${w / s / 2 - lw / 2}" y="${y - 13}" width="${lw}" height="18" rx="6" fill="#0b0c10" fill-opacity="0.72"/>`;
    out += `<text x="${w / s / 2}" y="${y}" text-anchor="middle" font-family="Helvetica Neue, Helvetica, Arial" font-size="12" fill="${tone[l.tone ?? "default"]}">${esc(l.text)}</text>`;
    y += 22;
  }
  return out + "</g></svg>";
}
