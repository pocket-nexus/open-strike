// What the soldier's materials are in each outfit: glTF factors only (linear base colour, metallic, roughness). The
// teams are told apart by the whole kit, warm and light against cold and dark, and by the bright hook panels on the
// helmet, the chest, the back and the arms.
import type { Outfit } from "../../src/character/rig.ts";
import type { Cloth } from "./gltf.ts";

export interface MaterialDef { color: [number, number, number]; metallic: number; roughness: number }

/** The same in every outfit. */
const COMMON: Record<string, MaterialDef> = {
  // Black polymer: buckles, rails, the holster, pad caps, the headset.
  hard: { color: [0.026, 0.026, 0.028], metallic: 0, roughness: 0.48 },
  // Magazines, the pistol.
  metal: { color: [0.05, 0.05, 0.054], metallic: 0.35, roughness: 0.5 },
  rubber: { color: [0.02, 0.02, 0.021], metallic: 0, roughness: 0.8 },
  strap: { color: [0.03, 0.03, 0.03], metallic: 0, roughness: 0.9 },
  // The goggles' lens: dark, and it mirrors the sky.
  lens: { color: [0.05, 0.04, 0.03], metallic: 0.9, roughness: 0.12 },
  glove: { color: [0.028, 0.028, 0.03], metallic: 0, roughness: 0.82 },
  glove_shell: { color: [0.016, 0.016, 0.017], metallic: 0, roughness: 0.6 },
  glove_palm: { color: [0.07, 0.065, 0.06], metallic: 0, roughness: 0.9 },
};

export const OUTFIT: Record<Outfit, Record<string, MaterialDef>> = {
  // Ember: desert tan cloth, coyote-brown kit, orange panels.
  ember: {
    ...COMMON,
    fabric: { color: [0.38, 0.3, 0.2], metallic: 0, roughness: 0.92 },
    nylon: { color: [0.25, 0.13, 0.06], metallic: 0, roughness: 0.85 },
    helmet: { color: [0.27, 0.14, 0.065], metallic: 0, roughness: 0.6 },
    accent: { color: [0.9, 0.21, 0.03], metallic: 0, roughness: 0.7 },
    boot: { color: [0.2, 0.14, 0.09], metallic: 0, roughness: 0.85 },
    mask: { color: [0.1, 0.08, 0.06], metallic: 0, roughness: 0.95 },
  },
  // Azure: slate cloth, navy kit, blue panels.
  azure: {
    ...COMMON,
    fabric: { color: [0.075, 0.085, 0.105], metallic: 0, roughness: 0.92 },
    nylon: { color: [0.028, 0.06, 0.15], metallic: 0, roughness: 0.85 },
    helmet: { color: [0.03, 0.065, 0.17], metallic: 0, roughness: 0.6 },
    accent: { color: [0.04, 0.34, 0.95], metallic: 0, roughness: 0.7 },
    boot: { color: [0.022, 0.022, 0.024], metallic: 0, roughness: 0.75 },
    mask: { color: [0.02, 0.022, 0.028], metallic: 0, roughness: 0.95 },
  },
  // No team: olive cloth, ranger-green kit, grey panels.
  ranger: {
    ...COMMON,
    fabric: { color: [0.14, 0.16, 0.095], metallic: 0, roughness: 0.92 },
    nylon: { color: [0.1, 0.105, 0.07], metallic: 0, roughness: 0.85 },
    helmet: { color: [0.09, 0.1, 0.065], metallic: 0, roughness: 0.6 },
    accent: { color: [0.45, 0.45, 0.4], metallic: 0, roughness: 0.7 },
    boot: { color: [0.11, 0.08, 0.05], metallic: 0, roughness: 0.85 },
    mask: { color: [0.03, 0.032, 0.028], metallic: 0, roughness: 0.95 },
  },
};

/** The materials that are cloth, and how each is textured (textures.ts): the same in every outfit. */
export const CLOTH: Record<string, Cloth> = {
  fabric: { map: "camo", relief: 0.45, repeat: 420 },
  nylon: { map: "cordura", relief: 0.8, repeat: 260 },
  mask: { map: "cordura", relief: 0.5, repeat: 200 },
  strap: { map: "cordura", relief: 0.8, repeat: 200 },
};
