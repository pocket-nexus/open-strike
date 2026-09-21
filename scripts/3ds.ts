import { $ } from "bun";
import {
  cpSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { resolve, relative } from "node:path";
import { createHash } from "node:crypto";
import { availableParallelism } from "node:os";
import { resolve3dsBuildPlan } from "../vendor/pocketjs/tools/3ds-profile.ts";
import {
  build3ds,
  captureDefines,
  runtimeSlot,
} from "../vendor/pocketjs/tools/3ds.ts";
import {
  ensureQuickJs,
  runContainer,
  THREE_DS_CONTAINER_IMAGE,
} from "../vendor/pocketjs/tools/3ds-toolchain.ts";
import {
  extractHostBuildInputs,
  hostBuildEnvironment,
} from "@pocketjs/framework/manifest";
import { rasterizeIconSvg } from "../vendor/pocketjs/tools/icon-raster.ts";

const root = resolve(import.meta.dir, "..");
const framework = resolve(root, "vendor/pocketjs");
const crate = resolve(root, "crates/openstrike-3ds");
export const MAP_NAMES = [
  "cs_assault",
  "cs_office",
  "de_aztec",
  "de_dust",
  "de_dust2",
  "de_inferno",
  "de_nuke",
  "de_train",
] as const;
type Manifest = { app: Record<string, unknown>; [key: string]: unknown };

export async function render3dsIcons() {
  const svg = readFileSync(resolve(crate, "icon.svg"), "utf8");
  return Promise.all(
    [48, 24].map(async (size) => ({
      size,
      canvas: await rasterizeIconSvg(svg, size),
      name: size === 48 ? "icon.png" : "icon-small.png",
    })),
  );
}

export function threeDsManifest(source: Manifest) {
  return {
    ...source,
    app: {
      ...source.app,
      entry: ".pocket/3ds-dev/openstrike.tsx",
      viewport: { fixed: { logical: [400, 240], presentation: "native" } },
      surfaces: {
        auxiliary: { fixed: { logical: [320, 240], presentation: "native" } },
      },
    },
  };
}

/** Patch an isolated copy of the pinned host. Never mutate vendor/pocketjs.
 * A mismatching upstream host fails git apply rather than dropping hooks. */
export async function prepareHost() {
  const host = resolve(root, ".pocket/3ds-dev/host");
  rmSync(host, { recursive: true, force: true });
  mkdirSync(host, { recursive: true });
  for (const name of ["src", "include", "Makefile", "app.rsf"])
    cpSync(resolve(framework, "hosts/3ds", name), resolve(host, name), {
      recursive: true,
    });
  cpSync(resolve(framework, "hosts/shared"), resolve(host, "../shared"), {
    recursive: true,
  });
  await $`git apply --directory=${relative(root, host)} ${crate}/host.patch`.cwd(
    root,
  );
  copyFileSync(resolve(crate, "extension.h"), resolve(host, "src/extension.h"));
  return host;
}

export async function build(argv = process.argv.slice(2)) {
  await $`bun scripts/ensure-pocketjs-generated.ts`.cwd(root);
  for (const flag of argv)
    if (!["--capture", "--pocket-only"].includes(flag))
      throw new Error(`Unknown 3DS option: ${flag}`);
  if (argv.includes("--capture") && argv.includes("--pocket-only"))
    throw new Error("Choose a capture or a guest-only build");
  const capture = argv.includes("--capture");
  const generated = resolve(root, ".pocket/3ds-dev");
  const out = resolve(root, capture ? "dist/3ds/capture" : "dist/3ds");
  const guest = resolve(root, "dist/pocket/3ds-dev");
  mkdirSync(generated, { recursive: true });
  mkdirSync(out, { recursive: true });
  const manifest = threeDsManifest(
    JSON.parse(readFileSync(resolve(root, "pocket.json"), "utf8")),
  );
  writeFileSync(
    resolve(generated, "pocket.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  writeFileSync(
    resolve(generated, "openstrike.tsx"),
    'import "../../game/openstrike.tsx";\n',
  );
  const plan = resolve3dsBuildPlan(manifest);
  const planPath = resolve(generated, "plan.json");
  writeFileSync(planPath, JSON.stringify(plan, null, 2) + "\n");
  const inputs = extractHostBuildInputs(plan, { expectedTarget: "3ds-dev" });
  await build3ds([
    `--plan=${planPath}`,
    `--project-root=${root}`,
    `--outdir=${guest}`,
    `--package-outdir=${out}`,
    "--pocket-only",
  ]);
  if (argv.includes("--pocket-only")) return;
  const maps = resolve(
    process.env.OPENSTRIKE_COOKED_MAPS ?? resolve(root, "dist/maps"),
  );
  for (const name of MAP_NAMES) {
    const path = resolve(maps, `${name}.p3d`);
    if (!existsSync(path))
      throw new Error(
        `Missing cooked map ${path}; supply OPENSTRIKE_COOKED_MAPS (see README)`,
      );
    await $`cargo run --release --locked -q -p pocket3d-cook -- --verify-cooked ${path}`.cwd(
      resolve(framework, "engine/pocket3d"),
    );
  }
  const host = await prepareHost();
  const toolchain = readFileSync(
    resolve(framework, "hosts/3ds/core/rust-toolchain.toml"),
    "utf8",
  ).match(/channel\s*=\s*"([^"]+)"/)?.[1];
  if (!toolchain) throw new Error("Missing PocketJS 3DS Rust toolchain pin");
  // Only the classic pack is exposed until this renderer supports all mod meshes.
  await $`rustup run ${toolchain} cargo build --release --locked --manifest-path ${crate}/Cargo.toml --target armv6k-nintendo-3ds -Zbuild-std=core,alloc,compiler_builtins -Zbuild-std-features=compiler-builtins-mem --features embedded-map-catalog`
    .cwd(root)
    .env({
      ...process.env,
      ...hostBuildEnvironment(inputs, {
        outputDirectory: guest,
        embedApp: true,
      }),
      OPENSTRIKE_MOD_PACKS: "[]",
      OPENSTRIKE_INITIAL_MOD: "classic",
      OPENSTRIKE_CHARACTER_ASSET: "",
      OPENSTRIKE_3DS_MAPS: MAP_NAMES.join(","),
      OPENSTRIKE_3DS_DATA_ROOT: "sdmc:/3ds/OpenStrike/maps",
    });
  const mounts = [{ hostPath: root, containerPath: "/app" }];
  const containerPath = (path: string) => `/app/${relative(root, path)}`;
  const image =
    await $`docker image inspect --format '{{.Id}}' ${THREE_DS_CONTAINER_IMAGE}`.text();
  const quickjs = resolve(root, ".pocket/3ds-dev/quickjs");
  await ensureQuickJs(quickjs, image.trim(), mounts);
  const tape = capture
    ? captureDefines(process.env)
    : { input: "", touch: "", start: "", count: "" };
  const output = resolve(out, "openstrike.3dsx");
  // Generate both SMDH sizes from the canonical SVG on every native build.
  // A stale PNG previously shipped only the dark background in Homebrew Launcher.
  for (const icon of await render3dsIcons())
    writeFileSync(resolve(generated, icon.name), icon.canvas.toBuffer("image/png"));
  await runContainer(
    `make -f /app/crates/openstrike-3ds/Makefile -j${availableParallelism()}`,
    mounts,
    containerPath(host),
    {
      ...hostBuildEnvironment(inputs, {
        outputDirectory: containerPath(guest),
        embedApp: true,
      }),
      POCKETJS_CORE_LIB: containerPath(
        resolve(
          crate,
          "target/armv6k-nintendo-3ds/release/libopenstrike_3ds.a",
        ),
      ),
      POCKETJS_QUICKJS_DIR: containerPath(quickjs),
      POCKETJS_APP_POCKET: containerPath(resolve(out, "openstrike.pocket")),
      POCKETJS_RUNTIME_SLOT: runtimeSlot(plan.app.id),
      POCKETJS_BUILD_DIR: `/app/.pocket/3ds-dev/${capture ? "capture" : "release"}`,
      POCKETJS_OUT_3DSX: containerPath(output),
      POCKETJS_SMDH_TITLE: plan.app.title,
      POCKETJS_SMDH_AUTHOR: plan.app.id,
      POCKETJS_SMDH_DESC: "OpenStrike tactical FPS",
      ICON: containerPath(resolve(generated, "icon.png")),
      SMALL_ICON: containerPath(resolve(generated, "icon-small.png")),
      POCKETJS_CAPTURE: capture ? "1" : "",
      POCKETJS_CAPTURE_INPUT: tape.input,
      POCKETJS_CAPTURE_TOUCH: tape.touch,
      POCKETJS_CAP_START: tape.start,
      POCKETJS_CAP_N: tape.count,
      POCKETJS_OFFLOAD: "",
      POCKETJS_MEDIA: "",
      POCKETJS_OUT_CIA: "",
    },
    "OpenStrike 3DS native host",
  );
  if (!existsSync(output)) throw new Error("Missing 3DSX output");
  if (capture) return;
  const stage = resolve(out, "sd/3ds/OpenStrike");
  mkdirSync(resolve(stage, "maps"), { recursive: true });
  copyFileSync(output, resolve(stage, "OpenStrike.3dsx"));
  for (const name of MAP_NAMES)
    copyFileSync(
      resolve(maps, `${name}.p3d`),
      resolve(stage, "maps", `${name}.p3d`),
    );
  const files = [
    "OpenStrike.3dsx",
    ...MAP_NAMES.map((name) => `maps/${name}.p3d`),
  ].map((path) => {
    const bytes = readFileSync(resolve(stage, path));
    return {
      path,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  });
  const pocketjs = (await $`git -C ${framework} rev-parse HEAD`.text()).trim();
  writeFileSync(
    resolve(out, "build.json"),
    JSON.stringify(
      {
        capture: false,
        app: plan.app.id,
        pocketjs,
        hostAbi: plan.target.hostAbi,
        files,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(`OpenStrike 3DS SD package: ${stage}`);
}
if (import.meta.main) await build();
