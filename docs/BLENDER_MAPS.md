# Blender maps

**A closed convex mesh becomes one BSP brush.** The exporter applies object
transforms and evaluated modifiers, checks manifold edges and face planes,
then writes a Valve 220 `.map`. SDHLT produces a GoldSrc BSP v30 with embedded
textures, collision hulls, visibility and baked lighting. Pocket3D cooks that
BSP into the `.p3d` consumed by PSP. The desktop build can open the BSP.

```sh
# Requires Blender, Bun, CMake, a C++17 compiler and the normal Rust toolchain.
bun scripts/blender-map.ts --demo --stage

# Export an edited or new scene.
bun scripts/blender-map.ts --blend scene.blend --out out/my-map --stage

# Compile with an existing SDHLT installation.
bun scripts/blender-map.ts --blend scene.blend --sdhlt-dir /path/to/tools
```

The bootstrap pins `seedee/SDHLT` to the revision in `scripts/blender-map.ts`.
`scripts/sdhlt-portable.patch` adapts its C library declarations and string
logging for Clang, enables POSIX extent calculation on macOS, and bounds
32-bit compression shifts. The original extent and compression self-tests
remain enabled. C++17 and disabled strict aliasing preserve its transfer-data
representation. Source, binaries and build logs live in
ignored `.pocket/toolchains/`. `BLENDER` or `--blender` selects Blender.

Object custom properties:

| Property | Value | Result |
| --- | --- | --- |
| `bsp_role` | `world` | Structural solid; default for meshes |
| `bsp_role` | `detail` | Solid detail brush merged into the world BSP |
| `bsp_role` | `solid` | Separate static brush hull; collision without splitting the world |
| `bsp_role` | `decor` | Non-solid visual brush model; no collision or world splits |
| `bsp_role` | `entity` | Point entity at the object's world position |
| `bsp_role` | `ignore` | Preview object; omitted from the map |
| `bsp_fit` | `true` | Fit the material image once across each brush face |
| `bsp_classname` | `info_player_start`, `light`, etc. | Point entity class |
| `bsp_angle`, `bsp__light`, etc. | String or number | Entity key without the `bsp_` prefix |

**One Blender metre equals 32 map units.** BSP coordinates keep Blender's Z-up
axes; Pocket3D converts them to Y-up on load. Spawn markers identify standing
hull centres, 36 units above the floor. Meshes must be closed and convex;
split concave rooms into floor, wall and ceiling brushes. Unsupported meshes
fail with the object's name. Lights and cameras without entity properties
are preview objects.

Materials use a base color or one image texture. Bake other shader graphs to
images before export. The exporter writes WAD textures with palettes and four mip levels.
`bsp_size` selects a square power-of-two size from 16 to 512; the default is 64. Texture names need 1–15 ASCII characters; `bsp_texture`
can override the Blender material name. `bsp_scale` controls world-aligned
mapping (default `0.5`, a one-metre tile). Arbitrary Blender UV mapping is not
exported. Names beginning with `{` use palette-index transparency. Sparse
glass uses a cutout pattern because the runtime has no translucent BSP pass.

The tool writes `.blend`, `.map`, `.wad`, `.bsp`, `.p3d`, logs and hash receipts
under ignored output. **Generated binaries and source video stay outside Git.**
`--stage` copies the cooked map into `dist/maps`; package that directory with
`bun scripts/psp.ts --release --package --cooked-maps dist/maps`.

## WWDC24 route

The reference is Apple's [WWDC24 keynote](https://developer.apple.com/videos/play/wwdc2024/101/),
the iPadOS-to-macOS transition around **50:40–50:57**. The authored scene joins
the upper atrium bridge, opposing stair flights and ground-floor presentation
hall shown in that sequence. Dimensions and connections between camera cuts
are inferred. Gardens, rear galleries, cover and spawn positions are authored
for play; this is not an architectural survey of the entire Apple Park.

`scripts/build-parkour.py` creates the editable scene, packed material images
and a route through the stairs. The route validator uses the game's standing
hull, gravity, friction and step law in both directions:

