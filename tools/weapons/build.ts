// Builds OpenStrikeRT's weapon models in code (no modelling files): first-person GLBs (nodes body, mag, bolt, arm_r,
// arm_l), low-detail world GLBs (one node, body) for the soldiers' hands, and src/weapons/meta.json (muzzle, ejection
// port, the eye point of the sights, ... in metres, weapon space).
//
//   node tools/weapons/build.ts [--only carbine,shotgun]
//
// Weapon space: metres, +X right, +Y up, -Z forward (the barrel points along -Z); the origin is the top of the pistol
// grip where the web of the firing hand sits. Every node has an identity transform. See kit.ts for the modelling kit.
// The models are original work (the earlier native OpenStrike's, first-party); assets/CREDITS.md lists them.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../lib/engine.ts";
import { Kit } from "./kit.ts";
import { writeGlb } from "./glb.ts";
import { MATERIALS } from "./materials.ts";
import type { Meta } from "./parts.ts";
import { carbine } from "./carbine.ts";
import { dmr } from "./dmr.ts";
import { shotgun } from "./shotgun.ts";

const WEAPONS: Record<string, (k: Kit) => Meta> = { carbine, shotgun, dmr };
const args = process.argv.slice(2);
const only = (args.includes("--only") ? args[args.indexOf("--only") + 1]! : Object.keys(WEAPONS).join(",")).split(",");
const out = join(ROOT, "assets/weapons");
mkdirSync(out, { recursive: true });

const NODES = ["body", "mag", "bolt", "arm_r", "arm_l"];
const all: Record<string, unknown> = {};
const m = (v: number[]) => v.map((x) => +(x / 1000).toFixed(4));
const unit = (v: number[]) => {
  const l = Math.hypot(v[0]!, v[1]!, v[2]!) || 1;
  return v.map((x) => +(x / l).toFixed(4));
};

for (const id of Object.keys(WEAPONS)) {
  if (!only.includes(id)) continue;
  const k = new Kit(0);
  const meta: Meta = WEAPONS[id]!(k);
  const tris = writeGlb(join(out, `${id}.glb`), k.parts, MATERIALS, NODES);
  const w = new Kit(1);
  WEAPONS[id]!(w);
  const worldTris = writeGlb(join(out, `${id}_world.glb`), w.parts, MATERIALS, ["body"]);
  let z0 = Infinity, z1 = -Infinity;
  for (const [name, mats] of k.parts) {
    if (name.startsWith("arm")) continue;
    for (const b of mats.values()) for (let i = 2; i < b.pos.length; i += 3) (z0 = Math.min(z0, b.pos[i]!)), (z1 = Math.max(z1, b.pos[i]!));
  }
  all[id] = {
    muzzle: m(meta.muzzle), eject: m(meta.eject), ejectDir: unit(meta.ejectDir), eye: m(meta.eye), gripL: m(meta.gripL), magOut: m(meta.magOut),
    boltTravel: +(meta.boltTravel / 1000).toFixed(4), length: +((z1 - z0) / 1000).toFixed(4), tris, worldTris,
  };
  const per = [...k.parts.keys()].map((p) => `${p} ${k.triangles(p)}`).join(", ");
  console.log(`${id}: ${tris} tris (${per}); world ${worldTris}; length ${((z1 - z0) / 1000).toFixed(3)} m`);
  for (const wn of new Set([...k.warnings, ...w.warnings])) console.log(`  warning: ${wn}`);
}
writeFileSync(join(ROOT, "src/weapons/meta.json"), JSON.stringify(all, null, 2) + "\n");
