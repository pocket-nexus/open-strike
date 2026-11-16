// A map as the game takes it (docs/MAPS.md). The built-in map is made in code; an imported map (tools/import-bsp.ts)
// is a GLB plus this data. Both give the game the same thing.

export type Vec3 = [number, number, number];

export interface MapSpawn {
  team: "a" | "b" | "any";
  position: Vec3;          // the feet, metres
  yaw: number;             // radians, 0 looks down -Z, positive turns left (counter-clockwise from above)
}

export interface MapLight {
  type: "point" | "spot";
  position: Vec3;
  color: number;           // 0xRRGGBB
  power: number;           // lumens
  target?: Vec3;           // spot
  angle?: number;          // spot: half angle, radians
  radius?: number;         // the lamp's size, metres (soft shadows)
}

export interface MapData {
  id: string;              // [a-z0-9_-]+
  title: string;
  credits?: string;        // who made it, and under what terms
  /** Render geometry: a GLB under the project's assets/ (Y up, metres). A map built in code has none. */
  glb?: string;            // "assets/maps/<id>/map.glb"
  /** What bodies and bullets hit: triangles in the same space, one fixed mesh. */
  collision: { positions: number[]; indices: number[] };
  spawns: MapSpawn[];
  sun?: { azimuth: number; elevation: number; illuminance: number; color?: number };   // degrees, lux (azimuth 0: a sun in the +Z sky, 90: in the +X sky; docs/MAPS.md)
  sky?: "atmosphere" | { color: number; intensity: number };
  lights?: MapLight[];
  exposure?: number;       // EV100, when the map wants a fixed one
  bounds: { min: Vec3; max: Vec3 };
  killY: number;           // a player below it has fallen out of the map
  ladders?: { min: Vec3; max: Vec3 }[];    // volumes a player climbs in
  /** SHA-256 (hex) of the collision data: a room names the map by id and hash, so everyone in it stands on the same floor. */
  hash: string;
}

/** A map built in code: the same data, and a function that adds what is seen to the scene. */
export interface BuiltMap extends MapData {
  build(scene: unknown): void;
}
