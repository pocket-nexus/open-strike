# Selectable mod packs

OpenStrike's **`openstrike-mods` crate** owns the pack catalogue, character
resources, first-person mesh and shot presentation. The shared guest owns
selection, weapon tuning, opponent tuning and HUD labels. The PSP host
implements resource switching; other hosts keep their Classic presentation
until they implement the same catalogue and loading contract.

The PSP package always includes Classic. Add local manifests with repeated
`--mod` arguments. With more than one pack, the game opens a mod menu before
map selection. Local-pack EBOOTs request **PSP-2000+ extended memory**. SELECT on the map menu returns to mod selection; SELECT during
play opens the return-to-menu dialog. **Switching takes effect when a new map
is initialized.** A running round keeps its selected resources.

```sh
bun scripts/psp.ts --release --package --cooked-maps dist/maps \
  --mod out/mods/frieren/mod.json
```

## Local Frieren example

The example combines one opponent, a red staff with a gold crescent and ruby,
and Zoltraak-style pale blue focus rings and white beams. Classic retains
its three police opponents and rifle. Both presentations use **the same
collision, hitscan, damage and fixed-step simulation**. The first-person
focus follows the staff; beams and impacts use the world's depth buffer.
Restoring mana raises and tilts the staff, grows rotating focus rings, then
returns it to the holding pose with a completion pulse. The animation follows
the weapon's reload progress; it does not refill ammunition before that timer
finishes.

Provide a source GLB whose use is permitted, with the actions and sockets
described by `scripts/bake-character.py`. The existing Pocket Openworld
character can be used for local testing subject to its asset restrictions.
Neither that character nor a package containing it is included in this repo.

```sh
mkdir -p out/mods/frieren
cp mods/frieren.json out/mods/frieren/mod.json
Blender --background --factory-startup --python-exit-code 1 \
  --python scripts/bake-character.py -- --source /path/to/character.glb \
  --output out/mods/frieren/character.opch
Blender --background --factory-startup --python-exit-code 1 \
  --python scripts/build-staff.py -- --output out/mods/frieren/staff
```

`build-staff.py` authors the geometry in Blender and writes an editable
`.blend`, an exchange `.glb`, a preview `.png` and the baked `.opvm` mesh.
The staff uses **756 triangles**, opaque vertex colors and no runtime texture
or material parser. Generated files, captures and EBOOT packages stay under
ignored `out/` or `dist/`; the recipe and manifests are committed.

