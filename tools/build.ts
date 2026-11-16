// Bundles the game for the engine's runtime: game code + @threert/scene + @threert/gameplay + the node host (as the
// engine's tools/bundle-game.ts does), and `@threert/net` from the ThreeRT SDK this machine has (lib/engine.ts), as the
// ThreeRT CLI resolves it for every project (`threert dev`, `threert publish` bundle the game themselves).
//
//   node tools/build.ts [-o out/openstrike.js] [--entry game.ts] [--maps <index.ts>]
// `--maps`: another list of imported maps in place of maps/index.ts (the importer's test, tools/test-maps.ts).
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { ENGINE, NET, ROOT, engineRequire } from "./lib/engine.ts";

export const BUNDLE = join(ROOT, "out/openstrike.js");

export async function build(out = BUNDLE, entry = join(ROOT, "game.ts"), maps?: string): Promise<{ out: string; bytes: number; ms: number }> {
  const esbuild = engineRequire("esbuild") as typeof import("esbuild");
  const t0 = performance.now();
  const result = await esbuild.build({
    stdin: {
      contents: [
        `import mod from ${JSON.stringify(resolve(entry))};`,
        `import { installNodeHost } from "@threert/gameplay";`,
        `installNodeHost(mod);`,
      ].join("\n"),
      resolveDir: ROOT,
      sourcefile: "threert-node-entry.js",
    },
    bundle: true,
    alias: {
      "@threert/scene": join(ENGINE, "packages/scene/src/index.ts"),
      "@threert/gameplay": join(ENGINE, "packages/gameplay/src/index.ts"),
      "@threert/net": NET,
    },
    nodePaths: [join(ENGINE, "node_modules")],
    plugins: maps ? [{
      name: "imported-maps",
      setup(b) {
        const index = join(ROOT, "maps/index.ts");
        b.onResolve({ filter: /maps\/index\.ts$/ }, (a) => (resolve(a.resolveDir, a.path) === index ? { path: resolve(maps) } : null));
      },
    }] : [],
    format: "iife",
    platform: "neutral",
    target: "es2022",
    minifySyntax: true,
    legalComments: "none",
    write: false,
    logLevel: "warning",
  });
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, result.outputFiles[0]!.text);
  return { out, bytes: result.outputFiles[0]!.contents.length, ms: performance.now() - t0 };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const flag = (k: string) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
  const r = await build(flag("-o") ? resolve(flag("-o")!) : undefined, flag("--entry") ? resolve(flag("--entry")!) : undefined, flag("--maps"));
  console.log(`${r.out.replace(ROOT + "/", "")}: ${(r.bytes / 1024).toFixed(0)} KiB, ${r.ms.toFixed(0)} ms`);
}
