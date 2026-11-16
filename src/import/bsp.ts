// GoldSrc BSP version 30, as it is on disk (little-endian). Nothing is converted here: positions are Quake units
// (about an inch), Z is up. convert.ts turns it into a map. Plain TypeScript: the game runs it (docs/MAPS.md).
import { latin1 } from "./bytes.ts";

/** A file the importer cannot read, said in a way the person who ran it can act on. */
export class ImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportError";
  }
}

export const LUMP_NAMES = ["entities", "planes", "textures", "vertices", "visibility", "nodes", "texinfo", "faces", "lighting", "clipnodes", "leaves", "marksurfaces", "edges", "surfedges", "models"] as const;
/** Bytes per record of each lump (0: not an array of records). */
const RECORD = [0, 20, 0, 12, 0, 24, 40, 20, 0, 8, 28, 2, 4, 4, 64];

export const CONTENTS_EMPTY = -1;
export const CONTENTS_SOLID = -2;
export const CONTENTS_WATER = -3;
export const CONTENTS_SKY = -6;

export interface Entity {
  classname: string;
  keys: Record<string, string>;
}

/** A texture as the BSP names it. `data` is the whole miptex record when the pixels are embedded in the map. */
export interface BspTexture {
  name: string;
  width: number;
  height: number;
  data: Uint8Array | null;
}

export interface TexInfo {
  s: [number, number, number];
  sShift: number;
  t: [number, number, number];
  tShift: number;
  miptex: number;
  flags: number;
}

export interface Face {
  plane: number;
  side: number;
  firstEdge: number;
  numEdges: number;
  texinfo: number;
  styles: [number, number, number, number];
  lightOffset: number;
}

export interface Model {
  mins: [number, number, number];
  maxs: [number, number, number];
  origin: [number, number, number];
  /** Root of hull 0 (nodes) and of the clip hulls 1..3 (clipnodes). */
  headNodes: [number, number, number, number];
  visLeafs: number;
  firstFace: number;
  numFaces: number;
}

export interface Bsp {
  entityText: string;
  entities: Entity[];
  /** normal x, y, z, distance: 4 per plane. */
  planes: Float32Array;
  textures: BspTexture[];
  /** x, y, z: 3 per vertex. */
  vertices: Float32Array;
  visibility: Uint8Array;
  /** plane, front child, back child: 3 per node. A negative child is a leaf: ~child. */
  nodes: Int32Array;
  texinfo: TexInfo[];
  faces: Face[];
  lighting: Uint8Array;
  /** plane, front child, back child: 3 per clip node. A negative child is the contents there. */
  clipnodes: Int32Array;
  leafContents: Int32Array;
  marksurfaces: Uint16Array;
  /** two vertex indices per edge. */
  edges: Uint16Array;
  surfedges: Int32Array;
  models: Model[];
}

/** A NUL-terminated name in a fixed field. */
export function fixedString(bytes: Uint8Array, offset: number, length: number): string {
  let end = offset;
  while (end < offset + length && bytes[end] !== 0) end++;
  return latin1(bytes, offset, end);
}

export function parseBsp(bytes: Uint8Array, name = "the file"): Bsp {
  const g = parseBspSteps(bytes, name);
  for (;;) {
    const r = g.next();
    if (r.done) return r.value;
  }
}

