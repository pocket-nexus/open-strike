// Foundry: the game's own map, made in code. Two team bays (west: Ember's, painted orange; east: Azure's, painted
// blue), mirrored across x = 0, and three lanes between them:
//
//   z -24 … -9   the Yard     open and sunlit: containers, a loading dock with ramps (height), barriers
//   z  -8 …  6   the Hall     the foundry itself: dim, lit by its high-bay lamps, by the furnace's glow and by the sun
//                             coming down through four skylights onto a polished floor
//   z   7 … 22   the Gantry   a catwalk 3 m up along the hall's south wall (stairs at both ends, a ladder in the
//                             middle, windows into the hall), a service passage under it, an alley beside it
//
// Metres, Y up. The yard and the alley open into the hall through doors in its long walls; each bay opens onto all
// three lanes. Everything is boxes, prisms and cylinders (builder.ts): drawn with world-mapped CC0 textures
// (assets/CREDITS.md), and collided with as one triangle list, whose hash names this version of the map.
import {
  BoxGeometry, CylinderGeometry, DataTexture, Mesh, MeshStandardMaterial, PlaneGeometry, SurfaceMaterial, Texture, type Object3D,
} from "@threert/scene";
import { MapBuilder } from "./builder.ts";
import { collisionHash } from "./hash.ts";
import type { BuiltMap, MapLight, MapSpawn, Vec3 } from "./types.ts";

/** The lanes' half length, the bays' depth beyond it, and where the lanes' walls stand. */
const LX = 24, BX = 32;
const YARD_N = -24, HALL_N = -8, HALL_S = 6, ALLEY_S = 22;
const BAY_N = -16, BAY_S = 14;
const HALL_H = 8, BAY_H = 4.5, WALL_H = 6;
/** The gantry: its deck's top, its south edge. */
const DECK = 3, DECK_S = 11, DECK_X = 12;
const DOCK_H = 1.2;

type Rect = [a0: number, a1: number, y0: number, y1: number];

/** A wall along x (from x0 to x1, between z0 and z1) with openings cut out. */
function wallX(b: MapBuilder, z0: number, z1: number, x0: number, x1: number, y0: number, y1: number, holes: Rect[], material: string): void {
  let at = x0;
  for (const [h0, h1, hy0, hy1] of [...holes].sort((p, q) => p[0] - q[0])) {
    if (h0 > at) b.box([at, y0, z0], [h0, y1, z1], material);
    if (hy0 > y0) b.box([h0, y0, z0], [h1, hy0, z1], material);
    if (hy1 < y1) b.box([h0, hy1, z0], [h1, y1, z1], material);
    at = h1;
  }
  if (at < x1) b.box([at, y0, z0], [x1, y1, z1], material);
}

/** A wall along z (from z0 to z1, between x0 and x1) with openings cut out. */
function wallZ(b: MapBuilder, x0: number, x1: number, z0: number, z1: number, y0: number, y1: number, holes: Rect[], material: string): void {
  let at = z0;
  for (const [h0, h1, hy0, hy1] of [...holes].sort((p, q) => p[0] - q[0])) {
    if (h0 > at) b.box([x0, y0, at], [x1, y1, h0], material);
    if (hy0 > y0) b.box([x0, y0, h0], [x1, hy0, h1], material);
    if (hy1 < y1) b.box([x0, hy1, h0], [x1, y1, h1], material);
    at = h1;
  }
  if (at < z1) b.box([x0, y0, at], [x1, y1, z1], material);
}

/** A slab from (x0, z0) to (x1, z1) with rectangular openings [x0, x1, z0, z1]. */
function slab(b: MapBuilder, x0: number, x1: number, z0: number, z1: number, y0: number, y1: number, holes: [number, number, number, number][], material: string): void {
  const xs = [...new Set([x0, x1, ...holes.flatMap((h) => [h[0], h[1]])])].sort((p, q) => p - q);
  for (let i = 0; i + 1 < xs.length; i++) {
    const a = xs[i]!, c = xs[i + 1]!, mid = (a + c) / 2;
    const cuts = holes.filter((h) => mid > h[0] && mid < h[1]).sort((p, q) => p[2] - q[2]);
    let at = z0;
    for (const h of cuts) {
      if (h[2] > at) b.box([a, y0, at], [c, y1, h[2]], material);
      at = h[3];
    }
    if (at < z1) b.box([a, y0, at], [c, y1, z1], material);
  }
}

