// Exercise the shipping menu: choose the second pack, deploy Dust2, cast,
// return, deploy Classic, then switch back. Assets and captures stay local.
// OPENSTRIKE_TEST_MOD=out/mods/frieren/mod.json bun scripts/mods-psp.ts
import { $ } from "bun";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const repo = resolve(import.meta.dir, "..");
const manifests: string[] = process.env.OPENSTRIKE_TEST_MODS
  ? JSON.parse(process.env.OPENSTRIKE_TEST_MODS)
  : [process.env.OPENSTRIKE_TEST_MOD ?? ""];
if (!manifests.length || manifests.some((path) => !path || !existsSync(path)))
  throw new Error(
    "Set OPENSTRIKE_TEST_MOD or OPENSTRIKE_TEST_MODS to local manifests",
  );
const selected = Number(process.env.OPENSTRIKE_TEST_MOD_INDEX ?? 1);
if (!Number.isInteger(selected) || selected < 1 || selected > manifests.length)
  throw new Error("Invalid capture mod index");
const modArgs = manifests.flatMap((path) => ["--mod", resolve(path)]);
const home = process.env.HOME!;
const emulator =
  process.env.PPSSPP_HEADLESS ?? `${home}/ppsspp-src/build/PPSSPPHeadless`;
const out = resolve(repo, process.env.OPENSTRIKE_TEST_OUTPUT ?? "out/mods-psp");
const capture = `${home}/.ppsspp/dc_cap`;
const target = `${repo}/crates/openstrike-psp/target/mipsel-sony-psp/debug`;
mkdirSync(out, { recursive: true });
const input = ["0:0"];
const press = (frame: number, mask: number) =>
  input.push(`${frame}:${mask}`, `${frame + 2}:0`);
const down = 0x40,
  circle = 0x2000,
  right = 0x20,
  select = 1,
  fire = 0x200;
for (let i = 0; i < selected; i++) press(10 + i * 4, down);
press(40, circle);
press(50, down);
press(60, down);
press(70, circle);
press(180, fire);
press(230, select);
press(240, right);
press(250, circle);
press(260, circle);
press(270, down);
press(280, down);
press(290, circle);
press(420, select);
press(430, right);
press(440, circle);
for (let i = 0; i < selected; i++) press(445 + i * 4, down);
press(480, circle);
press(490, down);
press(500, down);
press(510, circle);
press(590, fire);
press(605, down);
await $`bun scripts/psp.ts --capture ${modArgs}`
  .cwd(repo)
  .env({
    ...process.env,
    OPENSTRIKE_PSP_AUTOSTART: "",
    OPENSTRIKE_PSP_CAPTURE_INPUT: input.join(","),
    OPENSTRIKE_PSP_CAP_START: "0",
    OPENSTRIKE_PSP_CAP_N: "780",
  })
  .quiet();
rmSync(capture, { recursive: true, force: true });
rmSync(`${target}/pocketjs-dbg`, { recursive: true, force: true });
await $`${emulator} --graphics=software --timeout=180 ${target}/EBOOT.PBP`
  .nothrow()
  .quiet();
const frames = existsSync(capture)
  ? readdirSync(capture).filter((name) => name.endsWith(".raw"))
  : [];
if (frames.length !== 780)
  throw new Error(`Mod switching stopped: ${frames.length}/780 frames`);
const shots: Record<string, number> = {
  menu: 5,
  maps: 45,
  pack: 150,
  cast: 187,
  classic: 390,
  return: 444,
  switched: 588,
  recast: 597,
  reload: 655,
  reloadComplete: 775,
};
const receipt: Record<string, string> = {};
for (const [name, frame] of Object.entries(shots)) {
  const raw = `${capture}/f${String(frame).padStart(4, "0")}.raw`;
  const png = `${out}/${name}.png`;
  await $`magick -size 512x272 -depth 8 RGBA:${raw} -alpha off -crop 480x272+0+0 +repage -define png:exclude-chunks=date,time PNG24:${png}`.quiet();
  if (Number(await $`magick ${png} -format %k info:`.text()) < 16)
    throw new Error(`Blank frame: ${name}`);
  receipt[name] = new Bun.CryptoHasher("sha256")
    .update(await Bun.file(png).arrayBuffer())
    .digest("hex");
}
await Bun.write(
  `${out}/receipt.json`,
  JSON.stringify(
    { frames: frames.length, input: input.join(","), shots: receipt },
    null,
    2,
  ),
);
rmSync(capture, { recursive: true, force: true });
console.log(
  `Mod switching: 780 frames, ten captures. Inspect ${out} for menu, assets, ammo and spell alignment.`,
);
