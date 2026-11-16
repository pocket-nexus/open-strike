// Checks an imported map the way a reader of its files would: the GLB is parsed back (accessors, bounds, indices,
// every image decoded), the collision data is checked against its hash and its bounds, and every spawn is tested with
// rays: a floor under the feet, room for a body, and the drawn floor where the collision floor is.
import type { MapData } from "../../src/maps/types.ts";
import { parseGlb } from "../../src/import/glb.ts";
import { collisionHash } from "./hash.ts";
import { decodePng } from "./png.ts";
import { raycast } from "../../src/import/rays.ts";

export interface Verified {
  problems: string[];
  glb: { primitives: number; vertices: number; triangles: number; materials: number; images: number; imageBytes: number; min: number[]; max: number[] };
  spawns: { checked: number; maxFloorGap: number; maxDrawnGap: number; blocked: number };
}

const COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
const BYTES: Record<number, number> = { 5121: 1, 5123: 2, 5125: 4, 5126: 4 };

export function verifyMap(map: MapData, glbBytes: Uint8Array): Verified {
  const problems: string[] = [];
  const out: Verified = { problems, glb: { primitives: 0, vertices: 0, triangles: 0, materials: 0, images: 0, imageBytes: 0, min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] }, spawns: { checked: 0, maxFloorGap: 0, maxDrawnGap: 0, blocked: 0 } };

  // ---------------------------------------------------------------------------------------------- the GLB
  const drawn = { positions: [] as number[], indices: [] as number[] };
  try {
    const { json, bin } = parseGlb(glbBytes);
    if (json.buffers?.[0]?.byteLength !== bin.length && (json.accessors?.length ?? 0) > 0) problems.push(`glb: buffer is ${bin.length} bytes, the JSON says ${json.buffers?.[0]?.byteLength}`);
    const read = (index: number, what: string): { data: Float32Array | Uint16Array | Uint32Array; size: number; count: number } | null => {
      const a = json.accessors?.[index];
      const v = a && json.bufferViews?.[a.bufferView];
      const size = a && COMPONENTS[a.type], bytes = a && BYTES[a.componentType];
      if (!a || !v || !size || !bytes) {
        problems.push(`glb: ${what} has no usable accessor`);
        return null;
      }
      const start = (v.byteOffset ?? 0) + (a.byteOffset ?? 0), length = a.count * size * bytes;
      if (start % bytes !== 0 || start + length > bin.length || (a.byteOffset ?? 0) + length > v.byteLength) {
        problems.push(`glb: ${what} runs outside its buffer view`);
        return null;
      }
      const copy = bin.slice(start, start + length);
      const data = a.componentType === 5126 ? new Float32Array(copy.buffer) : a.componentType === 5123 ? new Uint16Array(copy.buffer) : a.componentType === 5125 ? new Uint32Array(copy.buffer) : null;
      if (!data) {
        problems.push(`glb: ${what} has component type ${a.componentType}`);
        return null;
      }
      return { data, size, count: a.count };
    };
    const images: { width: number; height: number }[] = [];
    for (const [i, img] of (json.images ?? []).entries()) {
      const v = json.bufferViews?.[img.bufferView];
      if (!v || v.byteOffset + v.byteLength > bin.length) {
        problems.push(`glb: image ${i} (${img.name}) has no data`);
        continue;
      }
      try {
        const png = decodePng(bin.subarray(v.byteOffset, v.byteOffset + v.byteLength));
        images.push(png);
        out.glb.imageBytes += v.byteLength;
      } catch (e) {
        problems.push(`glb: image ${i} (${img.name}) does not decode: ${(e as Error).message}`);
      }
    }
    out.glb.images = images.length;
    out.glb.materials = json.materials?.length ?? 0;
    for (const [i, m] of (json.materials ?? []).entries()) {
      for (const ref of [m.pbrMetallicRoughness?.baseColorTexture, m.emissiveTexture]) {
        if (ref && !(json.images ?? [])[json.textures?.[ref.index]?.source]) problems.push(`glb: material ${i} (${m.name}) names a texture that is not there`);
      }
    }
    for (const mesh of json.meshes ?? []) {
      for (const [pi, prim] of mesh.primitives.entries()) {
        const what = `primitive ${pi}`;
        const pos = read(prim.attributes.POSITION, `${what} POSITION`);
        const nor = read(prim.attributes.NORMAL, `${what} NORMAL`);
        const uv = read(prim.attributes.TEXCOORD_0, `${what} TEXCOORD_0`);
        const idx = read(prim.indices, `${what} indices`);
        if (!pos || !nor || !uv || !idx) continue;
        out.glb.primitives++;
        out.glb.vertices += pos.count;
        out.glb.triangles += idx.count / 3;
        if (nor.count !== pos.count || uv.count !== pos.count) problems.push(`glb: ${what} has ${pos.count} positions, ${nor.count} normals, ${uv.count} texture coordinates`);
        if (idx.count % 3 !== 0) problems.push(`glb: ${what} has ${idx.count} indices: not triangles`);
        if (!json.materials?.[prim.material]) problems.push(`glb: ${what} names material ${prim.material}`);
        const a = json.accessors[prim.attributes.POSITION];
        const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
        let finite = true;
        for (let k = 0; k < pos.data.length; k++) {
          const v = pos.data[k];
          if (!Number.isFinite(v)) finite = false;
          lo[k % 3] = Math.min(lo[k % 3], v);
          hi[k % 3] = Math.max(hi[k % 3], v);
        }
        for (let k = 0; k < 3; k++) {
          if (a.min?.[k] !== lo[k] || a.max?.[k] !== hi[k]) problems.push(`glb: ${what} POSITION bounds are not those of its data`);
          out.glb.min[k] = Math.min(out.glb.min[k], lo[k]);
          out.glb.max[k] = Math.max(out.glb.max[k], hi[k]);
        }
        for (let k = 0; k < nor.data.length; k += 3) {
          const l = Math.hypot(nor.data[k], nor.data[k + 1], nor.data[k + 2]);
          if (!(Math.abs(l - 1) < 1e-3)) {
            problems.push(`glb: ${what} has a normal of length ${l}`);
            break;
          }
        }
        for (let k = 0; k < uv.data.length; k++) if (!Number.isFinite(uv.data[k])) finite = false;
        if (!finite) problems.push(`glb: ${what} has numbers that are not finite`);
        const base = drawn.positions.length / 3;
        let badIndex = false, backwards = 0;
        for (let k = 0; k < idx.data.length; k++) if (idx.data[k] >= pos.count) badIndex = true;
        if (badIndex) {
          problems.push(`glb: ${what} has an index past its ${pos.count} vertices`);
          continue;
        }
        // Triangles are counter-clockwise seen from where their normal points.
        for (let k = 0; k + 2 < idx.data.length; k += 3) {
          const i = idx.data[k] * 3, j = idx.data[k + 1] * 3, l = idx.data[k + 2] * 3, p = pos.data;
          const ux = p[j] - p[i], uy = p[j + 1] - p[i + 1], uz = p[j + 2] - p[i + 2], vx = p[l] - p[i], vy = p[l + 1] - p[i + 1], vz = p[l + 2] - p[i + 2];
          if ((uy * vz - uz * vy) * nor.data[i] + (uz * vx - ux * vz) * nor.data[i + 1] + (ux * vy - uy * vx) * nor.data[i + 2] <= 0) backwards++;
        }
        if (backwards) problems.push(`glb: ${what} has ${backwards} triangle(s) wound against their normal`);
        for (let k = 0; k < pos.data.length; k++) drawn.positions.push(pos.data[k]);
        for (let k = 0; k < idx.data.length; k++) drawn.indices.push(base + idx.data[k]);
      }
    }
  } catch (e) {
    problems.push((e as Error).message);
  }

  // ---------------------------------------------------------------------------------------------- collision
  const { positions, indices } = map.collision;
  if (positions.length % 3 !== 0 || indices.length % 3 !== 0) problems.push("collision: positions or indices are not in threes");
  const vertexCount = positions.length / 3;
  for (let i = 0; i < indices.length; i++) {
    if (!Number.isInteger(indices[i]) || indices[i] < 0 || indices[i] >= vertexCount) {
      problems.push(`collision: index ${indices[i]} of ${vertexCount} vertices`);
      break;
    }
  }
  for (let i = 0; i < positions.length; i++) {
    const k = i % 3;
    if (!Number.isFinite(positions[i]) || positions[i] < map.bounds.min[k] || positions[i] > map.bounds.max[k]) {
      problems.push("collision: a position is outside the map's bounds");
      break;
    }
  }
  if (collisionHash(map.collision) !== map.hash) problems.push("collision: the hash is not that of the data");
  if (!(map.killY < map.bounds.min[1])) problems.push("killY is not below the map");

  // ---------------------------------------------------------------------------------------------- spawns
  for (const [i, s] of map.spawns.entries()) {
    const [x, y, z] = s.position;
    out.spawns.checked++;
    // A floor right under the feet.
    const floor = raycast(map.collision, x, y + 0.5, z, 0, -1, 0, 3);
    if (!floor) {
      problems.push(`spawn ${i}: no floor under it`);
      continue;
    }
    const gap = floor.t - 0.5;
    out.spawns.maxFloorGap = Math.max(out.spawns.maxFloorGap, Math.abs(gap));
    if (Math.abs(gap) > 0.05) problems.push(`spawn ${i}: the floor is ${(gap * 100).toFixed(1)} cm below the feet`);
    // Room for a body: 1.8 m of headroom, and no wall within 0.3 m at knee, waist and shoulder height.
    let blocked = !!raycast(map.collision, x, y + 0.3, z, 0, 1, 0, 1.5);
    for (const h of [0.5, 0.9, 1.5]) {
      for (let k = 0; k < 8 && !blocked; k++) {
        const a = (k * Math.PI) / 4;
        if (raycast(map.collision, x, y + h, z, Math.cos(a), 0, Math.sin(a), 0.3)) blocked = true;
      }
    }
    if (blocked) {
      out.spawns.blocked++;
      problems.push(`spawn ${i}: something solid is where the body would be`);
    }
    // What is drawn under the spawn is where the collision floor is.
    const seen = raycast(drawn, x, y + 0.5, z, 0, -1, 0, 3);
    if (seen) {
      out.spawns.maxDrawnGap = Math.max(out.spawns.maxDrawnGap, Math.abs(seen.t - floor.t));
      if (Math.abs(seen.t - floor.t) > 0.02) problems.push(`spawn ${i}: the drawn floor is ${((seen.t - floor.t) * 100).toFixed(1)} cm from the collision floor`);
    }
  }
  return out;
}