The visual references are the official [staff illustration](https://frieren-anime.jp/goods/figure/4555/)
and [magic guide](https://frieren-anime.jp/special/magic/). The staff recipe
constructs its own mesh; it does not extract geometry from those images.

## Local Pikachu example

`build-pikachu.py` authors a yellow character with red cheeks, black ear tips
and a lightning-shaped tail, plus a red/white ball and a first-person pair
of paws. It uses Blender primitives, a weighted rig and **seven actions**:
Idle, Walk, Run, Fire, Reload, Hit and Death. The visual reference is the
official [Pikachu illustration](https://www.pokemon.com/us/pokedex/pikachu).
No downloaded mesh, rig or texture is an input.

```sh
Blender --background --factory-startup --python-exit-code 1 \
  --python scripts/build-pikachu.py -- --output out/mods/pikachu
cp mods/pikachu.json out/mods/pikachu/mod.json
bun scripts/psp.ts --release --package --cooked-maps dist/maps \
  --mod out/mods/frieren/mod.json --mod out/mods/pikachu/mod.json
```

The outputs include `pikachu.blend`, `pokeball.blend`, `viewmodel.blend`,
the character GLB, baked meshes, a preview and receipts. The character has
**2,865 triangles and a 6,211,296-byte shared pose cache**. The held ball and
paws use 704 triangles; each flying ball uses 464. Generated files remain
in ignored local output.

This pack uses **ballistic delivery** in the shared simulation. Throwing
consumes a ball, launches it from the held position, and lets gravity bend
its path. Map collision sweeps the center segment each fixed tick; actor
collision sweeps against bounds expanded by the ball radius. Cover is checked
before an actor hit. Damage occurs at contact, so a target can move out of
the path. Bot throws obey the same contact rules. A blocked release produces
an impact on the near side of the wall. Shots expire after their configured
lifetime and are cleared at round reset; at most **32 projectiles** can exist.
Classic and Frieren retain hitscan delivery.

The held ball leaves the screen on release and returns with the next ball.
Reloading restocks the six-ball supply from reserve. Low-ammunition color is
based on the selected capacity, so the first throw does not trigger it.

## Pack contract

`mods/classic.json`, `mods/frieren.json` and `mods/pikachu.json` show schema 1. A manifest supplies
an `id`, title, description, character path, viewmodel path, `flame`, `beam` or `orb`
effect profile, weapon configuration, opponent configuration and HUD labels.
Paths resolve relative to the manifest. A null character uses the bundled
officer; a null viewmodel uses the procedural rifle.

`viewMotion` selects `rifle` (the default), `staff` or `throw` animation.
An `orb` profile requires a `projectile` object with its mesh path, speed,
gravity, upward launch speed (`lift`), radius and lifetime. These settings
are native pack data and are installed at the same map boundary as the
character. Invalid profiles and out-of-range values fail the build.

The build rejects duplicate IDs, unsupported schemas/effects, invalid numeric
configuration and malformed assets. Limits are **eight packs, 8 MiB of baked
asset payload, 16 MiB per character morph cache, and 3,072 viewmodel vertices**.
An OPVM/1 mesh has a 24-byte little-endian header: `OPVM`, version u32,
vertex count u32 and muzzle XYZ f32. Each following vertex contains XYZ f32
and RGBA8, grouped as unindexed triangles. Coordinates must be finite and
within ±128 units, and alpha must be 255.

At load time the host waits for the GE to finish, drops the old character
cache, and creates the selected cache. A pose retains its source asset.
Menu configuration retains only the latest weapon, opponent and count
commands; it does not accumulate commands across visits. The first round
resets ammunition from the selected configuration.

The guest receives `strike.mods` and `strike.initialMod`. `strike.selectMod`
accepts an in-range index during the menu phase, configures the next round,
and passes the selected index with `loadMap`. A host must publish only packs
it can render. There is no filesystem mod scanner or runtime code loader.
`OPENSTRIKE_INITIAL_MOD` selects the pack ID for autostart/benchmark builds;
an ordinary build still presents the menu. `--character` remains a shortcut
for a local character pack with Classic weapon tuning.

## Verification

```sh
cargo test --locked -p openstrike-core -p openstrike-character -p openstrike-mods
bun test test/strike-sdk.test.ts
bun run typecheck
OPENSTRIKE_TEST_MOD=out/mods/frieren/mod.json OPENSTRIKE_COOKED_MAPS=dist/maps \
  bun scripts/mods-psp.ts
```

The capture driver exercises mod selection, map selection, casting, returning
to Classic, switching back, and reloading through the production pad mapper.
It verifies completion and writes ten images for inspection. Set
`OPENSTRIKE_TEST_MODS` to a JSON array of manifests and
`OPENSTRIKE_TEST_MOD_INDEX` to the catalogue index to exercise a package with
three or more choices. Private assets
are not golden fixtures. `--motion-bench --mod ...` repeats menu transitions
on hardware and cycles through every packaged mod; rebuild without benchmark
flags before interactive acceptance.


Physical PSP validation at 333/166 MHz completed **10,800 frames and seven
mod/map transitions**. Switching from the 7,175-triangle character to the
1,390-triangle officer released the old cache. After warmup, repeated visits
to the same pack reached the same free-memory value. First-round ammunition
returned to 12/120 for the local example and 30/90 for Classic.

A separate Dust2 combat run captured **3,900 frames, nine hits, three kills,
28 damage events, two deaths and five round resets**. Its 300-frame windows
ranged from 56.19 to 59.74 FPS. These numbers cover that route and include
round transitions; they do not establish a locked frame rate on other maps.
The nine menu/casting captures and the three byte-exact Classic muzzle
goldens passed. The five older spawn/walk/fire golden differences described
in the local-character PR predate this change and were not rebaselined.

The Pikachu addition passed 29 Rust tests, nine tests against its generated
character, TypeScript checks and the three Classic muzzle goldens. The
projectile tests cover delayed damage, moving targets, cover for both owners,
high-speed contact, capacity, expiry and reset. Ten character captures cover
all actions, the held death pose, and three/six actors. The two pack-selection
runs each completed 780 frames, including reload completion.

On a physical PSP, the Pikachu Dust2 combat probe completed **6,000 frames**
with 12 hits, four kills, 36 damage events, three deaths and seven round
resets, at **58.14–59.75 FPS** per 300-frame window. A separate three-pack
switching run completed 15,300 frames and ten map/mod transitions. These
measurements use the same full-detail geometry budgets described above;
map loading windows are not steady-play frame-rate measurements.