/** A crate: a box with steel edges (drawn only), so it reads as a thing and not as a block. */
function crate(b: MapBuilder, a: Vec3, c: Vec3, material: string): void {
  b.box(a, c, material);
  const t = 0.05, o = 0.012;
  const [x0, y0, z0] = a, [x1, y1, z1] = c;
  for (const y of [y0, y1 - t]) {
    b.box([x0 - o, y, z0 - o], [x1 + o, y + t, z0 + t], "steel", { ghost: true });
    b.box([x0 - o, y, z1 - t], [x1 + o, y + t, z1 + o], "steel", { ghost: true });
    b.box([x0 - o, y, z0 + t], [x0 + t, y + t, z1 - t], "steel", { ghost: true });
    b.box([x1 - t, y, z0 + t], [x1 + o, y + t, z1 - t], "steel", { ghost: true });
  }
  for (const [x, z] of [[x0 - o, z0 - o], [x1 - t + o, z0 - o], [x0 - o, z1 - t + o], [x1 - t + o, z1 - t + o]] as const) b.box([x, y0 + t, z], [x + t, y1 - t, z + t], "steel", { ghost: true });
  // A lid line.
  b.box([x0 - o, y0 + (y1 - y0) * 0.72, z0 - o], [x1 + o, y0 + (y1 - y0) * 0.72 + 0.025, z1 + o], "steel", { ghost: true });
}

/** The skylights of the hall's roof: [x0, x1, z0, z1]. The sun comes down through them. */
const SKYLIGHTS: [number, number, number, number][] = [[-19, -14, -6.5, -2.5], [-10, -5, -1.5, 3], [5, 10, -6.5, -2.5], [14, 19, -1.5, 3]];
/** The hall's high-bay lamps (x, z), hung at 6.4 m. */
const HIGH_BAYS: [number, number][] = [[-18, 2.5], [-11, -5], [-3.5, 3.6], [3.5, -5.6], [11, 2.5], [18, -5]];
const LADDER = { min: [-0.5, 0, DECK_S + 0.02] as Vec3, max: [0.5, DECK + 0.2, DECK_S + 0.65] as Vec3 };

