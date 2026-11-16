// Where the tools find ThreeRT on this machine. Nothing of it is in the repository: `node tools/setup.ts` (or the
// first tool run) records what it found in `.threert/paths.json` and writes `.threert/tsconfig.paths.json`, which
// tsconfig.json extends (both git-ignored).
//
//   THREERT_ENGINE=<dir>   an engine checkout (github.com/meshy-dev/ThreeRT, its renderer built for the tests and the
//                          pictures). Default: what setup recorded, else a `ThreeRT` checkout beside this one, else
//                          the engine inside the ThreeRT SDK (enough to build and typecheck, not to run the tests)
//   THREERT_SDK=<dir>      where `@threert/net` comes from (multiplayer rooms; the package the ThreeRT CLI gives every
//                          project): an installed ThreeRT's SDK (default
//                          /Applications/ThreeRT.app/Contents/Resources/sdk) or a ThreeRT client checkout; both have
//                          it at packages/net. Default: what setup recorded, else beside the engine, else the app's
//   THREERT_RENDER=<file>  the renderer binary (default <engine>/renderer/target/release/threert-render)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

export const ROOT = resolve(import.meta.dirname, "../..");
const PATHS = join(ROOT, ".threert/paths.json");
export const APP_SDK = "/Applications/ThreeRT.app/Contents/Resources/sdk";

const isEngine = (dir: string) => existsSync(join(dir, "packages/scene/src/index.ts")) && existsSync(join(dir, "packages/gameplay/src/index.ts"));
const netIn = (dir: string) => join(dir, "packages/net/src/index.ts");
const recorded = ((): { engine?: string; sdk?: string } => {
  try { return JSON.parse(readFileSync(PATHS, "utf8")); } catch { return {}; }
})();

/** The engine: the first of THREERT_ENGINE, what setup recorded, a sibling `ThreeRT` checkout, the app's SDK's engine. */
export function findEngine(given = process.env.THREERT_ENGINE): string | null {
  if (given) return isEngine(resolve(given)) ? resolve(given) : null;
  for (const dir of [recorded.engine, join(ROOT, "../ThreeRT"), join(process.env.THREERT_SDK ?? APP_SDK, "engine")]) if (dir && isEngine(dir)) return resolve(dir);
  return null;
}

/** Where `@threert/net` is: THREERT_SDK's, what setup recorded, beside the engine (a client checkout's), the app's. */
export function findNet(engine: string | null, given = process.env.THREERT_SDK): string | null {
  if (given) return existsSync(netIn(resolve(given))) ? netIn(resolve(given)) : null;
  for (const dir of [recorded.sdk, engine && join(engine, ".."), APP_SDK]) if (dir && existsSync(netIn(dir))) return netIn(resolve(dir));
  return null;
}

const engine = findEngine();
if (!engine) throw new Error(`no ThreeRT engine found: set THREERT_ENGINE to an engine checkout (github.com/meshy-dev/ThreeRT), or run node tools/setup.ts --engine <dir>`);
export const ENGINE = engine;
const net = findNet(ENGINE);
if (!net) throw new Error(`no @threert/net found: install ThreeRT (it is in ${APP_SDK}/packages/net), or set THREERT_SDK to a ThreeRT SDK or client checkout, or run node tools/setup.ts --sdk <dir>`);
/** `@threert/net`'s entry (packages/net/src/index.ts). */
export const NET = net;
export const RENDERER = process.env.THREERT_RENDER ?? join(ENGINE, "renderer/target/release/threert-render");
/** CC0 asset store of the machine (Poly Haven, Quaternius): the source `tools/assets.ts` copies from. */
export const ASSET_STORE = resolve(process.env.THREERT_ASSETS ?? join(ENGINE, "../../threert-assets"));

// The SDK's esbuild package has no binary of its own: it is the SDK's bin/esbuild.
if (!existsSync(join(ENGINE, "node_modules/@esbuild")) && existsSync(join(ENGINE, "../bin/esbuild"))) process.env.ESBUILD_BINARY_PATH ??= join(ENGINE, "../bin/esbuild");

/** `require` as the engine's checkout resolves it (esbuild, earcut, sharp live in its node_modules). */
export const engineRequire = createRequire(join(ENGINE, "package.json"));

/** The typecheck's paths for this machine: `.threert/tsconfig.paths.json`, which tsconfig.json extends. */
export function tsconfigPaths(): object {
  const types = (name: string, file: string) => (existsSync(join(ENGINE, "node_modules", name)) ? { [name]: [join(ENGINE, "node_modules", name, file)] } : {});
  return {
    extends: join(ENGINE, "tsconfig.base.json"),
    compilerOptions: {
      typeRoots: [join(ENGINE, "node_modules/@types")],
      paths: {
        "@threert/scene": [join(ENGINE, "packages/scene/src/index.ts")],
        "@threert/gameplay": [join(ENGINE, "packages/gameplay/src/index.ts")],
        "@threert/net": [NET],
        ...types("esbuild", "lib/main.d.ts"),
        ...types("sharp", "lib/index.d.ts"),
      },
    },
  };
}

/**
 * Writes `.threert/tsconfig.paths.json` when it says something else, and `.threert/paths.json` (what later runs
 * default to) when there is none or `record`.
 */
export function writeSetup(record = false): { engine: string; net: string; changed: boolean } {
  mkdirSync(join(ROOT, ".threert"), { recursive: true });
  const sdk = resolve(NET, "../../../..");
  let changed = false;
  const put = (file: string, text: string) => {
    if (existsSync(file) && readFileSync(file, "utf8") === text) return;
    writeFileSync(file, text);
    changed = true;
  };
  if (record || !existsSync(PATHS)) put(PATHS, JSON.stringify({ engine: ENGINE, sdk }, null, 2) + "\n");
  put(join(ROOT, ".threert/tsconfig.paths.json"), JSON.stringify(tsconfigPaths(), null, 2) + "\n");
  return { engine: ENGINE, net: NET, changed };
}

// (Every tool keeps the typecheck's paths in step with what it uses.)
writeSetup();
