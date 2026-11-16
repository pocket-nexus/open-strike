# Maps

A map is what the players stand on and what they see. The game takes every map as the same data (`MapData`,
`src/maps/types.ts`): collision triangles, spawns, the sun and the lamps, bounds, and either a GLB to draw or a
function that builds the picture in code.

| Kind | Where | Made by |
|---|---|---|
| built in | `src/maps/<id>.ts` (a `BuiltMap`) | written in code: original geometry, no files, shipped with the game |
| imported by the player | the app's store on the player's device: `maps/<id>/map.json` + `maps/<id>/map.glb` | the game's Maps menu, from the player's own copy of the game |
| bundled by a developer | `maps/<id>/map.json` (a `MapData`) + `assets/maps/<id>/map.glb` in a project | `tools/import-bsp.ts` from a BSP you own, in a remix |

Units are metres, Y is up, a player is 1.8 m tall and 0.6 m wide, steps up to 0.45 m are walked over.

## Imported maps

OpenStrikeRT ships only maps made for it. The classic GoldSrc maps (Counter-Strike 1.x, Half-Life) are copyrighted,
so they are never part of the package or of a published version. A player who owns the game brings their own copy.

### Importing in the game

In the game, **M** opens the Maps menu: every map this copy of the game has, and "Import from your game folder…".

1. The player chooses a folder: the game's own (`Half-Life`, or `cstrike` / `valve` in it). The app shows its own
   folder picker; the game sees only the `.bsp`, `.wad` and `.rad` files under the folder the player chose (the
   engine's `files.pick`, docs/RUNTIME.md "Files" in the engine), nothing else of the disk.
2. The menu lists the maps found (`cstrike/maps/de_dust2.bsp`, ...). The player imports one, or all of them.
3. The game converts each map **inside the game**: the same converter as the developer's tool below (`src/import/`,
   plain TypeScript), a few milliseconds a frame so the picture keeps running, with its progress at the bottom of the
   HUD. It reads the map, then the WADs the map names (from the folder: next to the map, one directory up, or
   anywhere in it by name), and a `lights.rad` lying next to them.