function geometry(): MapBuilder {
  const b = new MapBuilder();
  // ---- ground ----
  b.box([-LX, -0.5, YARD_N], [LX, 0, HALL_N - 1], "asphalt");
  b.box([-LX, -0.5, HALL_N - 1], [LX, 0, HALL_S + 1], "floor");
  b.box([-LX, -0.5, HALL_S + 1], [LX, 0, ALLEY_S], "pavement");

  // ---- the hall's shell ----
  // North wall: a door to the yard in each half.
  wallX(b, HALL_N - 1, HALL_N, -LX, LX, 0, HALL_H, [[-14, -10, 0, 3.3], [10, 14, 0, 3.3]], "cladding");
  // South wall: a door to the passage under the gantry in each half, and above them the gantry's windows into the hall.
  const SILL = DECK + 1.05;
  wallX(b, HALL_S, HALL_S + 1, -LX, LX, 0, SILL, [[-8, -5, 0, 3], [5, 8, 0, 3]], "cladding");
  wallX(b, HALL_S, HALL_S + 1, -LX, LX, SILL, HALL_H, [[-10.5, -2, SILL, DECK + 2.7], [2, 10.5, SILL, DECK + 2.7]], "cladding");
  slab(b, -LX - 0.5, LX + 0.5, HALL_N - 1, HALL_S + 1, HALL_H, HALL_H + 0.3, SKYLIGHTS, "roof");
  // (The frames of the skylights: upstands on the roof, seen from the yard's dock and from below as dark edges.)
  for (const [x0, x1, z0, z1] of SKYLIGHTS) {
    b.box([x0 - 0.15, HALL_H - 0.12, z0 - 0.15], [x1 + 0.15, HALL_H, z0], "steel", { ghost: true });
    b.box([x0 - 0.15, HALL_H - 0.12, z1], [x1 + 0.15, HALL_H, z1 + 0.15], "steel", { ghost: true });
    b.box([x0 - 0.15, HALL_H - 0.12, z0], [x0, HALL_H, z1], "steel", { ghost: true });
    b.box([x1, HALL_H - 0.12, z0], [x1 + 0.15, HALL_H, z1], "steel", { ghost: true });
  }
  // Roof trusses across the hall (drawn only).
  for (const x of [-21, -12, -2.6, 2.6, 12, 21]) b.box([x - 0.12, HALL_H - 0.55, HALL_N], [x + 0.12, HALL_H - 0.12, HALL_S], "steel", { ghost: true });

  // ---- the furnace, in the middle of the hall: it breaks the long sight line ----
  b.box([-2.4, 0, -4.4], [2.4, 4.6, 0], "furnace");
  b.box([-2.7, 0, -4.7], [2.7, 0.5, 0.3], "steel");
  b.cylinder([0, 4.6, -2.2], 1.1, HALL_H - 4.6, "furnace", { sides: 14 });
  b.box([-2.5, 4.3, -4.5], [2.5, 4.6, 0.1], "steel", { ghost: true });
  // The mould bed the channel runs to.
  b.box([-1.5, 0, 3.2], [1.5, 0.55, 4.9], "steel");
  // Painted lines on the hall's floor: the walkways along its walls, the keep-clear box around the furnace.
  for (const z of [HALL_N + 1.3, HALL_S - 1.3]) b.box([-LX + 1, 0, z - 0.06], [LX - 1, 0.004, z + 0.06], "line", { ghost: true });
  for (const [x0, z0, x1, z1] of [[-3.6, -5.6, 3.6, -5.48], [-3.6, 5.48, 3.6, 5.6], [-3.6, -5.6, -3.48, 5.6], [3.48, -5.6, 3.6, 5.6]] as const) b.box([x0, 0, z0], [x1, 0.004, z1], "line", { ghost: true });
  // ---- cover in the hall (mirrored) ----
  for (const s of [-1, 1]) {
    const X = (x0: number, x1: number): [number, number] => (s < 0 ? [x0, x1] : [-x1, -x0]);
    const bx = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, m: string | null, o = {}) => { const [a, c] = X(x0, x1); b.box([a, y0, z0], [c, y1, z1], m, o); };
    // Columns.
    bx(-7.4, -6.6, 0, HALL_H, -4.4, -3.6, "column");
    bx(-15.4, -14.6, 0, HALL_H, 0.6, 1.4, "column");
    bx(-7.4, -6.6, 0, HALL_H, 2.2, 3.0, "column");
    // A press: a machine block with a hazard-striped plinth.
    bx(-13.2, -10.2, 0, 0.35, 2.6, 5.4, "hazard");
    bx(-13, -10.4, 0.35, 2.7, 2.8, 5.2, "machine");
    bx(-12.4, -11, 2.7, 3.5, 3.4, 4.6, "steel");
    // Crates.
    { const [a, c] = X(-19.6, -18.4); crate(b, [a, 0, -6.6], [c, 1.2, -5.4], "crate"); }
    { const [a, c] = X(-18.3, -17.1); crate(b, [a, 0, -6.4], [c, 1.2, -5.2], "crate2"); }
    { const [a, c] = X(-19.3, -18.1); crate(b, [a, 1.2, -6.3], [c, 2.3, -5.2], "crate2"); }
    { const [a, c] = X(-5.6, -4.4); crate(b, [a, 0, -6.9], [c, 1.2, -5.7], "crate"); }
    { const [a, c] = X(-20.5, -19.3); crate(b, [a, 0, 3.6], [c, 1.2, 4.8], "crate2"); }
    // Ingot stacks: low cover (one block to hit; drawn as three layers of bars on a pallet).
    for (const [x0, x1, z0, z1] of [[-10.6, -8.6, -2.2, -1.2], [-16.6, -15.2, -3.4, -2.6]] as const) {
      bx(x0, x1, 0, 0.9, z0, z1, null);
      bx(x0 - 0.04, x1 + 0.04, 0, 0.12, z0 - 0.04, z1 + 0.04, "crate2", { ghost: true });
      for (let layer = 0; layer < 3; layer++) {
        const n = Math.round((x1 - x0) / 0.34);
        for (let i = 0; i < n; i++) bx(x0 + (i * (x1 - x0)) / n + 0.03, x0 + ((i + 1) * (x1 - x0)) / n - 0.03, 0.14 + layer * 0.255, 0.36 + layer * 0.255, z0 + 0.03 + (layer % 2) * 0.04, z1 - 0.03 - (layer % 2) * 0.04, "ingot", { ghost: true });
      }
    }

    // ---- the bay (the team's base): a painted room that opens onto the three lanes ----
    const paint = s < 0 ? "paint_a" : "paint_b";
    const wz = (x0: number, x1: number, z0: number, z1: number, y0: number, y1: number, holes: Rect[], m: string) => { const [a, c] = X(x0, x1); wallZ(b, a, c, z0, z1, y0, y1, holes, m); };
    bx(-BX - 0.5, -LX, -0.5, 0, BAY_N - 0.5, BAY_S + 0.5, "bayfloor");
    wz(-BX - 0.5, -BX, BAY_N - 0.5, BAY_S + 0.5, 0, BAY_H + 0.3, [], paint);
    bx(-BX, -LX, 0, BAY_H + 0.3, BAY_N - 0.5, BAY_N, paint);
    bx(-BX, -LX, 0, BAY_H + 0.3, BAY_S, BAY_S + 0.5, paint);
    // The wall between the bay and the lanes: doors to the yard, the hall (a wide one) and the gantry's stairs.
    wz(-LX - 0.5, -LX, BAY_N, BAY_S, 0, BAY_H + 0.3, [[-15, -11, 0, 3.1], [-3.2, 1.2, 0, 3.5], [8.6, 11.6, 0, 3.1]], paint);
    bx(-BX - 0.5, -LX, BAY_H, BAY_H + 0.3, BAY_N - 0.5, BAY_S + 0.5, "roof");
    // Inside: lockers along the back wall and a bench block, so spawns are not in one line of sight from a door.
    bx(-BX, -31.3, 0, 2.1, -9, -3, "machine");
    bx(-BX, -31.3, 0, 2.1, 3, 8, "machine");
    { const [a, c] = X(-27.6, -26.8); crate(b, [a, 0, -8.6], [c, 1.1, -5.4], "crate"); }
    { const [a, c] = X(-27.6, -26.8); crate(b, [a, 0, 3.6], [c, 1.1, 6.8], "crate2"); }
    // Above the bay's roof the hall's end wall goes on up; the yard and the alley are closed by perimeter walls.
    bx(-LX - 0.5, -LX, BAY_H + 0.3, HALL_H + 0.3, HALL_N - 1, HALL_S + 1, "cladding");
    bx(-LX - 0.5, -LX, 0, WALL_H, YARD_N - 0.5, BAY_N - 0.5, "concrete");
    bx(-LX - 0.5, -LX, 0, WALL_H, BAY_S + 0.5, ALLEY_S + 0.5, "concrete");
    bx(-LX, 0, 0, WALL_H, YARD_N - 0.5, YARD_N, "concrete");
    bx(-LX, 0, 0, WALL_H, ALLEY_S, ALLEY_S + 0.5, "concrete");

    // ---- the yard ----
    // A container along the north wall, one across the hall's door (cover for whoever comes out of it), barriers.
    bx(-17.5, -11.4, 0, 2.6, -22.6, -20.2, "container_y");
    bx(-9.4, -7, 0, 2.6, -15.1, -9, "container_w");
    bx(-20.5, -18, 0, 0.9, -13.3, -12.7, "barrier");
    bx(-15.5, -13, 0, 0.9, -17.3, -16.7, "barrier");
    { const [a, c] = X(-5.2, -4); crate(b, [a, 0, -12.2], [c, 1.2, -11], "crate"); }
    // The dock's ramp (rising toward the middle) and the crates on the dock.
    {
      const [a, c] = X(-10.5, -6);
      const lo = s < 0 ? a : c, hi = s < 0 ? c : a;
      b.prism("z", [[lo, 0], [hi, 0], [hi, DOCK_H]], YARD_N, -19, "concrete");
    }
    { const [a, c] = X(-4.6, -3.4); crate(b, [a, DOCK_H, -21.4], [c, DOCK_H + 1.2, -20.2], "crate2"); }

    // ---- the gantry's side ----
    // Stairs from the bay's door up to the deck: steps to look at, a ramp to walk on.
    const steps = 12;
    for (let i = 0; i < steps; i++) {
      const x0 = -20 + (8 * i) / steps;
      bx(x0, -DECK_X, (DECK * i) / steps, (DECK * (i + 1)) / steps, HALL_S + 1, 10.5, "plate", { ghost: true });
    }
    {
      const [a, c] = X(-20, -DECK_X);
      const lo = s < 0 ? a : c, hi = s < 0 ? c : a;
      b.prism("z", [[lo, 0], [hi, 0], [hi, DECK]], HALL_S + 1, 10.5, null);
    }
    // The deck's posts, and cover in the alley: a tank, a low wall, crates.
    for (const x of [-11.8, -6]) bx(x - 0.15, x + 0.15, 0, DECK - 0.15, DECK_S - 0.3, DECK_S, "steel");
    b.cylinder([s * 8.5, 0, 17.5], 1.6, 3.2, "tank", { sides: 18 });
    bx(-16, -12.5, 0, 1.0, 15, 15.5, "barrier");
    { const [a, c] = X(-20.2, -19); crate(b, [a, 0, 19.4], [c, 1.2, 20.6], "crate"); }
    { const [a, c] = X(-3.6, -2.4); crate(b, [a, 0, 13.4], [c, 1.2, 14.6], "crate2"); }
    // Pipes along the alley's wall and under the deck (drawn only).
    b.pipe([s * 0.2, 4.2, ALLEY_S - 0.25], [s * LX, 4.2, ALLEY_S - 0.25], 0.16, "pipe");
    b.pipe([s * 0.2, 4.7, ALLEY_S - 0.25], [s * LX, 4.7, ALLEY_S - 0.25], 0.1, "pipe2");
    b.pipe([s * 0.2, DECK - 0.4, HALL_S + 1.25], [s * DECK_X, DECK - 0.4, HALL_S + 1.25], 0.12, "pipe2");
    // The deck's railing on its open side, with a gap at the ladder: rails to look at, a thin low wall to lean on.
    b.box([s * 0.62, DECK, DECK_S - 0.05], [s * DECK_X, DECK + 1.0, DECK_S], null);
    b.pipe([s * 0.62, DECK + 1.0, DECK_S - 0.03], [s * DECK_X, DECK + 1.0, DECK_S - 0.03], 0.03, "steel", 6);
    b.pipe([s * 0.62, DECK + 0.5, DECK_S - 0.03], [s * DECK_X, DECK + 0.5, DECK_S - 0.03], 0.02, "steel", 6);
    for (let x = 0.62; x <= DECK_X; x += 1.42) b.pipe([s * x, DECK, DECK_S - 0.03], [s * x, DECK + 1.0, DECK_S - 0.03], 0.025, "steel", 6);
    // A kick plate along the hall's side of the stairs' top, so the deck's end is closed toward the bay.
    b.box([s * DECK_X, DECK, 10.5], [s * (DECK_X + 0.05), DECK + 1.0, DECK_S], null);
  }
  // ---- the middle of the yard: the dock, and two containers that break the long sight line ----
  b.box([-6, 0, YARD_N], [6, DOCK_H, -19], "concrete");
  b.box([-6, DOCK_H - 0.12, -19.12], [6, DOCK_H, -19], "hazard", { ghost: true });
  b.box([-1.22, 0, -17], [1.22, 2.6, -10.9], "container_r");
  b.box([-1.22, 2.6, -16.4], [1.22, 5.2, -10.3], "container_g");
  // ---- the gantry: a plate deck with a ladder in the middle of its open side ----
  b.box([-DECK_X, DECK - 0.15, HALL_S + 1], [DECK_X, DECK, DECK_S], "plate");
  b.box([-0.15, 0, DECK_S - 0.3], [0.15, DECK - 0.15, DECK_S], "steel");
  b.box([-0.62, 0, DECK_S], [0.62, DECK - 0.15, DECK_S + 0.04], "plate");
  for (const x of [-0.3, 0.3]) b.pipe([x, 0, DECK_S + 0.16], [x, DECK + 1.05, DECK_S + 0.16], 0.03, "hazard", 6);
  for (let y = 0.3; y < DECK + 0.2; y += 0.3) b.pipe([-0.3, y, DECK_S + 0.16], [0.3, y, DECK_S + 0.16], 0.018, "steel", 6);
  // The alley's middle: a low wall.
  b.box([-2.5, 0, 18.6], [2.5, 1.1, 19.1], "barrier");
  return b;
}

