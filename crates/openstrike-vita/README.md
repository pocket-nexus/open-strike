# OpenStrike for PS Vita

`openstrike-vita` packages the complete OpenStrike product as a native VPK:
the shared Rust simulation, cooked Pocket3D worlds, the normal PocketJS
QuickJS guest, and the unchanged Solid JSX rules/HUD bundle.

The Vita host renders Pocket3D first and the PocketJS HUD over the same
vita2d scene. PocketJS keeps its 480x272 logical viewport, maps that layout to
the native 960x544 framebuffer, and rasterizes text, curves and rounded corners
at 2x density. The frame loop advances the shared 60 Hz simulation with
interpolation. Local packs select indexed character geometry, textures,
weapons and shared muzzle/energy effects.

## Toolchain and build

The pinned development setup is VitaSDK, `cargo-vita` 0.2.2 and Rust nightly
`2026-05-28` with `rust-src`. Vita3K is used for emulator E2E.

```sh
export VITASDK="$HOME/vitasdk"
export PATH="$VITASDK/bin:$HOME/.cargo/bin:$PATH"

OPENSTRIKE_MAPS=~/path/to/cs-maps bun scripts/vita.ts --release
# dist/vita/OpenStrike.vpk
```

`scripts/vita.ts` validates `pocket.json` against the Vita capability profile,
compiles the product JS/pak from its resolved plan, verifies the plan checksum,
and projects stable target, host ABI and viewport inputs for the Pocket host.
It then cooks supplied BSPs, or validates `OPENSTRIKE_COOKED_MAPS`, and invokes
the pinned Rust toolchain. `--mod manifest.json` adds a validated local pack.
PocketJS's shared final packer overlays the staged `.p3d` catalogue and
committed OpenStrike icon on the framework's complete black LiveArea asset set;
Cargo metadata does not maintain a second packaging path. Map and WAD data is
not committed or redistributed. The custom host requires PocketJS Vita Host
ABI 2 at build time and keeps the stable Vita title id `OPSK00001`, so
installing another PocketJS demo does not replace OpenStrike or its LiveArea
bubble.

## Wired development

USB debugging is enabled in default builds. `--no-usb-debug` excludes the
driver and builds a safe SELF. The VPK contains the pinned driver from
PocketJS; no persistent plugin configuration is needed.

```sh
bun run vita:dev install --mount /Volumes/PSV
# Install ux0:data/pocketjs-dev/openstrike.vpk in VitaShell and open OpenStrike.
bun run vita:dev serve
# In another terminal:
bun run vita:dev status
bun run vita:dev push
bun run vita:dev capture
bun run vita:dev reload
bun run vita:dev reset
bun run vita:dev native
```

The game uses PocketJS's USB protocol, admission checks and native A/B slots.
Its guest lifecycle registers the strike surface before each evaluation,
retires map/character GPU resources after the scene completes, and restores
the previous bundle if evaluation or the first frame fails. Reloading returns
to the game menu. The debug overlay pauses gameplay and consumes its controls.
USB status adds map, loadout, health, ammo and a rolling frame-time window.
Build metadata and SELF hashes bind the host tools to this standalone title.

See [PocketJS wired development](../../vendor/pocketjs/docs/VITA-USB.md) for
USB ownership, reconnect semantics and recovery.

## Controls

| Input | Action |
| --- | --- |
| Left stick | Move |
| Right stick | Look |
| R | Fire |
| L | Jump |
| D-pad down | Reload |
| D-pad up | Walk |
| SELECT | Open or close the return-to-menu dialog |
| L + R + SELECT | Open or close native USB debugging |
| D-pad + Circle | Navigate and confirm menus |

No gameplay or menu flow depends on the touchscreen.

## Vita3K golden E2E

```sh
bun run test:e2e:vita
VITA_E2E_SPEC=spawn bun run test:e2e:vita
```

The driver builds capture VPKs, installs each into an isolated VitaFS, boots
the real QuickJS/input/simulation/render loop, waits for its `done` marker,
and terminates only the spawned emulator. Every selected capture must be a
960x544 RGBA frame with native-density detail and must match
`test/goldens-vita` byte-for-byte. The native-detail assertion rejects a
regression to a 480x272 frame duplicated into 2x2 pixel blocks. A scene sidecar
additionally requires positive visible-face, world-triangle,
submitted-triangle, and draw-call counts from the native `pocket3d-vita` pass.

Current Vita3K macOS Vulkan builds do not expose a coherent presented color
buffer back to guest memory. The pixel oracle therefore uses PocketJS's
deterministic DrawList rasterizer for the HUD, while the native scene counters
guard the 3D pass. Capture builds park after `done`; this avoids a Vita3K GXM
teardown crash in `sceKernelExitProcess`. Production VPKs are unaffected.
