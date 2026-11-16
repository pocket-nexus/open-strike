// A minimal binary glTF (GLB) writer and reader: one JSON chunk, one binary buffer of 4-aligned views. The writer is
// plain TypeScript (the game runs it); the reader is for the tools' checks (it uses TextDecoder, which the game's
// runtime lacks).
import { utf8 } from "./bytes.ts";

export type Json = Record<string, any>;

const FLOAT = 5126, UINT16 = 5123, UINT32 = 5125;
const ARRAY_BUFFER = 34962, ELEMENT_ARRAY_BUFFER = 34963;

export class GlbWriter {
  private chunks: Uint8Array[] = [];
  private length = 0;
  readonly views: Json[] = [];
  readonly accessors: Json[] = [];

  view(data: Uint8Array, target?: number): number {
    const pad = (4 - (this.length % 4)) % 4;
    if (pad) {
      this.chunks.push(new Uint8Array(pad));
      this.length += pad;
    }
    const view: Json = { buffer: 0, byteOffset: this.length, byteLength: data.length };
    if (target) view.target = target;
    this.chunks.push(data);
    this.length += data.length;
    this.views.push(view);
    return this.views.length - 1;
  }

  /** Float vertex data (`size` numbers per vertex). Positions carry their bounds, as glTF asks. */
  attribute(data: Float32Array, size: 2 | 3, bounds = false): number {
    const accessor: Json = { bufferView: this.view(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), ARRAY_BUFFER), componentType: FLOAT, count: data.length / size, type: size === 3 ? "VEC3" : "VEC2" };
    if (bounds) {
      const min = new Array(size).fill(Infinity), max = new Array(size).fill(-Infinity);
      for (let i = 0; i < data.length; i++) {
        const k = i % size;
        if (data[i] < min[k]) min[k] = data[i];
        if (data[i] > max[k]) max[k] = data[i];
      }
      accessor.min = min;
      accessor.max = max;
    }
    this.accessors.push(accessor);
    return this.accessors.length - 1;
  }

  /** Triangle indices: 16-bit when the vertices allow it. */
  indices(data: Uint32Array, vertexCount: number): number {
    const small = vertexCount <= 65535;
    const typed = small ? Uint16Array.from(data) : data;
    this.accessors.push({ bufferView: this.view(new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength), ELEMENT_ARRAY_BUFFER), componentType: small ? UINT16 : UINT32, count: data.length, type: "SCALAR" });
    return this.accessors.length - 1;
  }

  /** The file: `doc` gets the buffer, its views and accessors. */
  finish(doc: Json): Uint8Array {
    const g = this.finishSteps(doc);
    for (;;) {
      const r = g.next();
      if (r.done) return r.value;
    }
  }

  /** `finish` in a few steps (yields between them). */
  *finishSteps(doc: Json): Generator<void, Uint8Array> {
    const binPad = (4 - (this.length % 4)) % 4;
    const binLength = this.length + binPad;
    const full = { ...doc, accessors: this.accessors, bufferViews: this.views, buffers: [{ byteLength: binLength }] };
    const text = JSON.stringify(full);
    yield;
    let json = utf8(text);
    yield;
    if (json.length % 4) {
      const padded = new Uint8Array(json.length + 4 - (json.length % 4)).fill(0x20);
      padded.set(json);
      json = padded;
    }
    const total = 12 + 8 + json.length + 8 + binLength;
    const out = new Uint8Array(total);
    const view = new DataView(out.buffer);
    view.setUint32(0, 0x46546c67, true);
    view.setUint32(4, 2, true);
    view.setUint32(8, total, true);
    view.setUint32(12, json.length, true);
    view.setUint32(16, 0x4e4f534a, true);
    out.set(json, 20);
    let at = 20 + json.length;
    view.setUint32(at, binLength, true);
    view.setUint32(at + 4, 0x004e4942, true);
    at += 8;
    for (const [k, c] of this.chunks.entries()) {
      out.set(c, at);
      at += c.length;
      if (k % 256 === 255) yield;
    }
    return out;
  }
}

/** Splits a GLB into its JSON and its binary buffer; throws when the container is not sound. */
export function parseGlb(bytes: Uint8Array): { json: Json; bin: Uint8Array } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 20 || view.getUint32(0, true) !== 0x46546c67) throw new Error("glb: not a GLB");
  if (view.getUint32(4, true) !== 2) throw new Error("glb: not version 2");
  if (view.getUint32(8, true) !== bytes.length) throw new Error(`glb: header says ${view.getUint32(8, true)} bytes, the file is ${bytes.length}`);
  const jsonLength = view.getUint32(12, true);
  if (view.getUint32(16, true) !== 0x4e4f534a || 20 + jsonLength > bytes.length) throw new Error("glb: no JSON chunk");
  const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength)));
  let bin: Uint8Array = new Uint8Array(0);
  const at = 20 + jsonLength;
  if (at + 8 <= bytes.length) {
    const binLength = view.getUint32(at, true);
    if (view.getUint32(at + 4, true) !== 0x004e4942 || at + 8 + binLength > bytes.length) throw new Error("glb: bad binary chunk");
    bin = bytes.subarray(at + 8, at + 8 + binLength);
  }
  return { json, bin };
}
