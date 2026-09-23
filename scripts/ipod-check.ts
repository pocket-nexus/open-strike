/** Hardware acceptance through UIKit, the shipping guest, and simulation receipts. */
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { shellQuote as q } from "../vendor/pocketjs/tools/ipodtouch4-installation.ts";
interface Game {
  frames: number;
  map: string;
  mod: string;
  hp: number;
  ammo: number;
  position: number[];
  yaw: number;
  pitch: number;
  paused: boolean;
  input: number[];
  glError: number;
  error: string;
  fps: number;
  p95Ms: number;
  p99Ms: number;
  worldTriangles: number;
  actorTriangles: number;
}
export async function verifyIPod(device: {
  base: string;
  udid: string;
  remote(cmd: string): string;
  play(frames: string): void;
}) {
  const root = resolve(import.meta.dir, "..");
  const output = resolve(
    root,
    ".pocket-build/validation/ipod-touch",
    new Date().toISOString().replaceAll(":", "-"),
  );
  mkdirSync(output, { recursive: true });
  const env = { ...process.env, POCKETJS_IPODTOUCH4_UDID: device.udid };
  const cli = async (cmd: string) => {
    const child = Bun.spawn(["bun", "scripts/ipodtouch4.ts", cmd], {
      cwd: root,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    writeFileSync(`${output}/${cmd}.log`, out + err);
    assert.equal(exit, 0, `${cmd}: ${out}${err}`);
  };
  const read = (): Game =>
    JSON.parse(
      device.remote(`cat ${q(device.base + "/tmp/openstrike-game.json")}`),
    );
  const snapshot = async (name: string) => {
    await Bun.sleep(1300);
    const g = read();
    const host = device.remote(
      `cat ${q(device.base + "/tmp/pocketjs.status")}`,
    );
    writeFileSync(`${output}/${name}.json`, JSON.stringify(g, null, 2) + "\n");
    writeFileSync(`${output}/${name}.host.txt`, host + "\n");
    assert.equal(g.error, "");
    assert.equal(g.glError, 0);
    assert.match(host, /state=running\n/);
    assert.match(host, /renderer=gles1\n/);
    return { g, host };
  };
  const tap = (x: number, y: number) =>
    device.play(`0 1 0 ${x} ${y} 1\n150 1 0 ${x} ${y} 0\n`);
  const capture = async (name: string) => {
    await cli("capture");
    copyFileSync(
      `${root}/vendor/pocketjs/dist/ipodtouch4/device-frame.png`,
      `${output}/${name}.png`,
    );
  };
  const select = async (mod: number, map: number) => {
    tap(240, 176);
    tap(240, 133 + 48 * mod);
    tap(92 + 148 * (map % 3), 115 + 48 * Math.floor(map / 3));
    await Bun.sleep(1800);
  };
  const quit = async () => {
    tap(46, 28);
    await Bun.sleep(200);
    tap(293, 172);
    await Bun.sleep(250);
  };
  await cli("launch");
  await select(0, 4);
  const baseline = (await snapshot("classic-baseline")).g;
  assert.equal(baseline.map, "de_dust2");
  assert.equal(baseline.mod, "classic");
  assert.equal(baseline.ammo, 30);
  await capture("classic");
  const frames = [
    "0 1 0 78 244 1",
    "100 2 0 78 210 1 1 300 160 1",
    "100 3 0 78 210 1 1 300 160 1 2 424 216 1",
  ];
  for (let n = 1; n <= 90; n++) {
    let contacts = `0 78 210 1 1 ${300 + n / 3} 160 1 2 424 216 1`;
    if (n >= 31 && n <= 50) contacts += " 3 429 286 1";
    else if (n === 51) contacts += " 3 429 286 0";
    frames.push(`16 ${n >= 31 && n <= 51 ? 4 : 3} ${contacts}`);
  }
  frames.push("16 3 0 78 210 0 1 330 160 0 2 424 216 0");
  device.play(frames.join("\n") + "\n");
  const multi = await snapshot("four-contacts");
  assert.match(multi.host, /touch_max_contacts=[4-8]\n/);
  assert(multi.g.ammo < baseline.ammo, "held FIRE must spend ammunition");
  assert(
    Math.hypot(...multi.g.position.map((n, i) => n - baseline.position[i]!)) >
      10,
    "stick must move the player",
  );
  assert(
    Math.abs(multi.g.yaw - baseline.yaw + 0.15) < 0.01,
    "30px touch aim must turn 0.15 radians, once",
  );
  assert.deepEqual(multi.g.input, [0, 0, 0]);
  tap(359, 281);
  await Bun.sleep(2800);
  assert.equal((await snapshot("reload")).g.ammo, 30);
  tap(173, 282);
  assert.equal((await snapshot("walk-on")).g.input[2], 8);
  tap(173, 282);
  assert.equal((await snapshot("walk-off")).g.input[2], 0);
  tap(46, 28);
  const paused = (await snapshot("paused")).g;
  assert(paused.paused);
  await capture("pause");
  await Bun.sleep(1500);
  const frozen = read();
  assert.deepEqual(frozen.position, paused.position);
  assert.equal(frozen.ammo, paused.ammo);
  tap(192, 172);
  assert.equal((await snapshot("resumed")).g.paused, false);
  // Keep FIRE held while a second finger opens and closes the dialog. The
  // remounted controls must ignore that original contact until it lifts.
  device.play(
    "0 1 0 424 216 1\n200 2 0 424 216 1 1 46 28 1\n150 2 0 424 216 1 1 46 28 0\n400 2 0 424 216 1 1 192 172 1\n150 2 0 424 216 1 1 192 172 0\n2000 1 0 424 216 1\n100 1 0 424 216 0\n",
  );
  const resumed = (await snapshot("held-across-pause")).g;
  assert(!resumed.paused);
  assert(resumed.ammo >= 26, "held pre-pause finger must not resume shooting");
  assert.deepEqual(resumed.input, [0, 0, 0]);
  await Bun.sleep(15000);
  const quiet = (await snapshot("classic-quiet-frametime")).g;
  console.log(
    `Classic quiet: ${quiet.fps.toFixed(1)} FPS, p95 ${quiet.p95Ms.toFixed(1)} ms`,
  );
  for (const [mod, index, label] of [
    [1, 8, "frieren-wwdc"],
    [2, 4, "pikachu-dust2"],
  ] as const) {
    await quit();
    assert.equal((await snapshot(`${label}-menu`)).g.map, "menu");
    await select(mod, index);
    const g = (await snapshot(label)).g;
    assert.equal(g.mod, mod === 1 ? "frieren" : "pikachu");
    assert.equal(g.map, index === 8 ? "wwdc24-parkour" : "de_dust2");
    assert(g.worldTriangles > 0 && g.actorTriangles > 0);
    await capture(label);
    const before = g.ammo;
    device.play("0 1 0 424 216 1\n700 1 0 424 216 0\n");
    assert((await snapshot(`${label}-fire`)).g.ammo < before);
    await Bun.sleep(15000);
    await snapshot(`${label}-quiet-frametime`);
  }
  // Release all map/actor resources and load Classic again in the same process.
  await quit();
  await select(0, 3);
  assert.equal((await snapshot("classic-reentry")).g.mod, "classic");
  await cli("status");
  writeFileSync(
    `${output}/result.json`,
    JSON.stringify(
      {
        passed: true,
        output,
        build: JSON.parse(
          readFileSync(
            `${root}/vendor/pocketjs/dist/ipodtouch4/OpenStrike.app/build-receipt.json`,
            "utf8",
          ),
        ).buildId,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(`iPod hardware acceptance passed: ${output}`);
}
