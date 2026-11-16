// Copies the CC0 textures the game ships from the machine's asset store (Poly Haven sets fetched by the engine's
// tools/fetch-polyhaven.ts) into assets/textures, at 1k. Everything it writes is listed in assets/CREDITS.md.
//
//   node tools/assets.ts
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { ASSET_STORE, ROOT, engineRequire } from "./lib/engine.ts";

const sharp = engineRequire("sharp") as typeof import("sharp");
/** Poly Haven texture sets (https://polyhaven.com/a/<id>), CC0. */
export const TEXTURES = ["concrete_floor_02", "painted_concrete", "corrugated_iron_02", "metal_plate", "dirty_concrete", "precast_concrete_wall", "asphalt_02"];
const MAPS: [from: string, to: string][] = [["diff", "diff"], ["nor_gl", "nor"], ["rough", "rough"]];

for (const id of TEXTURES) {
  const out = join(ROOT, "assets/textures", id);
  mkdirSync(out, { recursive: true });
  for (const [from, to] of MAPS) {
    const src = ["1k", "2k"].map((r) => join(ASSET_STORE, "polyhaven/tex", id, `${id}_${from}_${r}.jpg`)).find((p) => existsSync(p));
    if (!src) throw new Error(`${id}: no ${from} map in ${ASSET_STORE}`);
    const info = await sharp(src).resize(1024, 1024).jpeg({ quality: 82 }).toFile(join(out, `${to}.jpg`));
    console.log(`${id}/${to}.jpg ${(info.size / 1024).toFixed(0)} KiB`);
  }
}
