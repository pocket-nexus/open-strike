// Builds the soldier's model in code (no modelling files): assets/characters/operator.glb, one node for each part of
// the body in each outfit (`chest.ember`, ...; the outfits share the triangles and differ in materials), and
// src/character/meta.json (where the hands hold a weapon).
//
//   node tools/characters/build.ts [--only head,chest] [--look]
// `--look` also renders the soldier at rest in the studio (out/studio/operator-*.png) to look at.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../lib/engine.ts";
import { OPERATOR_MODEL, OUTFITS, PARTS, RIG, partNode, type PartName } from "../../src/character/rig.ts";
import { type Buf, mesh } from "./mesh.ts";
import { operator, type PartDef } from "./operator.ts";
import { CLOTH, OUTFIT } from "./outfits.ts";
import { Glb } from "./gltf.ts";
import { hands } from "./hands.ts";

/** How far (millimetres) the simplified surface may be from the sculpted one. */
const TOLERANCE = 0.35;

/** A part as triangles: a buffer for each material. */
export type Meshed = Map<string, Buf>;

export function meshPart(p: PartDef): Meshed {
  const out: Meshed = new Map();
  p.layers.forEach((l, i) => {
    const others = p.layers.filter((_, j) => j !== i).map((o) => o.shape);
    if (!out.has(l.mat)) out.set(l.mat, { pos: [], nrm: [], idx: [] });
    const cell = l.cell ?? p.cell;
    mesh(l.shape, { min: p.min, max: p.max, cell, detail: Math.min(1, cell / 4), tolerance: TOLERANCE, hidden: (x, y, z) => others.some((o) => o(x, y, z) < -1.5) }, out.get(l.mat)!);
  });
  return out;
}

/** Writes the parts (millimetres) as one binary glTF in metres: a node for each part in each outfit. */
export function writeModel(path: string, parts: Map<string, Meshed>): number {
  const glb = new Glb();
  const used = [...new Set([...parts.values()].flatMap((m) => [...m.keys()]))];
  const material = new Map<string, number>();
  for (const o of OUTFITS) for (const name of used) {
    if (!OUTFIT[o][name]) throw new Error(`outfit ${o} has no material ${name}`);
    material.set(`${name}.${o}`, glb.material(`${name}.${o}`, OUTFIT[o][name]!, CLOTH[name]));
  }
  for (const [name, mats] of parts) {
    // (The outfits share a part's triangles and differ in its materials.)
    const prims = [...mats].filter(([, b]) => b.idx.length > 0).map(([mat, b]) => ({ mat, ...glb.geometry(b, 0.001, CLOTH[mat]) }));
    const tris = glb.triangles;
    for (const o of OUTFITS) glb.node(partNode(name as PartName, o), prims.map((p) => ({ attributes: p.attributes, indices: p.indices, material: material.get(`${p.mat}.${o}`)! })));
    glb.triangles = tris;
  }
  glb.write(path, "openstrike characters/build.ts");
  return glb.triangles;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const only = args.includes("--only") ? args[args.indexOf("--only") + 1]!.split(",") : null;
  const defs = operator();
  const held = hands();
  const parts = new Map<string, Meshed>();
  let total = 0;
  for (const name of PARTS) {
    if (only && !only.some((o) => name.startsWith(o))) continue;
    const t0 = performance.now();
    const m = name === "hand_r" ? held.right : name === "hand_l" ? held.left : meshPart(defs[name]!);
    parts.set(name, m);
    const n = [...m.values()].reduce((a, b) => a + b.idx.length / 3, 0);
    total += n;
    console.log(`${name.padEnd(8)} ${String(n).padStart(6)} tris  (${[...m].map(([k, b]) => `${k} ${b.idx.length / 3}`).join(", ")})  ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  }
  mkdirSync(join(ROOT, "assets/characters"), { recursive: true });
  writeModel(join(ROOT, OPERATOR_MODEL), parts);
  writeFileSync(join(ROOT, "src/character/meta.json"), JSON.stringify(held.meta, null, 2) + "\n");
  console.log(`${OPERATOR_MODEL}: ${total} tris`);
  if (args.includes("--look")) {
    const { studio } = await import("./studio.ts");
    // At rest: every part at its joint, the arms hanging.
    const up = 0.04, s = RIG.shoulder, h = RIG.hipJoint;
    const rest: Record<string, [number, number, number]> = {
      pelvis: [0, RIG.hip, 0], chest: [0, RIG.hip + RIG.waist, 0], head: [0, RIG.hip + RIG.waist + RIG.neck, 0],
      upper_r: [s[0], RIG.hip + RIG.waist + s[1], 0], fore_r: [s[0], RIG.hip + RIG.waist + s[1] - RIG.upper, 0],
      thigh_r: [h[0], RIG.hip + h[1], 0], shin_r: [h[0], RIG.hip + h[1] - RIG.thigh, 0], foot_r: [h[0], RIG.hip + h[1] - RIG.thigh - RIG.shin, 0],
    };
    for (const [k, v] of Object.entries(rest)) if (k.endsWith("_r")) rest[k.replace("_r", "_l")] = [-v[0], v[1], v[2]];
    const figure = (outfit: (typeof OUTFITS)[number], x: number, turn: number) => [...parts.keys()].filter((p) => rest[p]).map((p) => {
      const c = Math.cos(turn), sn = Math.sin(turn), r = rest[p]!;
      return { uri: OPERATOR_MODEL, nodes: [partNode(p as PartName, outfit)], position: [x + r[0] * c + r[2] * sn, r[1] + up, -r[0] * sn + r[2] * c] as [number, number, number], quaternion: [0, Math.sin(turn / 2), 0, Math.cos(turn / 2)] as [number, number, number, number] };
    });
    const row = [...figure("ember", -0.75, 0.5), ...figure("azure", 0, 0), ...figure("ranger", 0.75, -0.5)];
    await studio(row, { position: [0, 1.25, -3.6], target: [0, 0.98, 0], fov: 34 }, "out/studio/operator-front.png", { sun: [48, 150] });
    await studio([...figure("ember", -0.75, Math.PI + 0.5), ...figure("azure", 0, Math.PI), ...figure("ranger", 0.75, Math.PI / 2)], { position: [0, 1.25, -3.6], target: [0, 0.98, 0], fov: 34 }, "out/studio/operator-back.png", { sun: [48, 150] });
    await studio(figure("azure", 0, 0.35), { position: [0, 1.62, -0.95], target: [0, 1.55, 0], fov: 34 }, "out/studio/operator-head.png", { sun: [48, 150] });
    console.log("out/studio/operator-front.png operator-back.png operator-head.png");
  }
}
