// A small binary glTF 2.0 writer for the models built in code (the soldier, the weapons): triangles with normals, for
// cloth texture coordinates and the textures in the file, and a skeleton for a skinned mesh.
import { writeFileSync } from "node:fs";
import type { Buf } from "./mesh.ts";
import type { Frame } from "./sdf.ts";
import { camo, cordura, mapped, weave } from "./textures.ts";

/** The cloth pictures by name (made once). */
const PICTURES: Record<string, () => Uint8Array> = { camo, cordura, weave };
/** How a material's cloth is textured: its base colour picture, the weave's relief, how wide the pictures are. */
export interface Cloth { map: "camo" | "cordura"; relief: number; repeat: number }
export interface Factors { color: [number, number, number]; metallic: number; roughness: number }

export class Glb {
  private readonly chunks: Buffer[] = [];
  private offset = 0;
  private readonly bufferViews: object[] = [];
  private readonly accessors: object[] = [];
  private readonly images: object[] = [];
  private readonly textures: object[] = [];
  private readonly made = new Map<string, number>();
  readonly materials: object[] = [];
  readonly meshes: object[] = [];
  readonly nodes: object[] = [];
  triangles = 0;

  private view(data: Uint8Array, target?: number): number {
    const pad = (4 - (data.length % 4)) % 4;
    this.bufferViews.push({ buffer: 0, byteOffset: this.offset, byteLength: data.length, ...(target ? { target } : {}) });
    this.chunks.push(Buffer.from(data.buffer, data.byteOffset, data.byteLength), Buffer.alloc(pad));
    this.offset += data.length + pad;
    return this.bufferViews.length - 1;
  }

  /** A picture as a texture of the file (once a name). */
  private texture(name: string): number {
    let t = this.made.get(name);
    if (t === undefined) {
      this.images.push({ bufferView: this.view(PICTURES[name]!()), mimeType: "image/png" });
      this.textures.push({ source: this.images.length - 1, sampler: 0 });
      this.made.set(name, (t = this.textures.length - 1));
    }
    return t;
  }

  /** A material; with `cloth`, its pictures. Returns its index. */
  material(name: string, m: Factors, cloth?: Cloth): number {
    this.materials.push({
      name,
      pbrMetallicRoughness: { baseColorFactor: [...m.color, 1], metallicFactor: m.metallic, roughnessFactor: m.roughness, ...(cloth ? { baseColorTexture: { index: this.texture(cloth.map) } } : {}) },
      ...(cloth && cloth.relief > 0 ? { normalTexture: { index: this.texture("weave"), scale: cloth.relief } } : {}),
    });
    return this.materials.length - 1;
  }

