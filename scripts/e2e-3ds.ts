// Local PICA readbacks from an isolated Azahar SD, never the user's live SD.
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { encodePNG } from "../vendor/pocketjs/tests/png.ts";
import { build, MAP_NAMES } from "./3ds.ts";
const root = resolve(import.meta.dir, "..");
const scenario = process.env.E2E_3DS_SCENARIO ?? "combat";
if (!["combat", "menu", "missing-map", "retry", "map"].includes(scenario))
  throw new Error(`Unknown scenario ${scenario}`);
const selectDust = "0:0,10:0x40,12:0,14:0x40,16:0,20:0x2000,22:0";
if (scenario !== "combat") {
  process.env.POCKETJS_CAP_START =
    scenario === "menu" ? "410" : scenario === "retry" ? "550" : "100";
  process.env.POCKETJS_CAP_N = "2";
  process.env.POCKETJS_CAPTURE_INPUT =
    selectDust +
    (scenario === "menu"
      ? ",360:0x1,362:0,364:0x20,366:0,368:0x2000,370:0"
      : scenario === "retry"
        ? ",100:0x10,102:0,104:0x10,106:0,120:0x2000,122:0"
        : "");
  process.env.POCKETJS_CAPTURE_TOUCH = "";
}
const mapName = process.env.E2E_3DS_MAP ?? "de_dust2";
const mapIndex = MAP_NAMES.findIndex((name) => name === mapName);
if (mapIndex < 0) throw new Error(`Unknown map ${mapName}`);
if (scenario === "map") {
  const tape = ["0:0"];
  for (let row = 0; row < Math.floor(mapIndex / 2); row++)
    tape.push(`${10 + row * 4}:0x40`, `${12 + row * 4}:0`);
  if (mapIndex % 2) tape.push("26:0x20", "28:0");
  tape.push("40:0x2000", "42:0");
  process.env.POCKETJS_CAPTURE_INPUT = tape.join(",");
  process.env.POCKETJS_CAP_START = "550";
}
if (!process.env.E2E_3DS_PREBUILT) {
  process.env.POCKETJS_CAP_START ??= "610";
  process.env.POCKETJS_CAP_N ??= "2";
  process.env.POCKETJS_CAPTURE_INPUT ??=
    "0:0,10:0x40,12:0,14:0x40,16:0,20:0x2000,22:0,280:0x2000,290:0";
  process.env.POCKETJS_CAPTURE_TOUCH ??=
    "300:0,250,50@320:-@340:0,250,90@342:-@500:0,100,100@502:0,110,100@504:0,120,100@506:0,130,100@508:-@520:0,100,100@522:-@540:0,30,212@542:-@560:0,250,130@562:-@580:0,250,170@585:-";
  await build(["--capture"]);
}
const out = resolve(root, ".pocket-build/validation/3ds");
mkdirSync(out, { recursive: true });
const fixture = mkdtempSync(`${out}/azahar-`);
const source = resolve(homedir(), "Library/Application Support/Azahar");
const user = resolve(fixture, "Library/Application Support/Azahar");
mkdirSync(resolve(user, "config"), { recursive: true });
for (const dir of ["nand", "sysdata"])
  if (existsSync(resolve(source, dir)))
    cpSync(resolve(source, dir), resolve(user, dir), { recursive: true });
let config = readFileSync(resolve(source, "config/qt-config.ini"), "utf8");
for (const [key, value] of Object.entries({
  graphics_api: process.env.E2E_3DS_GRAPHICS ?? "2",
  resolution_factor: "1",
  frame_limit: "1000",
  use_vsync: "false",
  use_disk_shader_cache: "false",
  check_for_update_on_start: "false",
  use_gdbstub: process.env.E2E_3DS_GDB ? "true" : "false",
  gdbstub_port: "24692",
})) {
  config = config
    .replace(new RegExp(`^${key}=.*$`, "m"), `${key}=${value}`)
    .replace(
      new RegExp(`^${key}\\\\default=.*$`, "m"),
      `${key}\\default=false`,
    );
}
writeFileSync(resolve(user, "config/qt-config.ini"), config);
const maps = resolve(user, "sdmc/3ds/OpenStrike/maps");
mkdirSync(maps, { recursive: true });
for (const name of MAP_NAMES.filter(
  (name) =>
    !(["missing-map", "retry"].includes(scenario) && name === "de_dust2"),
))
  cpSync(
    resolve(
      process.env.OPENSTRIKE_COOKED_MAPS ?? resolve(root, "dist/maps"),
      `${name}.p3d`,
    ),
    resolve(maps, `${name}.p3d`),
  );
