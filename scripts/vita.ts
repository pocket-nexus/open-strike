// Build OpenStrike for PS Vita: product bundle -> cooked maps -> cargo-vita
// VPK. Toolchain installation is deliberately outside this script; it checks
// the stable VitaSDK/cargo-vita contract and gives an actionable error.
//
//   bun scripts/vita.ts                         # debug VPK, menu boot
//   bun scripts/vita.ts --release               # optimized VPK
//   bun scripts/vita.ts --map de_inferno --bench
//   OPENSTRIKE_MAPS=~/cs bun scripts/vita.ts

import { $ } from "bun";
import { createHash, randomBytes } from "node:crypto";
import { resolve } from "node:path";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { compilePocketTarget, nativePocketContract } from "./pocket-contract.ts";
import { packageVitaVpk } from "../vendor/pocketjs/tools/vita-package.ts";
import { prepareVitaUsb } from "../vendor/pocketjs/tools/vita-usb.ts";
import { cookMap } from "./cook-map.ts";

const repo = new URL("..", import.meta.url).pathname;
const home = process.env.HOME ?? "";
const vitaDir = `${repo}crates/openstrike-vita/`;
const argv = Bun.argv.slice(2);

function value(name: string, fallback: string): string {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] ? argv[index + 1]! : fallback;
}

const mapName = value("map", "de_dust2");
const release = argv.includes("-r") || argv.includes("--release");
const usbDebug = !argv.includes("--no-usb-debug");
const configured: unknown = JSON.parse(process.env.OPENSTRIKE_MOD_PACKS ?? "[]");
if (!Array.isArray(configured) || configured.some((p) => typeof p !== "string" || !p))
  throw new Error("OPENSTRIKE_MOD_PACKS must be an array of manifest paths");
const modPaths: string[] = configured.map((p) => resolve(repo, p));
for (let i = 0; i < argv.length; i++) {
  if (argv[i] !== "--mod") continue;
  const path = argv[++i];
  if (!path || path.startsWith("--")) throw new Error("--mod needs a manifest path");
  modPaths.push(resolve(repo, path));
}
if (modPaths.length > 7 || modPaths.some((p) => !existsSync(p)))
  throw new Error("Supply up to seven existing mod manifests");
const features: string[] = [];
if (argv.includes("--capture")) features.push("capture");
if (argv.includes("--bench")) features.push("bench");

const mapsRoot = process.env.OPENSTRIKE_MAPS ?? `${home}/Downloads/cs-maps-20260705-1836`;
const cookedMaps = process.env.OPENSTRIKE_COOKED_MAPS;
if (!cookedMaps && !existsSync(`${mapsRoot}/maps`)) {
  console.error(`no maps dir at ${mapsRoot}/maps (set OPENSTRIKE_MAPS)`);
  process.exit(1);
}

const vitaSdk = process.env.VITASDK ?? (existsSync(`${home}/vitasdk`) ? `${home}/vitasdk` : undefined);
if (!vitaSdk || !existsSync(`${vitaSdk}/bin/vita-pack-vpk`)) {
  console.error("VitaSDK not found (set VITASDK to a complete vitasdk install)");
  process.exit(1);
}
if (!Bun.which("cargo-vita")) {
  console.error("cargo-vita not found (install with `cargo +nightly install cargo-vita`)");
  process.exit(1);
}

// 1. Validate the app contract for Vita, then compile the JS/pak from the
// immutable resolved plan. The same source manifest is also valid on PSP.
console.log("openstrike-vita: resolving and building the Pocket app contract");
const pocketPlan = await compilePocketTarget("vita");
const planPath = `${repo}.pocket/vita/plan.json`;
const plan = JSON.parse(readFileSync(planPath, "utf8"));
const nativeBuild = randomBytes(16).toString("hex");
const usb = usbDebug ? await prepareVitaUsb() : undefined;

// 2. Cook every map so the on-device menu owns the complete catalogue.
mkdirSync(`${repo}dist/maps`, { recursive: true });
const bsps = cookedMaps ? [] : readdirSync(`${mapsRoot}/maps`)
  .filter((file) => file.endsWith(".bsp"))
  .sort();
if (!cookedMaps && bsps.length === 0) {
  console.error(`no BSP maps found under ${mapsRoot}/maps`);
  process.exit(1);
}
for (const file of bsps) {
  const stem = file.slice(0, -4);
  const source = `${mapsRoot}/maps/${file}`;
  const cooked = `${repo}dist/maps/${stem}.p3d`;
  await cookMap(source, cooked, [`${mapsRoot}/support`], `${repo}vendor/pocketjs/engine/pocket3d`);
}

// Recreate the application overlay's map subtree so a removed source map
// cannot survive in a later VPK. PocketJS's shared final packer merges this
// VPK-relative `static` tree over the framework LiveArea defaults.
const stagedMaps = `${vitaDir}static/maps`;
rmSync(stagedMaps, { recursive: true, force: true });
mkdirSync(stagedMaps, { recursive: true });
const mapDirectory = resolve(cookedMaps ?? `${repo}dist/maps`);
const cookedFiles = readdirSync(mapDirectory).filter((name) => name.endsWith(".p3d") && !name.startsWith("."));
if (!cookedFiles.length) throw new Error(`No cooked maps in ${mapDirectory}`);
for (const file of cookedFiles) {
  await $`cargo run --release --locked -q -p pocket3d-cook -- --verify-cooked ${mapDirectory}/${file}`.cwd(`${repo}vendor/pocketjs/engine/pocket3d`);
  cpSync(`${mapDirectory}/${file}`, `${stagedMaps}/${file}`);
}