// ---- what is seen ----

const textures = new Map<string, Texture>();
function tex(set: string, map: "diff" | "nor" | "rough"): Texture {
  const uri = `assets/textures/${set}/${map}.jpg`;
  let t = textures.get(uri);
  if (!t) textures.set(uri, (t = new Texture(uri, map === "diff" ? "srgb" : "linear")));
  return t;
}
function surface(name: string, set: string, scale: number, o: { color?: number; roughness?: number; metalness?: number; grime?: number; normal?: number } = {}): MeshStandardMaterial {
  return new SurfaceMaterial({
    name, map: tex(set, "diff"), normalMap: tex(set, "nor"), roughnessMap: tex(set, "rough"), worldScale: scale, normalScale: o.normal ?? 1,
    color: o.color ?? 0xffffff, roughness: o.roughness ?? 1, metalness: o.metalness ?? 0,
    ...(o.grime ? { grime: { amount: o.grime, scale: 3 } } : {}),
  });
}

/** Diagonal yellow and black stripes. */
function hazardTexture(): DataTexture {
  const n = 64, px = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const on = ((x + y) >> 4) & 1;
    px.set(on ? [228, 172, 20, 255] : [22, 22, 24, 255], (y * n + x) * 4);
  }
  return new DataTexture(n, n, px);
}

