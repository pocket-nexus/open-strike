// Writes the weapon models: one node per part (identity transform, geometry in weapon space), one primitive per
// material (PBR factors; the sleeve's cloth has its pictures). The glTF writer itself is ../characters/gltf.ts.
import type { Buf, MaterialDef } from "./kit.ts";
import { type Cloth, Glb } from "../characters/gltf.ts";

/** Writes `parts` (part -> material -> buffers, in millimetres) to `path` in metres. Returns the triangle count. */
export function writeGlb(path: string, parts: Map<string, Map<string, Buf>>, materials: Record<string, MaterialDef>, order: string[] = [], scale = 0.001, cloth: Record<string, Cloth> = {}): number {
  const glb = new Glb();
  const used = [...new Set([...parts.values()].flatMap((m) => [...m.keys()]))];
  for (const m of used) if (!materials[m]) throw new Error(`unknown material ${m}`);
  const index = new Map(used.map((name) => [name, glb.material(name, materials[name]!, cloth[name])]));
  const names = [...order.filter((n) => parts.has(n)), ...[...parts.keys()].filter((n) => !order.includes(n))];
  for (const name of names) {
    const prims = [...parts.get(name)!].filter(([, b]) => b.idx.length > 0).map(([mat, b]) => ({ ...glb.geometry(b, scale, cloth[mat]), material: index.get(mat)! }));
    if (prims.length) glb.node(name, prims);
  }
  glb.write(path, "openstrike weapons/build.ts");
  return glb.triangles;
}