/** `parseBsp` a lump at a time: yields between the larger lumps (the fraction done), returns the map. */
export function* parseBspSteps(bytes: Uint8Array, name = "the file"): Generator<number, Bsp> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 4) throw new ImportError(`${name} is ${bytes.length} bytes: not a map`);
  const magic = latin1(bytes, 0, 4);
  if (magic === "VBSP") throw new ImportError(`${name} is a Source engine map (VBSP). Only GoldSrc maps (BSP version 30: Half-Life, Counter-Strike 1.x) can be imported.`);
  if (magic === "WAD3" || magic === "WAD2") throw new ImportError(`${name} is a texture archive (${magic}), not a map. Give the map's .bsp file, and the archive's directory with --wad.`);
  if (magic === "IBSP" || magic === "RBSP") throw new ImportError(`${name} is a Quake 2 / Quake 3 family map (${magic}). Only GoldSrc maps (BSP version 30) can be imported.`);
  const version = view.getInt32(0, true);
  if (version === 29) throw new ImportError(`${name} is a Quake map (BSP version 29). Only GoldSrc maps (BSP version 30) can be imported.`);
  if (version !== 30) throw new ImportError(`${name} is not a GoldSrc map: its version is ${version}, expected 30.`);
  const headerSize = 4 + 15 * 8;
  if (bytes.length < headerSize) throw new ImportError(`${name} is truncated: ${bytes.length} bytes, the header alone is ${headerSize}.`);

  const lump = (i: number): Uint8Array => {
    const offset = view.getInt32(4 + i * 8, true);
    const length = view.getInt32(8 + i * 8, true);
    if (offset < 0 || length < 0 || offset + length > bytes.length) {
      throw new ImportError(`${name} is truncated or damaged: its ${LUMP_NAMES[i]} lump (${length} bytes at ${offset}) runs past the end of the file (${bytes.length} bytes).`);
    }
    if (RECORD[i] && length % RECORD[i] !== 0) throw new ImportError(`${name} is damaged: its ${LUMP_NAMES[i]} lump is ${length} bytes, not a multiple of ${RECORD[i]}.`);
    return bytes.subarray(offset, offset + length);
  };
  const dv = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);

  const entityText = latin1(lump(0)).replace(/\0+$/, "");

  const planeBytes = lump(1), pv = dv(planeBytes);
  const planes = new Float32Array((planeBytes.length / 20) * 4);
  for (let i = 0; i < planes.length / 4; i++) for (let k = 0; k < 4; k++) planes[i * 4 + k] = pv.getFloat32(i * 20 + k * 4, true);

  yield 0.15;
  const vertexBytes = lump(3), vv = dv(vertexBytes);
  const vertices = new Float32Array(vertexBytes.length / 4);
  for (let i = 0; i < vertices.length; i++) vertices[i] = vv.getFloat32(i * 4, true);

  yield 0.25;
  const nodeBytes = lump(5), nv = dv(nodeBytes);
  const nodes = new Int32Array((nodeBytes.length / 24) * 3);
  for (let i = 0; i < nodes.length / 3; i++) {
    nodes[i * 3] = nv.getInt32(i * 24, true);
    nodes[i * 3 + 1] = nv.getInt16(i * 24 + 4, true);
    nodes[i * 3 + 2] = nv.getInt16(i * 24 + 6, true);
  }

  yield 0.35;
  const texinfoBytes = lump(6), tv = dv(texinfoBytes);
  const texinfo: TexInfo[] = [];
  for (let o = 0; o < texinfoBytes.length; o += 40) {
    const f = (k: number) => tv.getFloat32(o + k * 4, true);
    texinfo.push({ s: [f(0), f(1), f(2)], sShift: f(3), t: [f(4), f(5), f(6)], tShift: f(7), miptex: tv.getUint32(o + 32, true), flags: tv.getUint32(o + 36, true) });
  }

  yield 0.45;
  const faceBytes = lump(7), fv = dv(faceBytes);
  const faces: Face[] = [];
  for (let o = 0; o < faceBytes.length; o += 20) {
    faces.push({
      plane: fv.getUint16(o, true),
      side: fv.getUint16(o + 2, true),
      firstEdge: fv.getInt32(o + 4, true),
      numEdges: fv.getUint16(o + 8, true),
      texinfo: fv.getUint16(o + 10, true),
      styles: [faceBytes[o + 12], faceBytes[o + 13], faceBytes[o + 14], faceBytes[o + 15]],
      lightOffset: fv.getInt32(o + 16, true),
    });
  }

  yield 0.6;
  const clipBytes = lump(9), cv = dv(clipBytes);
  const clipnodes = new Int32Array((clipBytes.length / 8) * 3);
  for (let i = 0; i < clipnodes.length / 3; i++) {
    clipnodes[i * 3] = cv.getInt32(i * 8, true);
    clipnodes[i * 3 + 1] = cv.getInt16(i * 8 + 4, true);
    clipnodes[i * 3 + 2] = cv.getInt16(i * 8 + 6, true);
  }

  yield 0.7;
  const leafBytes = lump(10), lv = dv(leafBytes);
  const leafContents = new Int32Array(leafBytes.length / 28);
  for (let i = 0; i < leafContents.length; i++) leafContents[i] = lv.getInt32(i * 28, true);

  const markBytes = lump(11), mv = dv(markBytes);
  const marksurfaces = new Uint16Array(markBytes.length / 2);
  for (let i = 0; i < marksurfaces.length; i++) marksurfaces[i] = mv.getUint16(i * 2, true);

  yield 0.8;
  const edgeBytes = lump(12), ev = dv(edgeBytes);
  const edges = new Uint16Array(edgeBytes.length / 2);
  for (let i = 0; i < edges.length; i++) edges[i] = ev.getUint16(i * 2, true);

  const surfBytes = lump(13), sv = dv(surfBytes);
  const surfedges = new Int32Array(surfBytes.length / 4);
  for (let i = 0; i < surfedges.length; i++) surfedges[i] = sv.getInt32(i * 4, true);

  yield 0.85;
  const modelBytes = lump(14), dm = dv(modelBytes);
  const models: Model[] = [];
  for (let o = 0; o < modelBytes.length; o += 64) {
    const f = (k: number) => dm.getFloat32(o + k * 4, true);
    const n = (k: number) => dm.getInt32(o + 36 + k * 4, true);
    models.push({ mins: [f(0), f(1), f(2)], maxs: [f(3), f(4), f(5)], origin: [f(6), f(7), f(8)], headNodes: [n(0), n(1), n(2), n(3)], visLeafs: n(4), firstFace: n(5), numFaces: n(6) });
  }
  if (models.length === 0) throw new ImportError(`${name} has no models: there is no world in it.`);

  yield 0.9;
  // What the indices point at must exist: a map that passes here can be walked without bounds checks.
  const planeCount = planes.length / 4, vertexCount = vertices.length / 3, edgeCount = edges.length / 2;
  const damaged = (what: string) => new ImportError(`${name} is damaged: ${what}.`);
  for (const f of faces) {
    if (f.plane >= planeCount) throw damaged(`a face names plane ${f.plane} of ${planeCount}`);
    if (f.texinfo >= texinfo.length) throw damaged(`a face names texinfo ${f.texinfo} of ${texinfo.length}`);
    if (f.firstEdge < 0 || f.firstEdge + f.numEdges > surfedges.length) throw damaged(`a face's edges (${f.firstEdge} + ${f.numEdges}) run past the ${surfedges.length} surfedges`);
  }
  for (const e of surfedges) if (Math.abs(e) >= edgeCount) throw damaged(`a surfedge names edge ${e} of ${edgeCount}`);
  for (const v of edges) if (v >= vertexCount) throw damaged(`an edge names vertex ${v} of ${vertexCount}`);
  for (const m of models) {
    if (m.firstFace < 0 || m.numFaces < 0 || m.firstFace + m.numFaces > faces.length) throw damaged(`a model's faces (${m.firstFace} + ${m.numFaces}) run past the ${faces.length} faces`);
  }

  yield 0.95;
  const entities = parseEntities(entityText);
  return {
    entityText,
    entities,
    planes,
    textures: parseTextures(lump(2), name),
    vertices,
    visibility: lump(4),
    nodes,
    texinfo,
    faces,
    lighting: lump(8),
    clipnodes,
    leafContents,
    marksurfaces,
    edges,
    surfedges,
    models,
  };
}