// A 5 x 7 face for the signs: only the letters the map's signs use.
const GLYPHS: Record<string, string[]> = {
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"], B: ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
  D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"], E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  F: ["11111", "10000", "10000", "11110", "10000", "10000", "10000"], G: ["01111", "10000", "10000", "10111", "10001", "10001", "01111"],
  H: ["10001", "10001", "10001", "11111", "10001", "10001", "10001"], L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  M: ["10001", "11011", "10101", "10101", "10001", "10001", "10001"], N: ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"], R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"], U: ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
  Y: ["10001", "10001", "01010", "00100", "00100", "00100", "00100"], Z: ["11111", "00001", "00010", "00100", "01000", "10000", "11111"],
  " ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"],
};

/** A lit sign: `text` in the sign's colour on a dark face. Returns the mesh (a plane facing +Z before it is turned). */
function sign(text: string, color: [number, number, number], height: number, nits: number): Mesh {
  const cell = 6, cols = text.length * 6 + 3, rows = 7 + 4;
  const w = cols * cell, h = rows * cell;
  const px = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) px.set([3, 3, 4, 255], i * 4);
  [...text].forEach((ch, k) => {
    const g = GLYPHS[ch] ?? GLYPHS[" "]!;
    for (let r = 0; r < 7; r++) for (let c = 0; c < 5; c++) {
      if (g[r]![c] !== "1") continue;
      for (let y = 0; y < cell - 1; y++) for (let x = 0; x < cell - 1; x++) {
        const X = (2 + k * 6 + c) * cell + x, Y = (2 + r) * cell + y;
        px.set([Math.round(color[0] * 255), Math.round(color[1] * 255), Math.round(color[2] * 255), 255], (Y * w + X) * 4);
      }
    }
  });
  const face = new DataTexture(w, h, px);
  const m = new MeshStandardMaterial({ name: `sign ${text}`, color: 0x050506, roughness: 0.4, emissive: 0xffffff, emissiveMap: face, emissiveIntensity: nits });
  const mesh = new Mesh(new PlaneGeometry((height * w) / h, height), m);
  mesh.name = `sign ${text}`;
  mesh.castShadow = false;
  return mesh;
}

