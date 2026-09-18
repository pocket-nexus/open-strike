// SPDX-License-Identifier: MIT
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { compilePocketTarget, nativePocketContract } from "./pocket-contract.ts";
const root = resolve(import.meta.dir, "..");
const target = process.platform === "darwin" ? "macos-app" : "linux-app";
const inputs = await compilePocketTarget(target);
const build = Bun.spawn(["cargo", "build", "--release", "--locked", "--lib", "-p", "openstrike"], {
  cwd: root, env: { ...process.env, ...nativePocketContract(inputs) }, stdout: "inherit", stderr: "inherit",
});
if (await build.exited !== 0) throw new Error("Native module build failed");
const maps = resolve(process.env.OPENSTRIKE_MAPS ?? resolve(root, "dist/maps"));
const map = [resolve(maps, "de_dust2.p3d"), resolve(maps, "maps/de_dust2.p3d")].find(existsSync);
if (!map) throw new Error(`Set OPENSTRIKE_MAPS to a directory containing cooked de_dust2.p3d: ${maps}`);
const library = `libopenstrike_native.${process.platform === "darwin" ? "dylib" : "so"}`;
const output = resolve(root, "dist/native", target);
rmSync(output, { recursive: true, force: true });
for (const [source, destination] of [
  [resolve(process.env.CARGO_TARGET_DIR ?? resolve(root, "target"), "release", library), library],
  [resolve(root, `dist/pocket/${target}/openstrike.js`), "openstrike.js"],
  [resolve(root, `dist/pocket/${target}/openstrike.pak`), "openstrike.pak"],
  [resolve(root, "assets/characters/police/officer.glb"), "assets/characters/police/officer.glb"],
  [map, "maps/de_dust2.p3d"], [resolve(root, "LICENSE"), "LICENSE"],
]) {
  const path = resolve(output, destination); mkdirSync(dirname(path), { recursive: true }); cpSync(source, path);
}
const manifest = await Bun.file(resolve(root, "pocket.json")).json();
await Bun.write(resolve(output, "native-app.json"), JSON.stringify({ format: 1, target, manifest, library, config: {} }, null, 2) + "\n");
console.log(`Native application package: ${output}`);