function parseTextures(lump: Uint8Array, name: string): BspTexture[] {
  if (lump.length < 4) return [];
  const view = new DataView(lump.buffer, lump.byteOffset, lump.byteLength);
  const count = view.getUint32(0, true);
  if (4 + count * 4 > lump.length) throw new ImportError(`${name} is damaged: its textures lump lists ${count} textures in ${lump.length} bytes.`);
  const textures: BspTexture[] = [];
  for (let i = 0; i < count; i++) {
    const offset = view.getInt32(4 + i * 4, true);
    // -1: a texture the compiler left out (nothing uses it).
    if (offset < 0 || offset + 40 > lump.length) {
      textures.push({ name: "", width: 0, height: 0, data: null });
      continue;
    }
    const width = view.getUint32(offset + 16, true), height = view.getUint32(offset + 20, true);
    const embedded = view.getUint32(offset + 24, true) !== 0;
    textures.push({ name: fixedString(lump, offset, 16), width, height, data: embedded ? lump.subarray(offset) : null });
  }
  return textures;
}

/** The entity lump: `{ "key" "value" ... }` blocks. Anything that does not parse is skipped. */
export function parseEntities(text: string): Entity[] {
  const entities: Entity[] = [];
  let keys: Record<string, string> | null = null;
  let pendingKey: string | null = null;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "{") {
      keys = {};
      pendingKey = null;
      i++;
    } else if (c === "}") {
      if (keys) entities.push({ classname: keys.classname ?? "", keys });
      keys = null;
      i++;
    } else if (c === '"') {
      const end = text.indexOf('"', i + 1);
      if (end < 0) break;
      const token = text.slice(i + 1, end);
      if (keys) {
        if (pendingKey === null) pendingKey = token;
        else {
          // The first value of a key wins, as in the engine.
          if (!(pendingKey in keys)) keys[pendingKey] = token;
          pendingKey = null;
        }
      }
      i = end + 1;
    } else i++;
  }
  return entities;
}

