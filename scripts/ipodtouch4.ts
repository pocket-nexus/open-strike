import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { $ } from "bun";

const root = resolve(import.meta.dir, "..");
const args = process.argv.slice(2);
const command = args[0] ?? "doctor";
const staging = resolve(root, ".pocket/ipodtouch4");
mkdirSync(`${staging}/assets`, { recursive: true });
const manifest = JSON.parse(readFileSync(resolve(root, "pocket.json"), "utf8"));
manifest.engine.capabilities = {
  requires: ["text.glyphs.baked", "input.touch"],
  enhances: [],
};
manifest.app.viewport = {
  fixed: { logical: [480, 320], presentation: "native" },
};
delete manifest.app.surfaces;
writeFileSync(
  `${staging}/pocket.json`,
  JSON.stringify(manifest, null, 2) + "\n",
);

const maps = resolve(root, process.env.OPENSTRIKE_COOKED_MAPS ?? "dist/maps");
if (command === "build" || command === "deploy") {
  const files = readdirSync(maps)
    .filter((f) => /^[a-zA-Z0-9_-]+\.p3d$/.test(f))
    .sort();
  if (!files.length)
    throw new Error("No cooked maps; set OPENSTRIKE_COOKED_MAPS");
  rmSync(`${staging}/assets/maps`, { recursive: true, force: true });
  mkdirSync(`${staging}/assets/maps`, { recursive: true });
  for (const file of files) {
    await $`cargo run --release --locked -q -p pocket3d-cook -- --verify-cooked ${maps}/${file}`.cwd(
      `${root}/vendor/pocketjs/engine/pocket3d`,
    );
    cpSync(`${maps}/${file}`, `${staging}/assets/maps/${file}`);
  }
}
const configFile = `${staging}/build-config.json`;
const previous = existsSync(configFile)
  ? JSON.parse(readFileSync(configFile, "utf8"))
  : { mods: [] };
const explicitMods =
  args.includes("--mod") || process.env.OPENSTRIKE_MOD_PACKS !== undefined;
const configured: unknown = explicitMods
  ? JSON.parse(process.env.OPENSTRIKE_MOD_PACKS ?? "[]")
  : previous.mods;
if (!Array.isArray(configured) || configured.some((p) => typeof p !== "string"))
  throw new Error("OPENSTRIKE_MOD_PACKS must be a manifest path array");
const mods = configured.map((p) => resolve(root, p));
for (let i = 1; i < args.length; i++)
  if (args[i] === "--mod") {
    if (!args[i + 1]) throw new Error("--mod requires a path");
    mods.push(resolve(root, args[++i]));
  }
if (mods.length > 7 || mods.some((p) => !existsSync(p)))
  throw new Error("Supply up to seven existing mod manifests");
if (command === "build" || command === "deploy")
  writeFileSync(configFile, JSON.stringify({ mods }, null, 2) + "\n");
const child = Bun.spawn(
  [
    "bun",
    `${root}/vendor/pocketjs/tools/ipodtouch4.ts`,
    command,
    ...args
      .slice(1)
      .filter((a, i, all) => a !== "--mod" && all[i - 1] !== "--mod"),
  ],
  {
    cwd: `${root}/vendor/pocketjs`,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env: {
      ...process.env,
      POCKETJS_IPODTOUCH4_APP_FILE: `${root}/hosts/ipodtouch4/ipodtouch4.json`,
      OPENSTRIKE_IPOD_MAPS: maps,
      OPENSTRIKE_MOD_PACKS: JSON.stringify(mods),
      OPENSTRIKE_INITIAL_MOD: "classic",
    },
  },
);
process.on("SIGINT", () => child.kill("SIGTERM"));
process.on("SIGTERM", () => child.kill("SIGTERM"));
process.exitCode = await child.exited;