// 3. Rust tier-3 target -> SELF -> VPK. Capture and bench builds autostart a
// map so automation never depends on menu input; retail builds show the menu.
const profile = release ? "release" : "debug";
const rustup =
  process.env.OPENSTRIKE_VITA_RUSTUP ?? Bun.which("rustup") ?? `${home}/.cargo/bin/rustup`;
if (!existsSync(rustup)) {
  console.error("rustup not found");
  process.exit(1);
}
const toolchain = process.env.OPENSTRIKE_VITA_RUST_TOOLCHAIN ?? "nightly-2026-05-28";
const cargoArgs: string[] = ["--locked"];
if (release) cargoArgs.push("--release");
if (features.length) cargoArgs.push(`--features=${features.join(",")}`);
if (!usbDebug) cargoArgs.push("--no-default-features");
const env = {
  ...process.env,
  ...nativePocketContract(pocketPlan),
  POCKETJS_EMBED_APP: "1",
  POCKETJS_VITA_TITLE_ID: "OPSK00001",
  POCKETJS_VITA_PLAN: planPath,
  POCKETJS_NATIVE_BUILD: nativeBuild,
  OPENSTRIKE_MOD_PACKS: JSON.stringify(modPaths),
  OPENSTRIKE_INITIAL_MOD: process.env.OPENSTRIKE_INITIAL_MOD ?? "classic",
  OPENSTRIKE_CHARACTER_ASSET: "",
  VITASDK: vitaSdk,
  // Homebrew's cargo/rustc may precede rustup on macOS. cargo-vita needs the
  // nightly rustup proxy for every recursive cargo/rustc invocation.
  PATH: `${home}/.cargo/bin:${vitaSdk}/bin:${process.env.PATH ?? ""}`,
  TARGET_AR: "arm-vita-eabi-ar",
  AR_armv7_sony_vita_newlibeabihf: "arm-vita-eabi-ar",
  TARGET_CC: "arm-vita-eabi-gcc",
  CC_armv7_sony_vita_newlibeabihf: "arm-vita-eabi-gcc",
  TARGET_CXX: "arm-vita-eabi-g++",
  CXX_armv7_sony_vita_newlibeabihf: "arm-vita-eabi-g++",
  OPENSTRIKE_VITA_AUTOSTART:
    process.env.OPENSTRIKE_VITA_AUTOSTART ?? (features.length > 0 ? mapName : ""),
  OPENSTRIKE_VITA_CAPTURE_INPUT: process.env.OPENSTRIKE_VITA_CAPTURE_INPUT ?? "",
  OPENSTRIKE_VITA_CAP_START: process.env.OPENSTRIKE_VITA_CAP_START ?? "",
  OPENSTRIKE_VITA_CAP_N: process.env.OPENSTRIKE_VITA_CAP_N ?? "",
};

console.log(`openstrike-vita: cargo vita (map=${mapName}, profile=${profile})`);
await $`${rustup} run ${toolchain} cargo vita build vpk -- ${cargoArgs}`.cwd(vitaDir).env(env);

const targetDirectory = `${vitaDir}target/armv7-sony-vita-newlibeabihf/${profile}`;
const artifact = `${targetDirectory}/openstrike-vita.vpk`;
const sfo = `${targetDirectory}/openstrike-vita.sfo`;
const eboot = `${targetDirectory}/openstrike-vita.self`;
if (![artifact, sfo, eboot].every(existsSync)) {
  console.error(`cargo-vita completed but package inputs are incomplete under ${targetDirectory}`);
  process.exit(1);
}
if (usbDebug)
  await $`${vitaSdk}/bin/vita-make-fself ${targetDirectory}/openstrike-vita.velf ${eboot}`;

await packageVitaVpk({
  tool: `${vitaSdk}/bin/vita-pack-vpk`,
  sfo,
  eboot,
  output: artifact,
  applicationAssets: `${vitaDir}static`,
  usbDriver: usb?.driver,
});

const packaged = `${repo}dist/vita/OpenStrike.vpk`;
mkdirSync(`${repo}dist/vita`, { recursive: true });
cpSync(artifact, packaged);
cpSync(eboot, `${repo}dist/vita/OpenStrike.self`);
await Bun.write(`${repo}dist/vita/OpenStrike.runtime.json`, JSON.stringify({
  version: 1, titleId: "OPSK00001", applicationId: plan.app.id,
  output: pocketPlan.appOutput, nativeBuild, plan,
  self: "OpenStrike.self", usbDebug, usbDriver: usb?.fingerprint,
  selfSha256: createHash("sha256").update(readFileSync(eboot)).digest("hex"),
}, null, 2) + "\n");
// PocketJS's installer addresses VPKs by the resolved output name.
if (pocketPlan.appOutput !== "OpenStrike")
  cpSync(artifact, `${repo}dist/vita/${pocketPlan.appOutput}.vpk`);
console.log(`output: ${packaged}`);
