// GoldSrc BSP -> the verified Pocket3D cook -> portable static WebGL site.
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
const root = resolve(import.meta.dir, "..");
const args = Bun.argv.slice(2);
const value = (flag: string) => {
  const i = args.indexOf(flag);
  if (i < 0) return undefined;
  if (!args[i+1] || args[i+1].startsWith("--")) throw new Error(`${flag} needs a value`);
  return args[i+1];
};
if (args.includes("--help")) {
  console.log("bun scripts/build-map-site.ts --bsp MAP.bsp [--psp-map MAP.p3d] [--scene scene.json] [--subdivide 128] [--out dist/map-site]");
  process.exit(0);
}
if (!value("--bsp")) throw new Error("--bsp is required");
const bsp = resolve(value("--bsp")!);
const out = resolve(value("--out") ?? "dist/map-site");
const subdivide = Number(value("--subdivide") ?? 128);
if (!Number.isFinite(subdivide) || subdivide < 16 || subdivide > 256) throw new Error("--subdivide must be between 16 and 256");
if (!existsSync(bsp) || readFileSync(bsp).readInt32LE(0) !== 30) throw new Error("Expected an existing GoldSrc BSP v30");
mkdirSync(join(out,"assets"), { recursive:true });
const cooked = join(out,"assets","map.p3d");
async function run(command: string[]) {
  const child = Bun.spawn(command,{cwd:root,stdout:"inherit",stderr:"inherit"});
  if (await child.exited !== 0) throw new Error(`${command[0]} failed`);
}
await run(["cargo","run","--release","--locked","-q","--manifest-path","vendor/pocketjs/engine/pocket3d/crates/pocket3d-cook/Cargo.toml","--",bsp,"--subdivide",String(subdivide),"--verify","-o",cooked]);
const hash = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
const psp = value("--psp-map");
if (psp && hash(resolve(psp)) !== hash(cooked)) throw new Error("The web cook differs from --psp-map; use the same source, cooker and subdivision");
await run(["cargo","run","--release","--locked","-q","-p","openstrike-core","--example","export_map_site","--",cooked,join(out,"assets")]);
cpSync(join(root,"site/map-viewer"),out,{recursive:true});
cpSync(bsp,join(out,"assets","map.bsp"));
const authored = value("--scene") ? JSON.parse(readFileSync(resolve(value("--scene")!),"utf8")) : {};
const scene = JSON.parse(readFileSync(join(out,"assets","scene.json"),"utf8"));

const views = Array.isArray(authored.views) ? authored.views : Array.isArray(authored.tour) ? authored.tour.map((p: number[],i: number) => ({label: `View ${i+1}`,position:[p[0]*32,p[2]*32,-p[1]*32],pitch:p[3]*Math.PI/180,yaw:0})) : scene.spawns.map((s: unknown,i: number)=>({...s as object,label:`Spawn ${i+1}`}));
// The WWDC generator records the scene title and named views. Generic BSPs
// get their map name and player spawns without scene-specific camera assumptions.
writeFileSync(join(out,"map.json"),JSON.stringify({
  title:authored.title ?? basename(bsp,".bsp"),heading:authored.heading,location:authored.location ?? "OpenStrike map",
  description:authored.description ?? "Explore the map in your browser.",
  reference:authored.reference ?? null,views,
  source:{bsp:hash(bsp),cooked:hash(cooked),subdivide,pspMatch:!!psp},
},null,2));
console.log(`Static map site: ${out}`);
console.log(`Preview: bun scripts/serve-map-site.ts ${out} 4174`);