4. The result goes into the app's store for this game, on this device: `maps/<id>/map.glb`, then
   `maps/<id>/map.json` (whose `glb` is `user:maps/<id>/map.glb`, the store's own asset URI). From then on the map is
   in the menu, in every session, until the player removes it there ("Remove from this device").

From the menu the player practises on a map against bots, or opens a new room on it. The id is the file's name in
lower case (`de_dust2`); a map whose name is a built-in map's gets `_imported` after it. Importing the same file again
replaces the map; the hash stays the same.

**It stays on the device.** The map's files are read from the player's pick and written to the app's store only:
never uploaded, never sent to other players, never part of anything published. A room names its map by `id` and
`hash` and nothing else. Someone who joins without that map (or with another version of it) is told which map the
room plays and how to import it ("M: Maps, Import"), and practises meanwhile.

It needs an app that lets a game pick files and keep a store (the `files` and `store` families of the host channel;
ThreeRT with the engine's "Files" support). Without them the menu says importing needs a newer ThreeRT; the built-in
maps and rooms work as before.

How long it takes, on an M-series Mac, in the engine's runtime (QuickJS) at 60 frames a second
(`node tools/time-import.ts <folder> de_dust2 de_inferno cs_office`): de_dust2 1.6 s (0.8 s of work spread over
88 frames), de_inferno 3.5 s (2.0 s of work), cs_office 3.5 s (1.9 s). The same conversion in Node
(`tools/import-bsp.ts`) takes 0.3 to 0.5 s. The longest single slice is about 20 ms; the frame on which a large WAD
arrives (halflife.wad, 38 MB, as one message) takes about 0.1 s.

### Importing as a developer (a remix)

```
threert remix openstrike && cd openstrike
node tools/import-bsp.ts <path>/de_dust2.bsp [--wad <dir with the map's .wad files>] [--id de_dust2]
threert dev                                   # the map is in the map list, bundled with this copy of the game
```

The importer writes `maps/<id>/map.json` and `assets/maps/<id>/map.glb`, and lists the map in `maps/index.ts` (what
the game bundles). Both directories are git-ignored. A project with imported maps in it must not be published: a published
version would hand someone else's maps to everyone. `threert publish` does not know about maps, so check first:
`node tools/check-no-imported-maps.ts` says whether the project is clean (the release steps in README.md run it).

## How the game reads a map

(Added by the game's side of the contract; nothing above changed. `src/maps/mount.ts` is the code.)

- **`maps/index.ts`** exports one thing, `export const maps: MapData[]`: the imported maps the game bundles, in the
  order they are listed. The committed file exports an empty list; the importer rewrites it with one
  `import <id> from "./<id>/map.json"` a map. Built-in maps come first in the game's list (`src/maps/index.ts`:
  Foundry, Range), then the bundled ones, then the player's own from the store (sorted by id), and an imported map
  cannot take the id of a map that comes with the game.
- **The store's maps** are every `maps/<id>/map.json` the app's `store.list("maps/")` names, read before the game
  goes into a room or practice (it waits at most 4 s for them), so a launch's `map` and a room's map can be one.
- **`hash`** is the SHA-256, in hex, of the collision data as bytes: `positions` as little-endian float32, then
  `indices` as little-endian uint32 (`collisionHash` in `src/maps/hash.ts`, plain TypeScript, usable from the
  importer). The game does not recompute an imported map's hash: it compares the room's `{id, hash}` with the map's.
- **Collision** becomes one fixed triangle mesh in the physics world (hidden; it is not drawn). Both sides of a
  triangle stop a body and a bullet. The engine's limits: 1 M triangles, positions within ±100 km. The winding does
  not matter; degenerate triangles should be left out.
- **`glb`** is drawn as one model at the origin, unscaled (metres, Y up), with its own materials and textures.
  Emissive materials light the map. The file must be a GLB (everything in one file), under `assets/` or in the
  app's store (`user:maps/<id>/map.glb`).
- **`spawns`**: team `"a"` is the Ember side, `"b"` Azure, `"any"` free-for-all. A team match uses the team's
  spawns (all of them when it has none); free-for-all uses `"any"` (all, when there are none). `position` is the
  feet; the player is put a skin above it and falls onto the floor, so a spawn a few centimetres above the ground is
  fine and one below it is not. `yaw` 0 looks down -Z, positive turns left.
- **`sun`**: `elevation` and `azimuth` in degrees as the engine's `DirectionalLight.setSunAngles` takes them:
  azimuth 0 is a sun in the +Z sky (its light travels toward -Z), 90 a sun in the +X sky. Without `sun` the map has
  no sunlight (give it a `sky` colour or lamps). `sky: "atmosphere"` (the default) is the physical sky for that sun.
- **`lights`**: `power` is in lumens. A point lamp becomes `power / 4π` candela; a spot `power / (2π (1 - cos angle))`
  along `position → target` (straight down without a target), `angle` being the cone's half angle (default 45°).
  `radius` (default 5 cm) is the lamp's size.
- **`exposure`**: a fixed EV100. Without it the camera adapts (clamped to EV 7..15), which suits maps that have both
  sunlit and indoor places.
- **`ladders`**: axis-aligned volumes. Inside one (the player's feet within it, a little margin sideways) forward
  climbs at 3.2 m/s, down when looking down; jumping lets go. Make the volume reach about 0.2 m above the ledge the
  ladder leads to, and put something solid behind the ladder (the volume itself stops nothing).
- **`killY`**: a player whose feet are below it dies ("fell").
- **`bounds`** is not used by the game yet (a minimap, a spectator camera would).

To try a map list without touching `maps/index.ts`: `node tools/build.ts --maps <other index.ts> -o out/x.js`.
`node tools/test-maps.ts` makes a small game folder of its own (two maps and a WAD, `tools/bsp/fixture.ts`), imports
it in the game through the menu, checks what was stored against what the converter makes in Node, plays it in
practice and in a room (a player without it is told), removes it again, and plays a bundled map.

## The importer

The converter is `src/import/` (`bsp.ts`, `wad.ts`, `convert.ts`, `glb.ts`, `png.ts` with its own `deflate.ts`,
`rays.ts`, `bytes.ts`), plain TypeScript with nothing of Node's in it, so the game runs it in the engine
(`job.ts`: from a pick to the store, `library.ts`: the player's maps, `sliced.ts`: a few milliseconds a frame).
`convertSteps` is the conversion as a generator that yields its progress; `convertBsp` runs it at once.
`tools/import-bsp.ts` is the developer's command over the same code:

```
node tools/import-bsp.ts <map.bsp> [--wad <dir or .wad>]... [--rad <lights.rad>] [--id <id>] [--out <project dir>] [--no-relight]
node tools/import-bsp.ts --remove <id> [--out <project dir>]
node tools/check-no-imported-maps.ts [project dir]        # exits 1 when the project holds imported maps
node --test tools/import-bsp.test.ts                      # or: bun test tools/
node tools/time-import.ts <folder> [map ...]              # imports in the game (headless) and says how long it took
```

No dependencies: Node 22 or later runs it as it is, and so does `bun`. It reads GoldSrc maps (BSP version 30:
Half-Life, Counter-Strike 1.x) and their WAD3 texture archives. A Source map (`VBSP`), a Quake map (version 29) or a
file cut short is refused with a sentence that says which.

| Option | |
|---|---|
| `--wad` | where the map's `.wad` files are, a directory or a file, as often as needed. They are also looked for next to the map and one directory up (`cstrike/maps/x.bsp` finds `cstrike/*.wad`). The WADs the map names are tried first, in its order. |
| `--rad` | the game's `lights.rad`: the textures it lists glow. One lying where the WADs are is found without the option. |
| `--id` | the map's id in the game, `[a-z0-9_-]+`; default: the file's name in lower case. |
| `--out` | the project to import into; default: the one the tool is in. |
| `--no-relight` | write no `lights` (the sun, the sky and glowing textures stay). |
| `--remove` | delete `maps/<id>/` and `assets/maps/<id>/` and take the map out of `maps/index.ts`. |

It writes `maps/<id>/map.json`, `assets/maps/<id>/map.glb` and `maps/index.ts`, checks what it wrote and prints a
summary: faces and triangles, textures found and missing, spawns per team, the sun, the lights kept, bounds, file
sizes, and every problem the check found. `maps/index.ts` exports `maps: MapData[]`: one
`import <id> from "./<id>/map.json"` per imported map; with none it is `export const maps: MapData[] = [];`.

The tests build their own maps (`tools/bsp/fixture.ts` writes a BSP and a WAD from a description), so no copyrighted
file is in the repository.

### Space

GoldSrc has Z up, units of an inch (a player is 72 units tall) and yaw counter-clockwise from +X. A position
(x, y, z) becomes (x, z, -y) × 0.0254: a rotation, so nothing is mirrored; north (+Y) is the game's -Z. A yaw of `a`
degrees becomes (`a` - 90) degrees in radians: GoldSrc 90 (north) is the game's 0.

### What is converted

| In the map | Becomes |
|---|---|
| world faces | triangles in the GLB, one primitive per texture, with normals and texture coordinates from the map's texture axes; and collision |
| textures | PNGs in the GLB (palette PNGs: the texels are the map's own; one block of fixed Huffman codes, a few per cent larger than zlib's best). Those embedded in the map come first, then the WADs. A texture nobody has is a magenta checker, and the warning names the WADs the map asks for |
| `{` textures | alpha-masked on palette index 255, double-sided; a `{` texture with no opaque texel is not drawn |
| `+0…`, `-0…` textures | drawn as the face names them (no animation, no random tiling) |
| `sky` | not drawn: the game's sky shows. Still collision, so the map stays closed |
| `clip`, `origin`, `aaatrigger`, `null`, `hint`, `skip` and the like | not drawn, no collision |
| `!` textures, `func_water` | one glossy sheet facing up, tinted by its texture, mostly see-through (transmission 0.8, index of refraction 1.33); no collision |
| `func_wall`, `func_breakable`, `func_door…`, `func_button`, `func_plat`, `func_train…` and any other brush entity | drawn and solid, where the map file has it: doors closed, glass whole, nothing moves |
| `func_illusionary` | drawn, not solid |
| render mode "texture" with an amount below 250 | glass (`KHR_materials_transmission`, 1 - amount / 255); amount 0 or none: an invisible wall, solid and not drawn. Glow and additive modes are not drawn |
| `trigger_…`, `func_buyzone`, `func_bomb_target`, `func_hostage_rescue` and other zones | left out |
| `func_ladder` | a box in `ladders` |
| `info_player_start` | a spawn of team "a" (counter-terrorists); `info_player_deathmatch`: team "b" (terrorists). A map with only one of the two spawns "any". The feet are put on the floor under the entity, 1 cm above it; yaw from `angles` (or `angle`) |
| `light_environment` | `sun` and `sky: "atmosphere"`; see below |
| `light`, `light_spot` | `lights`; see below |
| `~` textures, `skkylite` panels, names in a `lights.rad` | emissive materials (`KHR_materials_emissive_strength`) |
| worldspawn `message` | `title` |

Materials are guessed from texture names (`crate`, `wood`: wood; `metal`, `fence`, `pipe`, `rail`: metal; `glass`,
`window`: glossy; `grass`, `dirt`, `sand`, `flr`: ground; anything else: concrete) and get a roughness and a
metalness; there are no normal maps. Base colours are not the textures as painted. GoldSrc drew its textures through
a gamma ramp under lightmaps that made up for how dark they are, so a Half-Life brick wall reflects 5 % of the light
as painted, and a room of them stays black. Each texture's mean reflectance is doubled, kept inside what its material
can be (concrete 0.16 to 0.45, wood 0.12 to 0.40, ...), and never raised more than 4 times; a texture light enough is
left alone. And every texture keeps 75 % of its saturation: bounced light multiplies a colour in again at every
bounce, and a room lit by bounces turns more orange than its walls. Lamp textures and the placeholder are written as
they are.

Not converted: decals (`infodecal`), sprites and glows (`env_sprite`, `env_glow`), models (`cycler`, hostages,
props), sounds, the sky box (`skyname`), anything that moves or switches (doors, buttons, breakable glass, toggled
walls and lights), bomb sites, buy and rescue zones, lightmaps.

### Collision

`collision` holds the faces of the world and of every solid brush entity, sky included, water and tool textures
left out: triangles wound counter-clockwise seen from the open side. Vertices are welded (positions rounded to
0.01 mm), a triangle that is there twice is kept once, and slivers on collinear vertices are dropped. `bounds` is the
box of the collision data; `killY` is 5 m below it.

These are the faces of the map's hull 0, the one bullets use. GoldSrc keeps what stops a *player* in three more
hulls, as BSP trees of the world grown by half a player, not as faces, and `clip` brushes exist only there.
Recovering the brushes from those trees is not done. So an imported map has no invisible player walls: a player can
get onto ledges, roofs and props the original fenced off with `clip`, and stairs and door frames that `clip` ramps
smoothed are walked as they are built. A brush textured `null` on a side has no face there, so no collision on that
side.

### The hash

`hash` is the SHA-256, in lower-case hex, of these bytes: every number of `collision.positions`, in order, as a
little-endian IEEE 754 float32 (the JSON number rounded to the nearest float32, `Math.fround`), then every number of
`collision.indices`, in order, as a little-endian uint32. No header, no lengths, no padding.

```ts
const bytes = new Uint8Array(positions.length * 4 + indices.length * 4);
const view = new DataView(bytes.buffer);
positions.forEach((v, i) => view.setFloat32(i * 4, v, true));
indices.forEach((v, i) => view.setUint32(positions.length * 4 + i * 4, v, true));
hash = hex(sha256(bytes));
```

Importing the same file again gives the same hash; `--no-relight`, `--rad` and the WADs do not change it.

### Light

GoldSrc lights are numbers on the 0..255 scale of a lightmap. A path tracer wants lux, candela and nits. The mapping:

- **The sun** (`light_environment`). `_light "r g b brightness"`. Direction: `pitch` (or the pitch of `angles`) and
  `angle` (or the yaw of `angles`) say where the light travels; `sun.elevation` and `sun.azimuth` say where the sun
  stands, in degrees, as `DirectionalLight.setSunAngles` takes them (azimuth 0: the sun in the +Z sky, 90: in the +X
  sky). Illuminance: 1000 lux × brightness × the colour's luminance, kept between 400 and 120 000 (de_dust2's
  `255 255 128 70` is 66 000 lux). Colour: `_light` with half of its saturation, because the game's sky adds its own
  blue. Several `light_environment`s: the first.
- **An overcast day**. A `light_environment` that shines upward lights nothing directly (cs_office does this to have
  sky light only). There is no `sun` then, and `sky` is `{ color, intensity }`: a uniform sky, `intensity` in nits,
  from 100 lux × brightness × luminance, kept between 2 000 and 20 000 lux, over π.
- **No `light_environment`**: no `sun`, `sky: "atmosphere"`: night, lit by the map's lamps.
- **Lamps** (`light`, `light_spot`). The map compiler multiplies a light's brightness `b` by `b² / 10` and applies
  the inverse square law in units, so a surface `d` units away gets `b³ / (10 d²)` on the lightmap's scale. With a
  full lightmap (255) standing for 5 000 lux and `d` in metres, a light is `b³ × 1.265e-3` candela: brightness 75
  is 530 cd, 100 is 1 265 cd (a high-bay lamp), 160 and above is the cap, 5 000 cd. `b` is the brightest channel of
  `_light` (`"r g b"` without a brightness is taken as it is, as the compiler does); the colour is `_light` with that
  channel at 255. `power` is lumens: 4π × candela for a point light, 2π (1 - cos `angle`) × candela for a spot, the
  light inside its cone. A spot's `angle` is `_cone2` (or `_cone`, default 10°), its `target` one metre along its
  direction (`pitch` / `angle`, or toward the entity its `target` names). Lights that start dark (spawn flag 1) are
  left out, lights closer than 0.5 m are merged into one, and the 64 brightest are kept. `--no-relight` writes none.
- **Texture lights**. In these maps most rooms are lit by textures, listed in the compiler's `lights.rad`, which is
  not in the map. The names follow a convention and that is what the importer goes by: a `~` in front (`~LIGHT3A`,
  `+0~FIFTIES_LGT2`) is a lamp, 20 000 nits for a white texel (the texture is small and stands for a strong fitting);
  `skkylite` panels are sky lights, 5 000 nits; `~` names of screens (`comp`, `crt`, ...) 150 nits. `+A~…` frames
  (the light switched off) do not glow. A `lights.rad` adds the names it lists; its brightness values are not used.

The numbers were chosen looking at path-traced stills of de_dust2, de_inferno, cs_assault, de_nuke and cs_office
under the game's exposure (automatic, never below EV 7): rooms lit by lamps come out between dim and well lit, and
the sun stays some hundred times brighter than any room, as it is. A map's mood is not converted: cs_assault
is a dusk map by its sky box and comes out as a hazy purple day.

### Limits

- Moving and switching things do not move or switch; breakable glass does not break.
- No `clip` brushes (see Collision).
- Lamps are capped at 64; glowing textures are not capped.
- Textures stay at their resolution (most are 64 to 256 texels a side) and are filtered as the engine filters.
- Face count is that of the map: de_inferno is 20 000 triangles, a 3.5 MB GLB and a 0.5 MB `map.json`.
