// Builds the soldier's model in code (no modelling files): assets/characters/operator.glb and
// src/character/meta.json (where the hands hold a weapon, which parts have gear).
//
// The file has, for each outfit (`.ember`, ...; the outfits share the triangles and differ in materials):
// - `body.<outfit>`: the clothed body, one mesh skinned to the joints of SKELETON (src/character/rig.ts), which are
//   nodes of the file named as the parts, at their frames in the bind pose (skeleton.ts);
// - `<part>.<outfit>`: the gear on a part (the helmet, the carrier, the pads, a glove, a boot), rigid, in the part's
//   own space, for the game to place at the part's frame.
//
//   node tools/characters/build.ts [--look]
// `--look` also renders the soldier in the bind pose and in a few others in the studio (out/studio/operator-*.png).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../lib/engine.ts";
import { JOINTS, OPERATOR_MODEL, OUTFITS, PARTS, bodyNode, partNode, type PartName } from "../../src/character/rig.ts";
import { type Buf, mesh } from "./mesh.ts";
import { operator, type PartDef } from "./operator.ts";
import { CLOTH, OUTFIT } from "./outfits.ts";
import { Glb } from "./gltf.ts";
import { hands } from "./hands.ts";
import { len, sub } from "./sdf.ts";
import { bindPose, jointsOf } from "./skeleton.ts";
import { skinBody, type Skinned } from "./skin.ts";

/** How far (millimetres) the simplified surface may be from the sculpted one: the gear, the skinned body. */
const TOLERANCE = 0.35;
const BODY_TOLERANCE = 0.9;
/** The skinned body's triangle size by material (millimetres): it is skinned again every frame it moves. */
const BODY_CELL = { fabric: 10, mask: 7 };
/** Gear this near one of its part's joints keeps what of it is inside the cloth: there the cloth bends away. */
const JOINT_ZONE = 120;

/** Triangles by material. */
export type Meshed = Map<string, Buf>;

/** The gear of a part (its layers not of the skinned body), in the part's own space. */
export function meshGear(p: PartDef, joints: [number, number, number][] = []): Meshed {
  const out: Meshed = new Map();
  const rigid = p.layers.filter((l) => !l.skin), cloth = p.layers.filter((l) => l.skin);
  const nearJoint = (x: number, y: number, z: number) => joints.some((j) => len(sub([x, y, z], j)) < JOINT_ZONE);
  rigid.forEach((l, i) => {
    const others = rigid.filter((_, j) => j !== i).map((o) => o.shape);
    if (!out.has(l.mat)) out.set(l.mat, { pos: [], nrm: [], idx: [] });
    const cell = l.cell ?? p.cell;
    const hidden = (x: number, y: number, z: number) => others.some((o) => o(x, y, z) < -1.5) || (!nearJoint(x, y, z) && cloth.some((c) => c.shape(x, y, z) < -1.5));
    mesh(l.shape, { min: p.min, max: p.max, cell, detail: Math.min(1, cell / 4), tolerance: TOLERANCE, hidden }, out.get(l.mat)!);
  });
  return out;
}

const count = (m: Map<string, Buf>) => [...m.values()].reduce((a, b) => a + b.idx.length / 3, 0);
const list = (m: Map<string, Buf>) => [...m].map(([k, b]) => `${k} ${b.idx.length / 3}`).join(", ");

/** Writes the body and the gear (millimetres) as one binary glTF in metres. */
export function writeModel(path: string, body: Map<string, Skinned>, gear: Map<PartName, Meshed>): void {
  const glb = new Glb();
  const used = [...new Set([...body.keys(), ...[...gear.values()].flatMap((m) => [...m.keys()])])];
  const material = new Map<string, number>();
  for (const o of OUTFITS) for (const name of used) {
    if (!OUTFIT[o][name]) throw new Error(`outfit ${o} has no material ${name}`);
    material.set(`${name}.${o}`, glb.material(`${name}.${o}`, OUTFIT[o][name]!, CLOTH[name]));
  }
  // (The outfits share the triangles and differ in materials.)
  const nodes = (name: (o: (typeof OUTFITS)[number]) => string, mats: Map<string, Buf>, skin?: number) => {
    const prims = [...mats].filter(([, b]) => b.idx.length > 0).map(([mat, b]) => ({ mat, ...glb.geometry(b, 0.001, CLOTH[mat]) }));
    for (const o of OUTFITS) glb.node(name(o), prims.map((p) => ({ attributes: p.attributes, indices: p.indices, material: material.get(`${p.mat}.${o}`)! })), skin);
  };
  const bind = bindPose();
  const skin = glb.skeleton(JOINTS.map((j) => ({ name: j, bind: bind[j] })), 0.001);
  nodes(bodyNode, body, skin);
  for (const [part, mats] of gear) nodes((o) => partNode(part, o), mats);
  glb.write(path, "openstrike characters/build.ts");
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const defs = operator();
  const held = hands();
  const bind = bindPose();
  let t0 = performance.now();
  const body = skinBody(defs, { cell: BODY_CELL, tolerance: BODY_TOLERANCE });
  console.log(`body     ${String(count(body)).padStart(6)} tris  (${list(body)})  ${((performance.now() - t0) / 1000).toFixed(1)} s  (skinned)`);
  const gear = new Map<PartName, Meshed>();
  let total = count(body);
  for (const name of PARTS) {
    t0 = performance.now();
    const m = name === "hand_r" ? held.right : name === "hand_l" ? held.left : meshGear(defs[name], jointsOf(name, bind));
    if (count(m) === 0) continue;
    gear.set(name, m);
    total += count(m);
    console.log(`${name.padEnd(8)} ${String(count(m)).padStart(6)} tris  (${list(m)})  ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  }
  mkdirSync(join(ROOT, "assets/characters"), { recursive: true });
  writeModel(join(ROOT, OPERATOR_MODEL), body, gear);
  writeFileSync(join(ROOT, "src/character/meta.json"), JSON.stringify({ ...held.meta, gear: [...gear.keys()] }, null, 2) + "\n");
  console.log(`${OPERATOR_MODEL}: ${total} tris (${count(body)} skinned)`);
  if (args.includes("--look")) {
    const { look } = await import("./look.ts");
    await look([...gear.keys()]);
  }
}
