// A map's hash (docs/MAPS.md § The hash): SHA-256, in lower-case hex, over its collision data. The game recomputes
// it with its own SHA-256 (src/maps/hash.ts, plain TypeScript: its runtime has no crypto) over the same bytes.
import { createHash } from "node:crypto";

/**
 * The bytes that are hashed: every position as a little-endian IEEE 754 float32 (the JSON number rounded to the
 * nearest float32), in order, then every index as a little-endian uint32, in order. No header, no padding.
 */
export function collisionBytes(collision: { positions: ArrayLike<number>; indices: ArrayLike<number> }): Uint8Array {
  const { positions, indices } = collision;
  const bytes = new Uint8Array(positions.length * 4 + indices.length * 4);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < positions.length; i++) view.setFloat32(i * 4, positions[i], true);
  const base = positions.length * 4;
  for (let i = 0; i < indices.length; i++) view.setUint32(base + i * 4, indices[i], true);
  return bytes;
}

/** `MapData.hash` of collision data. */
export function collisionHash(collision: { positions: ArrayLike<number>; indices: ArrayLike<number> }): string {
  return createHash("sha256").update(collisionBytes(collision)).digest("hex");
}
