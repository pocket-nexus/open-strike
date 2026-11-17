// A studio to look at models in while they are sculpted: the models on a grey floor under the sun and the sky,
// rendered offline from any camera.
//
//   node tools/characters/studio.ts --weapon carbine [--camera '{"position":[x,y,z],"target":[x,y,z],"fov":40}'] [-o out.png] [--spp 64]
// From code: `studio(items, camera, out)` with any models, nodes and placements (operator.ts' pictures use it).
import { mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { ENGINE, RENDERER, ROOT } from "../lib/engine.ts";
import { build } from "../build.ts";

export interface Item { uri: string; nodes?: string[]; position?: [number, number, number]; quaternion?: [number, number, number, number] }
export interface Camera { position: [number, number, number]; target: [number, number, number]; fov?: number }

export async function studio(items: Item[], camera: Camera, out: string, o: { spp?: number; sun?: [number, number]; width?: number; height?: number } = {}): Promise<void> {
  const entry = join(ROOT, "out/studio-entry.ts");
  mkdirSync(dirname(entry), { recursive: true });
  writeFileSync(entry, `
import { defineGame } from "@threert/gameplay";
import { Scene, PerspectiveCamera, Mesh, PlaneGeometry, MeshStandardMaterial, DirectionalLight, SkyAtmosphere, GLTFModel } from "@threert/scene";
const ITEMS = ${JSON.stringify(items)};
const CAMERA = ${JSON.stringify(camera)};
export default defineGame({ state: {}, handlers: {}, setup() {
  const scene = new Scene();
  const sun = new DirectionalLight(0xffffff, 80000).setSunAngles(${(o.sun ?? [42, -50])[0]}, ${(o.sun ?? [42, -50])[1]});
  scene.add(sun);
  scene.environment = new SkyAtmosphere({ sun });
  const ground = new Mesh(new PlaneGeometry(60, 60), new MeshStandardMaterial({ color: 0x77777a, roughness: 0.8 }));
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);
  for (const it of ITEMS) {
    const m = new GLTFModel(it.uri, it.nodes ? { nodes: it.nodes } : {});
    if (it.position) m.position.set(it.position[0], it.position[1], it.position[2]);
    if (it.quaternion) m.quaternion.set(it.quaternion[0], it.quaternion[1], it.quaternion[2], it.quaternion[3]);
    scene.add(m);
  }
  const camera = new PerspectiveCamera(CAMERA.fov ?? 35, ${(o.width ?? 1280) / (o.height ?? 720)}, 0.02, 200);
  camera.position.set(CAMERA.position[0], CAMERA.position[1], CAMERA.position[2]);
  camera.lookAt(CAMERA.target[0], CAMERA.target[1], CAMERA.target[2]);
  scene.add(camera);
  return { scene, camera };
} });
`);
  const bundle = join(ROOT, "out/studio.js");
  await build(bundle, entry);
  mkdirSync(dirname(resolve(out)), { recursive: true });
  execFileSync(RENDERER, ["render", bundle, "-o", resolve(out), "--assets", ROOT, "--presets", join(ENGINE, "presets"), "--spp", String(o.spp ?? 64), "--width", String(o.width ?? 1280), "--height", String(o.height ?? 720)], { stdio: ["ignore", "ignore", "inherit"] });
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const flag = (k: string) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
  const weapon = flag("--weapon") ?? "carbine";
  const camera: Camera = flag("--camera") ? JSON.parse(flag("--camera")!) : { position: [-0.35, 1.25, 0.25], target: [0, 1, -0.2], fov: 40 };
  const out = flag("-o") ?? `out/studio/${weapon}.png`;
  await studio([{ uri: `assets/weapons/${weapon}.glb`, position: [0, 1, 0] }], camera, out, { spp: Number(flag("--spp") ?? 64) });
  console.log(out);
}
