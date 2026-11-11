# OpenStrike domain compiler and renderers

OpenStrike owns GoldSrc/BSP semantics, visibility and collision, the `.p3d`
format, map cooking and target rendering. These MIT sources moved from PocketJS
`engine/pocket3d` (baseline `c031bf992c366918ca70e09dd7bd5d4326aa928b`);
crate names stay stable during migration. There is one implementation here,
not a synchronized copy in PocketJS.

| Crate | Ownership |
| --- | --- |
| `pocket3d-bsp` | BSP/WAD import, PVS, collision, `.p3d` reader and cooker |
| `pocket3d-cook` | Host CLI with verification |
| `pocket3d-gu` | GE map, mesh and sky renderer |
| `pocket3d-vita` | GXM BSP renderer and shaders |
| `pocket3d-gles2` | Constrained native GLES2 map renderer |
| `gu-demo` | PSP renderer bring-up utility (`bun scripts/gu-demo.ts`) |

`Cargo.toml` owns the host compiler workspace. Target crates remain standalone
so platform toolchains do not contaminate host builds. The desktop BSP-to-wgpu
adapter is in `crates/openstrike/src/bsp_world.rs`. The generic desktop widget,
mesh, animation and VRM consumers stay in PocketJS.

The pinned PocketJS `devices/` tree supplies thin GXM, GE and PICA mechanisms.
OpenStrike still owns materials, visibility, draw ordering, frame submission
and retirement. There is no PlaceIR/BSP super-format or portable GPU layer.

```sh
cargo test --locked --manifest-path domain/Cargo.toml
cargo check --locked --manifest-path domain/Cargo.toml -p pocket3d-bsp --no-default-features --features libm
cargo test --locked --manifest-path domain/crates/pocket3d-vita/Cargo.toml
cargo test --locked --manifest-path domain/crates/pocket3d-gles2/Cargo.toml
cargo run --release --locked --manifest-path domain/Cargo.toml -p pocket3d-cook -- --verify-cooked /path/to/map.p3d
```

Native and physical validation still runs through the application's existing
`scripts/psp.ts`, `vita.ts`, `3ds.ts` and `ipodtouch4.ts` workflows. Captures and
receipts belong under ignored `.pocket-build/validation/`.