mkdirSync(resolve(user, "sdmc/pocketjs-captures"), { recursive: true });
const rom = resolve(fixture, "OpenStrike.3dsx");
cpSync(
  resolve(
    process.env.E2E_3DS_PREBUILT ??
      resolve(root, "dist/3ds/capture/openstrike.3dsx"),
  ),
  rom,
);
const app = process.env.AZAHAR ?? "/Applications/Azahar.app";
const launch = Bun.spawnSync([
  "open",
  "-n",
  "-a",
  app,
  "--env",
  `HOME=${fixture}`,
  "--stdout",
  `${fixture}/console.log`,
  "--stderr",
  `${fixture}/console.log`,
  "--args",
  rom,
]);
if (launch.exitCode) throw new Error(launch.stderr.toString());
const owned = () =>
  Bun.spawnSync(["ps", "-axo", "pid=,command="])
    .stdout.toString()
    .split("\n")
    .filter(
      (line) =>
        line.includes(`${app}/Contents/MacOS/azahar`) && line.includes(rom),
    )
    .map((line) => Number(line.trim().split(/\s+/)[0]));
console.log(`Azahar: ${fixture}`);
try {
  const capture = resolve(user, "sdmc/pocketjs-captures");
  const start = Date.now();
  while (!existsSync(`${capture}/done`)) {
    if (existsSync(`${capture}/error.txt`))
      throw new Error(readFileSync(`${capture}/error.txt`, "utf8"));
    if (
      Date.now() - start > 300000 ||
      (Date.now() - start > 15000 && !owned().length)
    )
      throw new Error(`Capture incomplete: ${fixture}`);
    await Bun.sleep(500);
  }
  const { readdirSync } = await import("node:fs");
  const files = [];
  for (const file of readdirSync(capture).filter((f) => f.endsWith(".raw"))) {
    const width = file.startsWith("aux-") ? 320 : 400;
    const height = 240;
    const bytes = readFileSync(resolve(capture, file));
    if (bytes.length !== width * height * 4)
      throw new Error(`Truncated readback ${file}`);
    const rgba = new Uint8Array(bytes.length);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const src = (x * height + height - 1 - y) * 4,
          dst = (y * width + x) * 4;
        rgba.set([bytes[src + 3]!, bytes[src + 2]!, bytes[src + 1]!, 255], dst);
      }
    const name = file.replace(".raw", ".png");
    writeFileSync(resolve(fixture, name), encodePNG(rgba, width, height));
    files.push(name);
  }
  const scene = readFileSync(resolve(capture, "scene.tsv"), "utf8")
    .trim()
    .split("\n")
    .map((line) => line.split("\t").map(Number));
  if (!scene.every((row) => row.length === 15 && row.every(Number.isFinite)))
    throw new Error("Invalid native telemetry");
  const last = scene.at(-1)!;
  if (scenario === "menu" || scenario === "missing-map") {
    if (last[1] !== 0)
      throw new Error("Expected the main menu with no active world");
    if (
      scenario === "menu" &&
      !scene.some((row) => row[1] === 1 && row[7] === row[8])
    )
      throw new Error("Menu test never entered a loaded world");
    if (scenario === "missing-map" && scene.some((row) => row[1] !== 0))
      throw new Error("Missing map unexpectedly loaded");
  } else if (
    last[1] !== 1 ||
    last[7] !== last[8] ||
    last[8] === 0 ||
    last[9]! < 0
  )
    throw new Error("World/radar did not finish loading");
  if (
    last[1] === 1 &&
    last[14] !== (scenario === "retry" ? 0 : scenario === "map" ? mapIndex : 4)
  )
    throw new Error(`Unexpected loaded map index ${last[14]}`);
  if (scenario === "combat" && !process.env.E2E_3DS_CUSTOM_TAPE) {
    const ready = scene.find((row) => row[7] === row[8] && row[1] === 1)!;
    if (
      !scene.some((row) => row[12]! < 30) ||
      last[12] !== 30 ||
      last[13]! >= 90
    )
      throw new Error("Fire/reload did not complete");
    const at = (frame: number) => scene.find((row) => row[0] === frame)!;
    if (Math.abs(at(295)[10]! - ready[10]!) < 0.2)
      throw new Error("Face-button aiming did not turn the player");
    if (Math.abs(at(510)[10]! - at(500)[10]!) < 0.1)
      throw new Error("Touch-map aiming did not turn the player");
    if (at(575)[3]! - at(560)[3]! < 8)
      throw new Error("Touch jump did not lift the player");
    if (at(335)[12] !== at(325)[12])
      throw new Error("Touch fire remained held after release");
  }
  writeFileSync(
    resolve(fixture, "receipt.json"),
    JSON.stringify(
      {
        scenario,
        renderer: "Azahar PICA",
        map: last[1] === 1 ? MAP_NAMES[last[14]!] : null,
        graphics: process.env.E2E_3DS_GRAPHICS ?? "2",
        files,
        scene,
      },
      null,
      2,
    ),
  );
  console.log(`CAPTURE PASS (${scenario}): ${fixture} ${files.join(", ")}`);
} finally {
  for (const pid of owned()) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
}
