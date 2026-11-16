# Credits

Everything OpenStrikeRT ships is original work of the project or CC0.

## Original (this project)

| What | Where | How it is made |
|---|---|---|
| The maps Foundry and Range | `src/maps/foundry.ts`, `src/maps/range.ts` | geometry, lights and signs in code; no model files |
| The weapons and first-person arms: VK-5 Carbine, M12 Breacher, LR-9 Marksman | `assets/weapons/*.glb` | modelled in code by `tools/weapons/` (the modelling kit of the earlier native OpenStrike, first-party); `node tools/weapons/build.ts` writes them. Fictional designs: no manufacturer's name, mark or exact likeness. |
| The soldiers | `src/soldiers.ts` | built and animated in code (instanced parts, procedural poses) |
| Signs, hazard stripes, the scope's reticle | `src/maps/foundry.ts`, `src/viewmodel.ts` | pixels and meshes generated in code |
| Effects: muzzle flashes, tracers, sparks, bullet marks, casings | `src/effects.ts` | meshes and lights in code |
| Every sound: shots (close and distant), reloads, the switch, impacts, steps, the body, hit and kill, respawn, the round's stingers | `assets/sounds/*.ogg` | synthesized by `tools/sounds.ts` (noise, filters, envelopes, oscillators, a synthetic room; seeded) and encoded by ffmpeg's Vorbis encoder. No recordings, samples or third-party audio. |

## Textures: Poly Haven, CC0 1.0

`assets/textures/<set>/{diff,nor,rough}.jpg`, resized to 1024 px by `node tools/assets.ts` from the Poly Haven sets
of the same names (https://polyhaven.com/a/<set>; licence: https://polyhaven.com/license, CC0 1.0 Universal: no
attribution required, given here anyway).

| Set | Used for |
|---|---|
| `concrete_floor_02` | the hall's polished floor, the bays' floors |
| `painted_concrete` | the bays' painted walls |
| `corrugated_iron_02` | the hall's cladding and roof, the containers |
| `metal_plate` | the gantry's deck and stairs, the furnace |
| `dirty_concrete` | the alley's ground, columns, barriers |
| `precast_concrete_wall` | perimeter walls, the dock |
| `asphalt_02` | the yard |

## Not shipped

- No third-party audio: every sound is synthesized by the project (above).
- No character models or animation clips from third parties. (The earlier native OpenStrike used a Mixamo-derived
  sample character; none of it is here.)
- Imported maps are a player's own copies of maps they own: those imported in the game are kept in the app's store
  on the player's device and never leave it; those a developer imports into a project (`maps/<id>/`, `assets/maps/`)
  are git-ignored and never published (`docs/MAPS.md`).
- `media/imported-de_dust2.jpg`, `media/imported-de_inferno.jpg` and `media/maps-menu.jpg` are pictures of the game
  playing Counter-Strike maps (de_dust2, de_inferno: Valve's) imported from a copy the picture's taker owns, to show
  the Maps menu's import. The maps themselves are not in this repository or in the game.

## Tooling (not part of the package)

The engine (ThreeRT, MIT), its bundler (esbuild, MIT), `earcut` (ISC; triangulation in the weapon modelling kit) and
`sharp` (Apache-2.0; texture resizing) are used to build and are not redistributed with the game. `@threert/net`
(multiplayer rooms, first-party) comes with ThreeRT's SDK and is bundled into the game when it is built.
