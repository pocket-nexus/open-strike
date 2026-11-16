// Minimal binary glTF 2.0 writer for the weapon models: one node per part (identity transform, geometry in weapon
// space), one primitive per material (POSITION, NORMAL, indices), PBR factors only.
import { writeFileSync } from "node:fs";
import type { Buf, MaterialDef } from "./kit.ts";

/** Writes `parts` (part -> material -> buffers, in millimetres) to `path` in metres. Returns the triangle count. */
export function writeGlb(path: string, parts: Map<string, Map<string, Buf>>, materials: Record<string, MaterialDef>, order: string[] = [], scale = 0.001): number {
  const chunks: Buffer[] = [];
  let offset = 0;
  const bufferViews: object[] = [];
  const accessors: object[] = [];
  const view = (data: Buffer, target: number): number => {
    const pad = (4 - (data.length % 4)) % 4;
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: data.length, target });
    chunks.push(data, Buffer.alloc(pad));
    offset += data.length + pad;
    return bufferViews.length - 1;
  };
  const used = [...new Set([...parts.values()].flatMap((m) => [...m.keys()]))];
  for (const m of used) if (!materials[m]) throw new Error(`unknown material ${m}`);
  const gltfMaterials = used.map((name) => ({ name, pbrMetallicRoughness: { baseColorFactor: [...materials[name].color, 1], metallicFactor: materials[name].metallic, roughnessFactor: materials[name].roughness } }));
  const meshes: object[] = [];
  const nodes: object[] = [];
  let tris = 0;
  const names = [...order.filter((n) => parts.has(n)), ...[...parts.keys()].filter((n) => !order.includes(n))];
  for (const name of names) {
    const primitives: object[] = [];
    for (const [mat, b] of parts.get(name)!) {
      if (b.idx.length === 0) continue;
      const count = b.pos.length / 3;
      const pos = new Float32Array(b.pos.length);
      const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < b.pos.length; i++) {
        pos[i] = b.pos[i] * scale;
        min[i % 3] = Math.min(min[i % 3], pos[i]);
        max[i % 3] = Math.max(max[i % 3], pos[i]);
      }
      const nrm = Float32Array.from(b.nrm);
      const small = count <= 65535;
      const idx = small ? Uint16Array.from(b.idx) : Uint32Array.from(b.idx);
      const pv = view(Buffer.from(pos.buffer), 34962);
      accessors.push({ bufferView: pv, componentType: 5126, count, type: "VEC3", min, max });
      const nv = view(Buffer.from(nrm.buffer), 34962);
      accessors.push({ bufferView: nv, componentType: 5126, count, type: "VEC3" });
      const iv = view(Buffer.from(idx.buffer), 34963);
      accessors.push({ bufferView: iv, componentType: small ? 5123 : 5125, count: b.idx.length, type: "SCALAR" });
      primitives.push({ attributes: { POSITION: accessors.length - 3, NORMAL: accessors.length - 2 }, indices: accessors.length - 1, material: used.indexOf(mat), mode: 4 });
      tris += b.idx.length / 3;
    }
    if (primitives.length === 0) continue;
    meshes.push({ name, primitives });
    nodes.push({ name, mesh: meshes.length - 1 });
  }
  const json = {
    asset: { version: "2.0", generator: "openstrike weapons/build.ts" },
    scene: 0,
    scenes: [{ nodes: nodes.map((_, i) => i) }],
    nodes,
    meshes,
    materials: gltfMaterials,
    accessors,
    bufferViews,
    buffers: [{ byteLength: offset }],
  };
  let jsonBuf = Buffer.from(JSON.stringify(json), "utf8");
  jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc((4 - (jsonBuf.length % 4)) % 4, 0x20)]);
  const bin = Buffer.concat(chunks);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonBuf.length + 8 + bin.length, 8);
  const jh = Buffer.alloc(8);
  jh.writeUInt32LE(jsonBuf.length, 0);
  jh.writeUInt32LE(0x4e4f534a, 4);
  const bh = Buffer.alloc(8);
  bh.writeUInt32LE(bin.length, 0);
  bh.writeUInt32LE(0x004e4942, 4);
  writeFileSync(path, Buffer.concat([header, jh, jsonBuf, bh, bin]));
  return tris;
}
