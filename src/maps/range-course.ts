// The Range's numbers (src/maps/range.ts), apart from the map so the scripted tests can read them in Node.

/** The course's numbers, for the tests. */
export const RANGE = {
  half: 30,
  /** A wall 0.1 m thick across the way north of the start: its south face. */
  thinWall: { z: -10, thickness: 0.1 },
  /** Platforms east of the start: one low enough to step onto (its west face at x), one too high. */
  step: { x: 10, z: -4, height: 0.4 },
  kerb: { x: 10, z: 4, height: 0.6 },
  /** Ramps west of the start, rising toward -x from x: 30 degrees (walked), 60 degrees (not). */
  ramp: { x: -10, z: -4, length: 4, height: 4 * Math.tan(Math.PI / 6) },
  steep: { x: -10, z: 4, length: 2, height: 2 * Math.tan(Math.PI / 3) },
  /** A tunnel 1.4 m high along x, from x0 to x1 at z. */
  tunnel: { x0: 18, x1: 24, z: 12, height: 1.4 },
  /** A tower south of the start with a ladder on its north face. */
  tower: { z: 14, height: 4 },
} as const;
