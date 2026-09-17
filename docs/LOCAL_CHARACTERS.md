# Local PSP characters

**The PSP host accepts a local baked character through `--character`.** The
checked-in police officer remains the default. The selected asset changes bot
presentation and attack origins; the shared AI, damage, collision and movement
rules stay in `openstrike-core`.

## Bake the Pocket Openworld character

The importer takes the GLB already used by Pocket Openworld. It keeps its
triangle topology, UVs and opaque atlas, then samples its skinned actions into
quantized poses. Blender is a build tool; the PSP runs no armature solver or
GLB decoder.

```sh
/Applications/Blender.app/Contents/MacOS/Blender \
  --background --factory-startup --python-exit-code 1 \
  --python scripts/bake-character.py -- \
  --source /path/to/pocket-openworld/assets/character/frieren.glb \
  --output out/local-character/character.opch

bun scripts/psp.ts --release --package \
  --character out/local-character/character.opch \
  --cooked-maps /path/to/maps
```

The source profile requires `Idle`, `Walk`, `Cast`, `Water`, `staff.tip`, and
`staff.R`.
It maps Walk to Walk/Run, Cast to Fire, and Water to Reload. Hit adds recoil;
Death adds a backward fall and grounds the body and dropped staff as separate
parts. `--socket`, `--grip`, and `--drop-mesh` select the attack socket, grip
bone, and dropped mesh.
The output JSON records source/output hashes, geometry counts, cache size and
60 Hz interpolation error. Export fails above two game units of error for the
70-unit character. **No triangle reduction is applied.**

The current Pocket Openworld source has a private-use restriction in its
character README. Keep its GLB, derived OPCH, textures, screenshots and
model-bearing EBOOT files in local ignored output. The public repository
contains the importer and renderer, not that character's data.

## Memory and drawing

**Local-character EBOOT packages request the extended memory of PSP-2000 and
later models through `PARAM.SFO`'s `MEMSIZE=1`.** This matches the memory available
in the development PSPLINK session. The full-detail Openworld asset is not a
PSP-1000 configuration. The default officer package keeps its existing metadata.

The character crate validates the complete asset during the build: format,
indices, seven clips, frame ranges, finite sockets, atlas dimensions and a
16 MiB ceiling for the shared morph cache. PSP texturing uses one 128×128 atlas
for the current source, u16 UVs, indexed triangles and GE two-frame morphing.
Each visible actor submits one draw. Pose/texture/index buffers are allocated
and flushed at startup, then shared across actors without per-frame uploads.

`OPENSTRIKE_CHARACTER_ASSET=/absolute/path/character.opch` selects the same
asset for Cargo tests and scripts. Other platform renderers retain their
existing default officer path; textured local assets are a PSP feature.

## Validation

```sh
OPENSTRIKE_CHARACTER_ASSET=/absolute/path/character.opch \
  cargo test --locked -p openstrike-character

OPENSTRIKE_CHARACTER_ASSET=/absolute/path/character.opch \
OPENSTRIKE_COOKED_MAPS=/path/to/maps \
  bun scripts/character-psp.ts

# Hardware rendering load: one, three, six visible actors, 30 seconds each.
bun scripts/psp.ts --release --character-bench --map de_dust2 \
  --character out/local-character/character.opch --cooked-maps /path/to/maps

# Hardware gameplay: actual bot AI, collision, shooting, damage and round resets.
bun scripts/psp.ts --release --combat-bench --map de_inferno \
  --character out/local-character/character.opch --cooked-maps /path/to/maps
```

The capture harness checks seven actions, the held corpse, and three/six
actors. Capture-only phase offsets avoid rendering thousands of setup frames;
hardware benchmarks retain the full timed sweep. PPSSPP images establish
rendering and liveness. **Frame-rate claims require physical PSP measurements.**
Build the ordinary package again before handing controls back to a player;
capture builds exit, and benchmark builds inject input or stage actors.
