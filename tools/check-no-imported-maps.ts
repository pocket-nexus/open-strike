// The guard of the publish path: imported maps are copies of copyrighted maps and must never be published
// (docs/MAPS.md). Exits 1, and says what is there and how to take it out, when the project holds any.
//
//   node tools/check-no-imported-maps.ts [project dir]
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** What a project holds that an imported map leaves behind; empty when it is clean. */
export function importedMapFiles(project: string): string[] {
  const found: string[] = [];
  const maps = join(project, "maps");
  if (existsSync(maps)) {
    for (const entry of readdirSync(maps, { withFileTypes: true })) {
      if (entry.isDirectory()) found.push(`maps/${entry.name}/`);
      else if (entry.name !== "index.ts") found.push(`maps/${entry.name}`);
    }
    const index = join(maps, "index.ts");
    if (existsSync(index) && /^\s*import\s+(?!type\b)/m.test(readFileSync(index, "utf8"))) found.push("maps/index.ts (it lists imported maps)");
  }
  const assets = join(project, "assets/maps");
  if (existsSync(assets)) {
    const entries = readdirSync(assets);
    if (entries.length === 0) found.push("assets/maps/");
    for (const entry of entries) found.push(`assets/maps/${entry}`);
  }
  return found;
}

if (import.meta.main ?? (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url))) {
  const project = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), ".."));
  const found = importedMapFiles(project);
  if (found.length === 0) console.log("no imported maps: the project can be published");
  else {
    console.error(`This project holds imported maps:\n${found.map((f) => `  ${f}`).join("\n")}`);
    console.error("Imported maps are your own copies of copyrighted maps. They must not be published or packed: a published version");
    console.error("would hand them to everyone. Take them out first (`node tools/import-bsp.ts --remove <id>` for each, or delete");
    console.error("maps/<id>/ and assets/maps/ and restore maps/index.ts), or publish from a copy of the project without them.");
    process.exitCode = 1;
  }
}
