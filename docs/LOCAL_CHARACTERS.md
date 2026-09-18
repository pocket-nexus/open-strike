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
The atlas uses the PSP's 16-byte by 8-row tile layout. Swizzling reorders
the bytes at startup and preserves every RGBA texel.

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
Normal benchmarks write one summary per 300 frames. `--bench-spikes` enables
per-frame diagnostic writes to USB and Memory Stick; those writes add stalls
and are excluded from frame-rate acceptance runs.

For a distance comparison, `--proximity-bench` keeps one walking actor and a
fixed camera. Set `OPENSTRIKE_PSP_PROBE_DISTANCE` to the distance in world units
(default 36, bounded to 32–400). This mode skips simulation. `--approach-bench`
uses player movement to approach and retreat under bot fire; collision, AI,
damage, deaths and guest round resets remain active. Bot count comes from the
guest configuration. **Compare the same map and camera before attributing a
frame-rate change to character distance.**

Benchmark summaries split the UI work into `avg_hud_script_us` (the HUD callback,
included in `avg_js_us`), `avg_ui_draw_us` (DrawList construction) and
`avg_ui_ge_us` (UI command submission). `avg_dispatch_us` covers native state
publication and game tick subscribers; `avg_js_us` covers the whole framework
frame turn. These are microseconds per rendered frame, so multiple simulation
ticks increase the dispatch and script totals. `avg_gpu_us` measures the wait at
GE synchronization, not the GPU execution time of the HUD or character.

Build the ordinary package again before handing controls back to a player;
capture builds exit, and benchmark builds inject input or stage actors.

## Single-character PSP measurements

A physical PSP at 333/166 MHz rendered the full-detail local Openworld asset
(7,175 triangles, 5,532 vertices, 128×128 atlas). The distance probe holds the
camera and walking pose schedule fixed; the near/far Inferno runs submit the
same 18,303 world triangles per frame.

| Rendering probe | Distance | Warm frames | Observed FPS |
| --- | ---: | ---: | ---: |
| Dust2, before dispatch/texture changes | 36 | 1,500 | 59.66 |
| Dust2, after changes | 36 | 1,500 | 59.70 |
| Inferno, after changes | 36 | 900 | 29.92 |
| Inferno, after changes | 185 | 900 | 29.90 |

Rows use the first complete windows after the 300-frame startup window.
State publication and tick callbacks on Dust2 fell from 2.137 to 1.132 ms per
frame. Fixed state keys are interned once, tick subscriber snapshots rebuild
on subscription changes, and the menu signal updates on phase transitions.
Snapshots remain separate objects; subscription changes take effect on the
next dispatch snapshot.

On the optimized Dust2 probe, the HUD callback took 0.299 ms, DrawList building
1.384 ms, and UI GE submission 0.168 ms. Including state dispatch, the whole
framework frame turn and core tick gives 4.818 ms; the HUD callback is already
part of the framework turn and must not be counted twice. Inferno executes
about two simulation/guest ticks per rendered frame at 30 FPS. Its per-frame
script time therefore cannot be compared with a 60 FPS frame as if both ran
one tick.

**These routes do not reproduce a distance-specific stall.** Inferno remains
limited to about 30 FPS at this busy viewpoint at both tested distances.
The results do not establish a locked frame rate at other viewpoints or rule
out a stall during manual play. Profiling uses summary logging; the playable
package contains no benchmark input or log writes.
