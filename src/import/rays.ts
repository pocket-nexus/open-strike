// Rays against a triangle list: what the importer uses to put spawns on the floor and to check its own output. Brute
// force (a few hundred rays a map).

export interface TriangleMesh {
  positions: ArrayLike<number>;
  indices: ArrayLike<number>;
}

export interface RayHit {
  /** Distance along the ray. */
  t: number;
  /** Index of the triangle's first index in `indices`. */
  triangle: number;
}

/** The nearest triangle a ray meets within `maxT` (either side of the triangle counts), or null. */
export function raycast(mesh: TriangleMesh, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxT = Infinity): RayHit | null {
  const { positions: p, indices } = mesh;
  let best: RayHit | null = null;
  for (let i = 0; i + 2 < indices.length; i += 3) {
    const t = rayTriangle(p, indices[i]! * 3, indices[i + 1]! * 3, indices[i + 2]! * 3, ox, oy, oz, dx, dy, dz);
    if (t === null || t > maxT) continue;
    if (!best || t < best.t) best = { t, triangle: i };
  }
  return best;
}

/** Height of the first surface straight below a point, within `maxDrop`; null when there is none. */
export function floorBelow(mesh: TriangleMesh, x: number, y: number, z: number, maxDrop: number): number | null {
  const hit = raycast(mesh, x, y, z, 0, -1, 0, maxDrop);
  return hit ? y - hit.t : null;
}

/**
 * `floorBelow` for many points in one pass over the triangles, a slice at a time (yields the fraction done). The same
 * test as `raycast` straight down, on the triangles whose extent across X and Z holds the point, so the answers are
 * `floorBelow`'s.
 */
export function* floorsBelow(mesh: TriangleMesh, points: readonly (readonly [number, number, number])[], maxDrop: number): Generator<number, (number | null)[]> {
  const { positions: p, indices } = mesh;
  const best = points.map(() => Infinity);
  const margin = 1e-3;
  for (let i = 0, n = 0; i + 2 < indices.length; i += 3, n++) {
    if (n === 4000) { n = 0; yield i / indices.length; }
    const a = indices[i]! * 3, b = indices[i + 1]! * 3, c = indices[i + 2]! * 3;
    const minX = Math.min(p[a]!, p[b]!, p[c]!) - margin, maxX = Math.max(p[a]!, p[b]!, p[c]!) + margin;
    const minZ = Math.min(p[a + 2]!, p[b + 2]!, p[c + 2]!) - margin, maxZ = Math.max(p[a + 2]!, p[b + 2]!, p[c + 2]!) + margin;
    for (let k = 0; k < points.length; k++) {
      const q = points[k]!;
      if (q[0] < minX || q[0] > maxX || q[2] < minZ || q[2] > maxZ) continue;
      const t = rayTriangle(p, a, b, c, q[0], q[1], q[2], 0, -1, 0);
      if (t !== null && t <= maxDrop && t < best[k]!) best[k] = t;
    }
  }
  return points.map((q, k) => (best[k] === Infinity ? null : q[1] - best[k]!));
}

/** Where a ray meets one triangle (corners at `a`, `b`, `c` in `p`, either side), or null: `raycast`'s test. */
function rayTriangle(p: ArrayLike<number>, a: number, b: number, c: number, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number): number | null {
  const e1x = p[b]! - p[a]!, e1y = p[b + 1]! - p[a + 1]!, e1z = p[b + 2]! - p[a + 2]!;
  const e2x = p[c]! - p[a]!, e2y = p[c + 1]! - p[a + 1]!, e2z = p[c + 2]! - p[a + 2]!;
  const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (Math.abs(det) < 1e-12) return null;
  const inv = 1 / det;
  const tx = ox - p[a]!, ty = oy - p[a + 1]!, tz = oz - p[a + 2]!;
  const u = (tx * px + ty * py + tz * pz) * inv;
  if (u < -1e-6 || u > 1 + 1e-6) return null;
  const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
  const v = (dx * qx + dy * qy + dz * qz) * inv;
  if (v < -1e-6 || u + v > 1 + 1e-6) return null;
  const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
  return t < 0 ? null : t;
}