function build(b: MapBuilder, root: Object3D): void {
  const hazard = new SurfaceMaterial({ name: "hazard", map: hazardTexture(), worldScale: 0.8, roughness: 0.55 });
  const steel = new MeshStandardMaterial({ name: "steel", color: 0x24272b, roughness: 0.48, metalness: 0.75 });
  const materials: Record<string, MeshStandardMaterial> = {
    asphalt: surface("asphalt", "asphalt_02", 4, { color: 0xb8b4ae }),
    // The hall's floor: polished concrete. It mirrors the skylights, the furnace and every muzzle flash.
    floor: surface("hall floor", "concrete_floor_02", 6, { color: 0xa4a6a8, roughness: 0.2, normal: 0.3 }),
    pavement: surface("pavement", "dirty_concrete", 3.5, { color: 0xc4c0b8, grime: 0.3 }),
    bayfloor: surface("bay floor", "concrete_floor_02", 4, { color: 0xb0aca6, roughness: 0.5, normal: 0.4 }),
    column: surface("column", "dirty_concrete", 2.2, { color: 0xd6d2ca, grime: 0.4 }),
    concrete: surface("concrete", "precast_concrete_wall", 3, { color: 0xcfccc6, grime: 0.35 }),
    cladding: surface("cladding", "corrugated_iron_02", 2.6, { color: 0xc2ccc8, roughness: 0.9, metalness: 0.3, grime: 0.3 }),
    roof: surface("roof", "corrugated_iron_02", 3, { color: 0x6c7274, metalness: 0.3 }),
    paint_a: surface("paint ember", "painted_concrete", 3, { color: 0xe8662a, grime: 0.2 }),
    paint_b: surface("paint azure", "painted_concrete", 3, { color: 0x2f86d6, grime: 0.2 }),
    plate: surface("plate", "metal_plate", 1.6, { color: 0x8f9499, metalness: 0.85, roughness: 0.8 }),
    furnace: surface("furnace", "metal_plate", 2.4, { color: 0x3a3632, metalness: 0.6, roughness: 1 }),
    machine: new MeshStandardMaterial({ name: "machine", color: 0x3f6b52, roughness: 0.55, metalness: 0.35 }),
    crate: new MeshStandardMaterial({ name: "crate olive", color: 0x6f7446, roughness: 0.7 }),
    crate2: new MeshStandardMaterial({ name: "crate sand", color: 0xb39562, roughness: 0.7 }),
    barrier: surface("barrier", "dirty_concrete", 1.6, { color: 0xe6e2da, grime: 0.25 }),
    container_y: surface("container yellow", "corrugated_iron_02", 1.3, { color: 0xe0a51e, metalness: 0.4 }),
    container_w: surface("container white", "corrugated_iron_02", 1.3, { color: 0xdcdcd4, metalness: 0.4 }),
    container_r: surface("container red", "corrugated_iron_02", 1.3, { color: 0xb5372a, metalness: 0.4 }),
    container_g: surface("container green", "corrugated_iron_02", 1.3, { color: 0x2f8f6a, metalness: 0.4 }),
    tank: new MeshStandardMaterial({ name: "tank", color: 0xcfd3d0, roughness: 0.42, metalness: 0.55 }),
    pipe: new MeshStandardMaterial({ name: "pipe", color: 0xc8a21c, roughness: 0.5, metalness: 0.3 }),
    pipe2: new MeshStandardMaterial({ name: "pipe red", color: 0xa83a2a, roughness: 0.5, metalness: 0.3 }),
    ingot: new MeshStandardMaterial({ name: "ingot", color: 0xb8bcc2, roughness: 0.32, metalness: 0.95 }),
    line: new MeshStandardMaterial({ name: "floor line", color: 0xd9a514, roughness: 0.6 }),
    hazard, steel,
  };
  root.add(...b.meshes(materials));

  // ---- light fittings: emitters. They are the hall's light (with the lamps of MapData.lights below them). ----
  const glow = (name: string, c: number, nits: number) => new MeshStandardMaterial({ name, color: 0x000000, emissive: c, emissiveIntensity: nits });
  const add = (mesh: Mesh, at: Vec3, name: string): Mesh => { mesh.position.set(...at); mesh.name = name; mesh.castShadow = false; root.add(mesh); return mesh; };
  const bayLamp = glow("high bay", 0xffe2b8, 90000), shade = new MeshStandardMaterial({ name: "lamp shade", color: 0x15171a, roughness: 0.5, metalness: 0.6 });
  HIGH_BAYS.forEach(([x, z], i) => {
    add(new Mesh(new CylinderGeometry(0.2, 0.42, 0.3, 16), shade), [x, 6.62, z], `high bay ${i} shade`);
    add(new Mesh(new CylinderGeometry(0.34, 0.34, 0.03, 16), bayLamp), [x, 6.45, z], `high bay ${i} lens`);
    add(new Mesh(new CylinderGeometry(0.015, 0.015, HALL_H - 6.77, 6), shade), [x, (HALL_H + 6.77) / 2, z], `high bay ${i} rod`);
  });
  // The furnace: its mouth, and the channel of metal running to the mould bed.
  const molten = glow("molten", 0xff6a1a, 9000);
  add(new Mesh(new BoxGeometry(2.2, 1.1, 0.06), molten), [0, 1.35, 0.02], "furnace mouth");
  add(new Mesh(new BoxGeometry(0.34, 0.04, 3.2), molten), [0, 0.02, 1.6], "furnace channel");
  add(new Mesh(new BoxGeometry(2.2, 0.04, 1.1), glow("molten bed", 0xff5a12, 5000)), [0, 0.57, 4.05], "furnace bed");
  // Tube lights: in the bays (tinted a little with the team's colour), under the gantry (sodium), over the doors.
  const tube = new BoxGeometry(1.6, 0.06, 0.12);
  const tubes: [Vec3, number, number, boolean][] = [];
  for (const s of [-1, 1]) {
    const c = s < 0 ? 0xffd9b0 : 0xcfe4ff;
    for (const z of [-11, -4.5, 2, 8.5]) for (const x of [26.5, 30]) tubes.push([[s * x, BAY_H - 0.04, z], c, 26000, false]);
    for (const x of [3.2, 9]) tubes.push([[s * x, DECK - 0.2, 9], 0xff9a3c, 14000, false]);
  }
  // Along the hall's long walls, cool tubes at 4.6 m: the walls are read, the floor between them stays dim.
  for (const x of [-20, -14.5, -4.5, 4.5, 14.5, 20]) {
    tubes.push([[x, 4.6, HALL_N + 0.08], 0xdfeaff, 16000, false]);
    tubes.push([[x, HALL_H - 0.7, HALL_S - 0.08], 0xdfeaff, 16000, false]);
  }
  tubes.forEach(([at, c, nits], i) => add(new Mesh(tube, glow(`tube ${c.toString(16)} ${nits}`, c, nits)), at, `tube ${i}`));

  // ---- signs ----
  const place = (m: Mesh, at: Vec3, yaw: number) => { m.position.set(...at); m.rotation.y = yaw; root.add(m); };
  place(sign("FOUNDRY", [1, 0.62, 0.2], 1.5, 900), [0, 6.6, HALL_N - 1.03], Math.PI);                    // on the hall, over the yard
  place(sign("BAY A", [1, 0.45, 0.12], 0.6, 700), [-LX + 0.03, 3.95, -1], Math.PI / 2);                    // over the bays' hall doors
  place(sign("BAY B", [0.2, 0.6, 1], 0.6, 700), [LX - 0.03, 3.95, -1], -Math.PI / 2);
  place(sign("YARD", [0.85, 0.95, 1], 0.45, 500), [-12, 3.75, HALL_N + 0.03], 0);                          // inside the hall, over the doors
  place(sign("YARD", [0.85, 0.95, 1], 0.45, 500), [12, 3.75, HALL_N + 0.03], 0);
  place(sign("GANTRY", [0.85, 0.95, 1], 0.45, 500), [-6.5, 3.45, HALL_S - 0.03], Math.PI);
  place(sign("GANTRY", [0.85, 0.95, 1], 0.45, 500), [6.5, 3.45, HALL_S - 0.03], Math.PI);
  place(sign("HALL", [0.85, 0.95, 1], 0.45, 500), [-12, 3.75, HALL_N - 1.03], Math.PI);                    // in the yard, over the hall's doors
  place(sign("HALL", [0.85, 0.95, 1], 0.45, 500), [12, 3.75, HALL_N - 1.03], Math.PI);
}