```sh
cargo run -p openstrike-core --example verify_map_route -- \
  out/parkour/wwdc24-parkour.p3d out/parkour/route.txt

"$BLENDER" --background --factory-startup --python-exit-code 1 \
  --python test/blender-map-fixture.py -- out/blender-fixture
```

The scene has two player spawns and three opponent spawns. Bot distribution
visits each available spawn before reusing one. The encounter check uses
these positions, the map collision and real damage, without moving opponents:

```sh
cargo run -p openstrike-core --example verify_bot_encounter -- \
  out/parkour/wwdc24-parkour.p3d
```

On PSP choose **SOLO VS BOTS → loadout → AP WWDC24 → ○ DEPLOY**.
This path needs neither Companion nor a network connection. SELECT returns
to the previous selection page; the pause menu returns from a match.

`--detail 1..4` selects authored detail density. `--subdivide 16..256` controls
the maximum vertex-light grid spacing in map units. `--no-preview` skips the
Blender beauty render. These options change the generated assets, not the
PSP display resolution. `scene.json`, `tour.txt`, `route.txt` and `build.json`
record the preset, camera positions, walking route and asset hashes.

The demo defaults to **detail 4 and a 128-unit lighting grid**. PSP builds use
480×272 RGB565 with ordered dithering. `--framebuffer32` selects RGBA8888 for
comparison. The smaller display buffers leave 1,261,568 bytes of the 2 MiB
eDRAM for immutable map textures and geometry. Assets that do not fit remain
in main memory; the cache never exceeds the host-provided region.

Scene properties `bsp_pocket_sky_zenith` and `bsp_pocket_sky_horizon` each
contain three color channels in `[0,1]`. The exporter writes them into
worldspawn; the optional P3D sky section retains them for PSP and the web.
Maps without these properties retain the renderer's default sky.

## Device measurements

```sh
bun scripts/hw.ts --release --map-bench --tour out/parkour/tour.txt \
  --map wwdc24-parkour --cooked-maps dist/maps --daemon
bun scripts/bench-report.ts path/to/OpenStrike-bench.jsonl --tour --min-fps 55

bun scripts/hw.ts --release --encounter-bench \
  --map wwdc24-parkour --cooked-maps dist/maps --daemon
```

The map tour rotates through ten positions with the normal simulation and
HUD running. After 300 warm-up frames it measures 6,000 frames. Results stay
in RAM until all 20 windows finish; file writes and screenshots do not run
inside the measured interval. The encounter probe uses authored spawns and
scripts aim, fire and reload. Bot AI, collision, damage and round rules remain
active. **These probes are excluded from the normal package.**

Compare measured fps, missed display refreshes, long frame intervals and
combat events. `--max-late 0` adds a zero-long-frame gate. GPU synchronization
wait is the unfinished portion of the preceding draw, not total GPU time.
A measured stress-preset failure establishes a limit for that workload; it
does not prove an absolute hardware maximum for every possible renderer.
Use one PSPLINK bridge and disable the DevTools mailbox during benchmarks.

## Static map explorer

```sh
bun scripts/build-map-site.ts \
  --bsp out/parkour/wwdc24-parkour.bsp \
  --psp-map out/parkour/wwdc24-parkour.p3d \
  --scene out/parkour/scene.json --subdivide 128 --out dist/map-site
bun scripts/serve-map-site.ts dist/map-site 4174
```

**The web exporter reads the same cooked geometry, vertex lighting and
textures as PSP.** `--psp-map` requires a byte-identical cook before export.
`--scene` supplies named viewpoints and presentation copy; without it, the
viewer starts at the BSP's player spawns. The output is a directory of HTML,
CSS, JavaScript and binary assets, with no external dependencies or server
runtime. Serve the directory over HTTP or upload it to a static host.

WebGL 2 draws the map. Drag to look, use WASD to move and Q/E to change height;
viewpoint buttons restore authored camera positions. This page is a free
camera viewer, not a browser port of the game. It includes the source BSP
download. Generated output stays under ignored `dist/`; the reusable viewer
and exporter sources are committed under `site/map-viewer` and `scripts`.