  /**
   * The triangles of `b` (in `scale` units of a metre; with `cloth`, mapped for its pictures) as a primitive's
   * accessors; with `joints` and `weights` (four a vertex), skinned.
   */
  geometry(b: Buf & { joints?: number[]; weights?: number[] }, scale: number, cloth?: Cloth): { attributes: Record<string, number>; indices: number } {
    const g: Buf & { uv?: number[]; joints?: number[]; weights?: number[] } = cloth ? mapped(b, cloth.repeat) : b;
    const count = g.pos.length / 3;
    const pos = new Float32Array(g.pos.length);
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < g.pos.length; i++) {
      pos[i] = g.pos[i]! * scale;
      min[i % 3] = Math.min(min[i % 3]!, pos[i]!);
      max[i % 3] = Math.max(max[i % 3]!, pos[i]!);
    }
    const acc = (data: Uint8Array, target: number, a: object) => { this.accessors.push({ bufferView: this.view(data, target), ...a }); return this.accessors.length - 1; };
    const bytes = (a: Float32Array | Uint16Array | Uint32Array) => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
    const attributes: Record<string, number> = {
      POSITION: acc(bytes(pos), 34962, { componentType: 5126, count, type: "VEC3", min, max }),
      NORMAL: acc(bytes(Float32Array.from(g.nrm)), 34962, { componentType: 5126, count, type: "VEC3" }),
    };
    if (g.uv) attributes.TEXCOORD_0 = acc(bytes(Float32Array.from(g.uv)), 34962, { componentType: 5126, count, type: "VEC2" });
    if (g.joints && g.weights) {
      attributes.JOINTS_0 = acc(Uint8Array.from(g.joints), 34962, { componentType: 5121, count, type: "VEC4" });
      attributes.WEIGHTS_0 = acc(bytes(Float32Array.from(g.weights)), 34962, { componentType: 5126, count, type: "VEC4" });
    }
    const idx = count <= 65535 ? Uint16Array.from(g.idx) : Uint32Array.from(g.idx);
    this.triangles += g.idx.length / 3;
    return { attributes, indices: acc(bytes(idx), 34963, { componentType: count <= 65535 ? 5123 : 5125, count: g.idx.length, type: "SCALAR" }) };
  }

  /** A node with a mesh of these primitives (identity transform); with `skin`, the skin's index. */
  node(name: string, primitives: { attributes: Record<string, number>; indices: number; material: number }[], skin?: number): void {
    this.meshes.push({ name, primitives: primitives.map((p) => ({ ...p, mode: 4 })) });
    this.nodes.push({ name, mesh: this.meshes.length - 1, ...(skin === undefined ? {} : { skin }) });
  }

  private readonly skins: object[] = [];
  /**
   * A skeleton: a node for each joint at its frame in the bind pose (`scale` units of a metre), each a root of the
   * scene (a joint's transform is its place in the model's space), and the skin binding a mesh to them. Returns the
   * skin's index.
   */
  skeleton(joints: { name: string; bind: Frame }[], scale: number): number {
    const first = this.nodes.length;
    const ibm = new Float32Array(joints.length * 16);
    joints.forEach(({ name, bind: f }, k) => {
      const o = f.o.map((v) => v * scale);
      this.nodes.push({ name, translation: o, rotation: quaternion(f) });
      // The inverse of [x y z o]: the axes' transpose, and -Rᵀo (column-major).
      const m = [f.x[0], f.y[0], f.z[0], 0, f.x[1], f.y[1], f.z[1], 0, f.x[2], f.y[2], f.z[2], 0];
      const t = [0, 1, 2].map((r) => -(m[r]! * o[0]! + m[4 + r]! * o[1]! + m[8 + r]! * o[2]!));
      ibm.set([...m, t[0]!, t[1]!, t[2]!, 1], k * 16);
    });
    this.accessors.push({ bufferView: this.view(new Uint8Array(ibm.buffer)), componentType: 5126, count: joints.length, type: "MAT4" });
    this.skins.push({ joints: joints.map((_, k) => first + k), inverseBindMatrices: this.accessors.length - 1 });
    return this.skins.length - 1;
  }

  write(path: string, generator: string): void {
    const json: Record<string, unknown> = {
      asset: { version: "2.0", generator }, scene: 0, scenes: [{ nodes: this.nodes.map((_, i) => i) }], nodes: this.nodes, meshes: this.meshes, materials: this.materials,
      accessors: this.accessors, bufferViews: this.bufferViews, buffers: [{ byteLength: this.offset }],
    };
    if (this.skins.length) Object.assign(json, { skins: this.skins });
    if (this.textures.length) Object.assign(json, { textures: this.textures, images: this.images, samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }] });
    let text = Buffer.from(JSON.stringify(json), "utf8");
    text = Buffer.concat([text, Buffer.alloc((4 - (text.length % 4)) % 4, 0x20)]);
    const bin = Buffer.concat(this.chunks);
    const head = Buffer.alloc(20);
    head.writeUInt32LE(0x46546c67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + 8 + text.length + 8 + bin.length, 8);
    head.writeUInt32LE(text.length, 12); head.writeUInt32LE(0x4e4f534a, 16);
    const bh = Buffer.alloc(8);
    bh.writeUInt32LE(bin.length, 0); bh.writeUInt32LE(0x004e4942, 4);
    writeFileSync(path, Buffer.concat([head, text, bh, bin]));
  }
}

/** A frame's turn as a unit quaternion (x, y, z, w). */
export function quaternion(f: Frame): [number, number, number, number] {
  const [m00, m10, m20] = f.x, [m01, m11, m21] = f.y, [m02, m12, m22] = f.z;
  const tr = m00 + m11 + m22;
  let q: [number, number, number, number];
  if (tr > 0) { const s = Math.sqrt(tr + 1) * 2; q = [(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, s / 4]; }
  else if (m00 > m11 && m00 > m22) { const s = Math.sqrt(1 + m00 - m11 - m22) * 2; q = [s / 4, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s]; }
  else if (m11 > m22) { const s = Math.sqrt(1 + m11 - m00 - m22) * 2; q = [(m01 + m10) / s, s / 4, (m12 + m21) / s, (m02 - m20) / s]; }
  else { const s = Math.sqrt(1 + m22 - m00 - m11) * 2; q = [(m02 + m20) / s, (m12 + m21) / s, s / 4, (m10 - m01) / s]; }
  const l = Math.hypot(...q);
  return q.map((v) => v / l) as [number, number, number, number];
}
