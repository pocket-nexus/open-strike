// Finds ThreeRT on this machine for the tools and the typecheck, and says what it found: the engine (the toolchain,
// the renderer the tests run the game in) and `@threert/net` (from an installed ThreeRT's SDK or a client checkout).
// Writes `.threert/paths.json` and `.threert/tsconfig.paths.json` (git-ignored; tsconfig.json extends the second).
// Every tool does this on its own when it starts; run it after moving things, or to choose them:
//
//   node tools/setup.ts [--engine <engine checkout>] [--sdk <ThreeRT SDK or client checkout>]
import { existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const flag = (k: string) => (args.includes(k) ? resolve(args[args.indexOf(k) + 1]!) : undefined);
// (What was recorded before is not a default when a place is given.)
if (flag("--engine")) process.env.THREERT_ENGINE = flag("--engine");
if (flag("--sdk")) process.env.THREERT_SDK = flag("--sdk");
if (flag("--engine") || flag("--sdk")) rmSync(join(resolve(import.meta.dirname, ".."), ".threert/paths.json"), { force: true });

const { ENGINE, NET, RENDERER, writeSetup } = await import("./lib/engine.ts");
const r = writeSetup(true);
console.log(`engine        ${ENGINE}`);
console.log(`@threert/net  ${NET}`);
console.log(`renderer      ${existsSync(RENDERER) ? RENDERER : `none at ${RENDERER}: building and the typecheck work, the tests and pictures need it (cargo build --release in the engine's renderer/)`}`);
void r;
console.log("recorded in .threert/paths.json; the typecheck's paths are .threert/tsconfig.paths.json (tsconfig.json extends it)");