/** Numbers of a key such as "origin" or "_light"; words that are not numbers are left out. */
export function numbers(value: string | undefined): number[] {
  if (!value) return [];
  return value.trim().split(/\s+/).map(Number).filter((n) => Number.isFinite(n));
}

/** What is at a point of hull 0 of a model (CONTENTS_*), in the model's own space. */
export function pointContents(bsp: Bsp, model: Model, x: number, y: number, z: number): number {
  let node = model.headNodes[0];
  const nodeCount = bsp.nodes.length / 3;
  for (let guard = 0; node >= 0 && guard < 100000; guard++) {
    if (node >= nodeCount) return CONTENTS_SOLID;
    const p = bsp.nodes[node * 3] * 4;
    const d = bsp.planes[p] * x + bsp.planes[p + 1] * y + bsp.planes[p + 2] * z - bsp.planes[p + 3];
    node = bsp.nodes[node * 3 + (d >= 0 ? 1 : 2)];
  }
  const leaf = ~node;
  return leaf >= 0 && leaf < bsp.leafContents.length ? bsp.leafContents[leaf] : CONTENTS_SOLID;
}

/** What is at a point of a clip hull (1: a standing player, 2: a large box, 3: a crouching player). */
export function hullContents(bsp: Bsp, model: Model, hull: 1 | 2 | 3, x: number, y: number, z: number): number {
  let node = model.headNodes[hull];
  const count = bsp.clipnodes.length / 3;
  for (let guard = 0; node >= 0 && guard < 100000; guard++) {
    if (node >= count) return CONTENTS_SOLID;
    const p = bsp.clipnodes[node * 3] * 4;
    const d = bsp.planes[p] * x + bsp.planes[p + 1] * y + bsp.planes[p + 2] * z - bsp.planes[p + 3];
    node = bsp.clipnodes[node * 3 + (d >= 0 ? 1 : 2)];
  }
  return node;
}