let made: BuiltMap | null = null;

/** The map. (Built once: its collision triangles and their hash are computed from the geometry.) */
export function foundry(): BuiltMap {
  if (made) return made;
  const b = geometry();
  const spawns: MapSpawn[] = [];
  for (const z of [-13, -7.2, -0.8, 5.6, 11]) {
    spawns.push({ team: "a", position: [-29.4, 0, z], yaw: -Math.PI / 2 });
    spawns.push({ team: "b", position: [29.4, 0, z], yaw: Math.PI / 2 });
  }
  // Free-for-all: spread over the lanes, each looking at the middle.
  const free: Vec3[] = [[-19, 0, -19], [19, 0, -19], [0, DOCK_H, -22], [-20, 0, -1], [20, 0, -1], [0, 0, -6.4], [-18, 0, 18], [18, 0, 18], [-9, DECK, 9], [9, DECK, 9], [-28, 0, 0], [28, 0, 0]];
  for (const p of free) spawns.push({ team: "any", position: p, yaw: Math.atan2(p[0], p[2]) });

  const lights: MapLight[] = [];
  for (const [x, z] of HIGH_BAYS) lights.push({ type: "spot", position: [x, 6.4, z], target: [x, 0, z], angle: 1.05, color: 0xffdcae, power: 150000, radius: 0.3 });
  lights.push({ type: "point", position: [0, 1.4, 0.9], color: 0xff6a1e, power: 38000, radius: 0.5 });
  for (const s of [-1, 1]) {
    lights.push({ type: "point", position: [s * 28.2, 3.7, -7.5], color: s < 0 ? 0xffd2a8 : 0xc4dcff, power: 30000, radius: 0.3 });
    lights.push({ type: "point", position: [s * 28.2, 3.7, 5.5], color: s < 0 ? 0xffd2a8 : 0xc4dcff, power: 30000, radius: 0.3 });
    lights.push({ type: "point", position: [s * 6, 2.5, 9], color: 0xff9a3c, power: 9000, radius: 0.2 });
  }

  made = {
    id: "foundry",
    title: "Foundry",
    credits: "OpenStrikeRT (built in code). Textures: Poly Haven, CC0.",
    collision: b.collision,
    spawns,
    sun: { azimuth: 207, elevation: 50, illuminance: 95000, color: 0xfff1de },
    sky: "atmosphere",
    lights,
    bounds: { min: [...b.min] as Vec3, max: [...b.max] as Vec3 },
    killY: -12,
    ladders: [LADDER],
    hash: collisionHash(b.collision.positions, b.collision.indices),
    build: (root) => build(b, root as Object3D),
  };
  return made;
}
