// The weapon models' materials: glTF PBR factors only (linear base colour, metallic, roughness). No emissive and no
// transmission: the renderer flattens such triangles per placement, which is expensive on a moving viewmodel. The
// metals are less mirror-like than the real ones (metallic well under 1, roughness over 0.45): the handhelds trace one
// sample a pixel, and a glossy metal a hand's length from the eye turns that into sparkle.
import type { MaterialDef } from "./kit.ts";
import type { Cloth } from "../characters/gltf.ts";

export const MATERIALS: Record<string, MaterialDef> = {
  // Hard-anodized aluminium (receivers, handguards, optic bodies).
  anodized: { color: [0.105, 0.108, 0.115], metallic: 0.3, roughness: 0.62 },
  // Phosphated / nitrided steel (barrels, muzzle devices, pins, sights).
  gunmetal: { color: [0.2, 0.2, 0.21], metallic: 0.45, roughness: 0.56 },
  // Bare, worn steel (bolt carriers, pistol barrels).
  steel: { color: [0.52, 0.51, 0.49], metallic: 0.65, roughness: 0.46 },
  // Black glass-filled polymer (grips, stocks, frames).
  polymer: { color: [0.04, 0.04, 0.043], metallic: 0, roughness: 0.55 },
  // Dark-earth polymer / cerakote (two-tone furniture).
  polymer_tan: { color: [0.25, 0.19, 0.125], metallic: 0, roughness: 0.62 },
  // Flat dark earth cerakote on aluminium (the marksman rifle's receiver and handguard).
  cerakote_fde: { color: [0.3, 0.235, 0.15], metallic: 0.35, roughness: 0.55 },
  // Olive drab cerakote / paint.
  olive: { color: [0.085, 0.1, 0.055], metallic: 0.25, roughness: 0.6 },
  rubber: { color: [0.022, 0.022, 0.023], metallic: 0, roughness: 0.8 },
  brass: { color: [0.78, 0.57, 0.25], metallic: 1, roughness: 0.32 },
  copper: { color: [0.72, 0.38, 0.22], metallic: 1, roughness: 0.35 },
  // Shotgun shell hull.
  shell_red: { color: [0.42, 0.025, 0.02], metallic: 0, roughness: 0.45 },
  // Recesses: bores, ports, slots.
  void: { color: [0.004, 0.004, 0.004], metallic: 0, roughness: 1 },
  // Paint marks (sight dots, selector marks, grenade stencil).
  marking: { color: [0.75, 0.75, 0.7], metallic: 0, roughness: 0.6 },
  marking_red: { color: [0.5, 0.02, 0.015], metallic: 0, roughness: 0.55 },
  marking_yellow: { color: [0.75, 0.52, 0.03], metallic: 0, roughness: 0.55 },
  // Arms.
  glove: { color: [0.028, 0.028, 0.03], metallic: 0, roughness: 0.82 },
  glove_shell: { color: [0.016, 0.016, 0.017], metallic: 0, roughness: 0.6 },
  glove_palm: { color: [0.07, 0.065, 0.06], metallic: 0, roughness: 0.9 },
  sleeve: { color: [0.105, 0.115, 0.085], metallic: 0, roughness: 0.95 },
  // The watch: its case, its glass.
  hard: { color: [0.03, 0.03, 0.032], metallic: 0, roughness: 0.5 },
  lens: { color: [0.01, 0.012, 0.014], metallic: 0, roughness: 0.12 },
};

/** The materials that are cloth, and their pictures (../characters/textures.ts). */
export const CLOTH: Record<string, Cloth> = {
  sleeve: { map: "camo", relief: 0.45, repeat: 420 },
  glove: { map: "cordura", relief: 0.7, repeat: 140 },
};
