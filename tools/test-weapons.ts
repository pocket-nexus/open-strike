// The weapons, on numbers: the game in the headless renderer in lockstep, in practice on the Range, this script as
// the app. Run at 30, 60 and 120 Hz: shots are timed inside a frame, so the counts must be the same.
//
//   node tools/test-weapons.ts [--rates 30,60,120]
// Checked per rate: the carbine's rate of fire; its recoil (the view kicks up, most of it comes back, the rest stays
// as the table says); bloom opening the crosshair, and movement too; a reload by hand (its time, the rounds moved,
// no shot during it) and the one an empty magazine starts; the shotgun: one shot a press, its rate, nine pellets;
// the switch's draw time; the sights (their time; the marksman rifle's scope takes the crosshair away); the sounds
// (every file asked for is there, all are preloaded, the shots, reload parts, switch and impacts among them); and
// against a practice bot: body and head damage of the marksman rifle as the table's formula gives them, with hit
// flashes, a body impact, the hit and kill sounds.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { MOVE, WEAPONS, damageAt } from "../src/config.ts";
import { build } from "./build.ts";
import { ROOT } from "./lib/engine.ts";
import { checker, startLive, type Live, type Report } from "./lib/live.ts";

const args = process.argv.slice(2);
const rates = (args.includes("--rates") ? args[args.indexOf("--rates") + 1]! : "30,60,120").split(",").map(Number);
const { out } = await build();
const { check, done } = checker();
const f = (v: number) => v.toFixed(4);
const results: Record<string, Record<number, number>> = {};
const note = (name: string, rate: number, v: number) => ((results[name] ??= {})[rate] = v);
const C = WEAPONS.carbine!, S = WEAPONS.shotgun!, M = WEAPONS.marksman!;

/** The sounds the game asked for: every file there, all of them preloaded, and the ones `want` names among them
 *  ("impact-wall": any of its variants). */
function sounds(live: Live, tag: string, want: string[]): void {
  const plays = live.posts.filter((p) => p.t === "audio.play");
  const files = new Set(plays.map((p) => String(p.sound)));
  const missing = [...files].filter((f) => !existsSync(join(ROOT, f)));
  check(plays.length > 0 && missing.length === 0, `${tag} ${plays.length} sounds played, ${files.size} files, all there${missing.length ? ` (missing: ${missing.join(", ")})` : ""}`);
  const preloaded = new Set(live.posts.filter((p) => p.t === "audio.preload").flatMap((p) => p.sounds as string[]));
  const all = readdirSync(join(ROOT, "assets/sounds")).filter((f) => f.endsWith(".ogg"));
  check(all.every((f) => preloaded.has(`assets/sounds/${f}`)), `${tag} all ${all.length} files preloaded (${preloaded.size})`);
  const heard = new Set([...files].map((f) => f.replace(/^.*\//, "").replace(/\.ogg$/, "")));
  const unheard = want.filter((n) => ![...heard].some((h) => h === n || h.startsWith(`${n}-`)));
  check(unheard.length === 0, `${tag} heard ${want.join(", ")}${unheard.length ? ` (not: ${unheard.join(", ")})` : ""}`);
}

async function run(rate: number): Promise<void> {
  const dt = 1 / rate;
  const live: Live = await startLive(out, { launch: { practice: true, map: "range", bots: 0, name: "Test" }, dt });
  const secs = (s: number) => live.step(Math.round(s * rate));
  const tag = `${rate} Hz:`;
  let r: Report;
  await secs(0.5);
  const tap = async (key: string) => { live.input({ keys: [key], pressed: [key] }); await live.step(1); live.input({ keys: [] }); };

  // Rate of fire: the trigger held for two seconds.
  r = await live.report();
  check(r.weapon === "carbine" && r.ammo === C.mag && r.reserve === C.reserve, `${tag} starts with the carbine, ${r.ammo} / ${r.reserve}`);
  live.input({ buttons: [0], pressed: ["Mouse0"] });
  await secs(2);
  live.input({ buttons: [] });
  r = await live.report();
  const want = Math.floor((2 * C.rpm) / 60 + 1e-6) + 1;
  note("carbine shots in 2 s", rate, r.shots);
  check(Math.abs(r.shots - want) <= 1 && r.ammo === C.mag - r.shots, `${tag} carbine: ${r.shots} shots in 2 s (${C.rpm} rpm: ${want}), ${r.ammo} left`);
  check(r.kick[0] > 0.01 && r.bloom > 0.01, `${tag} the view is kicked up ${f(r.kick[0])} rad, the bloom is open ${f(r.bloom)}`);
  const gapFiring = live.hud().crosshair?.gap ?? 0;
  const climbed = r.pitch;
  await secs(1.5);
  r = await live.report();
  const total = r.pitch / (1 - C.recoil.recover);
  check(Math.abs(r.kick[0]) < 1e-3 && r.bloom === 0, `${tag} 1.5 s later the kick is back (${f(r.kick[0])}) and the bloom closed`);
  check(r.pitch === climbed || Math.abs(r.pitch - climbed) < 1e-6, `${tag} what stays is the aim's own climb: ${f(r.pitch)} rad`);
  check(total > want * C.recoil.up * 0.8 && total < (want + 1) * C.recoil.up * 1.2, `${tag} ${f(total)} rad of kick in all (${want} x ${C.recoil.up}), ${C.recoil.recover * 100} % of it came back`);
  const gapRest = live.hud().crosshair?.gap ?? 0;
  check(gapFiring > gapRest, `${tag} the crosshair opened with the burst (gap ${gapFiring} against ${gapRest} at rest)`);
  live.input({ keys: ["W"] });
  await secs(0.8);
  const gapRun = live.hud().crosshair?.gap ?? 0;
  live.input({ keys: [] });
  await secs(0.5);
  check(gapRun > gapRest, `${tag} and with a run (gap ${gapRun})`);

  // A reload by hand.
  const before = (await live.report()).ammo;
  await tap("R");
  r = await live.report();
  check(r.reloading > C.reload / 1000 - 3 * dt - 0.01, `${tag} R: reloading, ${r.reloading.toFixed(2)} s to go`);
  const shotsBefore = r.shots;
  live.input({ buttons: [0], pressed: ["Mouse0"] });
  await secs(C.reload / 1000 - 0.3);
  r = await live.report();
  check(r.shots === shotsBefore && r.reloading > 0, `${tag} no shot during the reload`);
  live.input({ buttons: [] });
  await secs(0.4);
  r = await live.report();
  check(r.ammo === C.mag && r.reserve === C.reserve - (C.mag - before) && r.reloading === 0, `${tag} after ${C.reload} ms: ${r.ammo} / ${r.reserve}`);
  // Emptying the magazine starts one.
  live.input({ buttons: [0], pressed: ["Mouse0"] });
  await secs((C.mag * 60) / C.rpm + 0.2);
  live.input({ buttons: [] });
  r = await live.report();
  check(r.ammo === 0 && r.reloading > 0, `${tag} an empty magazine reloads itself (${r.reloading.toFixed(2)} s to go)`);
  await secs(C.reload / 1000 + 0.1);
  r = await live.report();
  check(r.ammo === C.mag, `${tag} and is full again`);

  // The shotgun: a switch, one shot a press, its rate.
  await tap("2");
  r = await live.report();
  check(r.weapon === "shotgun", `${tag} key 2: the shotgun`);
  const s0 = r.shots;
  live.input({ buttons: [0], pressed: ["Mouse0"] });
  await secs(S.draw - 3 * dt);
  r = await live.report();
  check(r.shots === s0, `${tag} not while it is drawn (${S.draw} s)`);
  live.input({ buttons: [] });
  await secs(0.3);
  live.input({ buttons: [0], pressed: ["Mouse0"] });
  await secs(1.5);
  r = await live.report();
  check(r.shots === s0 + 1, `${tag} a held trigger is one shot`);
  live.input({ buttons: [] });
  await secs(0.5);
  let presses = 0;
  const s1 = (await live.report()).shots;
  for (let k = 0; k < Math.round(3 * rate); k++) {
    // A press every 0.2 s for three seconds: far more often than it can fire.
    const down = Math.floor((k * dt) / 0.2) !== Math.floor(((k - 1) * dt) / 0.2);
    if (down) presses++;
    live.input(down ? { buttons: [0], pressed: ["Mouse0"] } : { buttons: [] });
    await live.step(1);
  }
  live.input({ buttons: [] });
  r = await live.report();
  const most = Math.floor((3 * S.rpm) / 60) + 1;
  note("shotgun shots in 3 s", rate, r.shots - s1);
  check(r.shots - s1 <= most && r.shots - s1 >= most - 1, `${tag} ${presses} presses in 3 s: ${r.shots - s1} shots (${S.rpm} rpm allows ${most})`);
  const pellets = live.posts.filter((p) => p.t === "audio.play" && p.sound === "assets/sounds/shotgun.ogg" && p.at === undefined).length;
  check(pellets === r.shots - s0, `${tag} one report a shot (${pellets} sounds)`);

  // The marksman rifle's sights.
  await tap("3");
  await secs(M.draw + 0.1);
  r = await live.report();
  check(r.weapon === "marksman" && r.ads === 0 && live.hud().crosshair, `${tag} key 3: the marksman rifle, from the hip, with a crosshair`);
  live.input({ buttons: [2] });
  await secs(M.adsTime / 2);
  r = await live.report();
  check(r.ads > 0.3 && r.ads < 0.8, `${tag} sights half up after ${M.adsTime / 2} s (${r.ads.toFixed(2)})`);
  await secs(M.adsTime);
  r = await live.report();
  check(r.ads === 1 && live.hud().crosshair === null, `${tag} up: the scope's reticle replaces the crosshair`);
  live.input({ buttons: [] });
  await secs(0.5);
  sounds(live, tag, ["carbine-1", "carbine-2", "carbine-3", "shotgun", "mag-out", "mag-in", "bolt", "switch", "impact-wall"]);
  await live.quit();
  const errors = live.errors();
  check(errors.length === 0, `${tag} no script error${errors.length ? `: ${errors[0]}` : ""}`);
}

/** Against a bot: what a body shot and a head shot of the marksman rifle take. */
async function hits(): Promise<void> {
  const rate = 60;
  const live: Live = await startLive(out, { launch: { practice: true, map: "range", bots: 1, targets: true, name: "Test" }, dt: 1 / rate });
  await live.step(30);
  // North of the thin wall, where the target stands in the open.
  live.send({ cmd: "event", type: "place", payload: { at: [0, 0, -12], yaw: 0 } });
  await live.step(20);
  live.input({ keys: ["3"], pressed: ["3"] });
  await live.step(1);
  live.input({ keys: [] });
  await live.step(Math.round(M.draw * rate) + 6);
  const aim = async (height: number): Promise<{ r: Report; far: number }> => {
    // Twice: the bot walks while the view turns.
    let r = await live.report(), far = 0;
    for (let k = 0; k < 2; k++) {
      const b = r.actors[0]!, t = b.at!;
      const eye = [r.at[0], r.at[1] + MOVE.eye, r.at[2]];
      // (A soldier's chest leans the way it faces: its head is a hand's width ahead of its feet.)
      const ahead = height > 1.5 ? 0.11 : 0.04;
      const d = [t[0] - Math.sin(b.yaw) * ahead - eye[0]!, t[1] + height - eye[1]!, t[2] - Math.cos(b.yaw) * ahead - eye[2]!];
      far = Math.hypot(...d);
      const yaw = Math.atan2(-d[0]!, -d[2]!), pitch = Math.asin(d[1]! / far);
      live.input({ buttons: [2], dx: r.yaw + r.kick[1] - yaw, dy: r.pitch + r.kick[0] - pitch });
      await live.step(1);
      live.input({ buttons: [2] });
      r = await live.report();
    }
    return { r, far };
  };
  for (const [zone, height] of [["body", 1.15], ["head", 1.68]] as const) {
    live.input({ buttons: [2] });                                  // (sights up: no spread to speak of)
    await live.step(Math.round(M.adsTime * rate) + 30);
    let { r, far } = await aim(height);
    const health = r.actors[0]!.health, flashes = live.hud().flash?.n ?? 0, c0 = r.confirmed;
    live.input({ buttons: [0, 2], pressed: ["Mouse0"] });
    await live.step(2);
    live.input({ buttons: [] });
    await live.step(4);
    r = await live.report();
    const a = r.actors[0]!;
    const want = damageAt(M, zone, far);
    const took = health - (a.alive ? a.health : 0);
    if (zone === "body") check(r.confirmed > c0 && took === want, `a ${zone} shot at ${far.toFixed(1)} m takes ${took} (${want} a hit by the table)`);
    else check(!a.alive && r.me.kills >= 1 && r.score.ember! >= 1, `a ${zone} shot (${want} by the table) kills: ${r.me.kills} kill, score ${JSON.stringify(r.score)}`);
    check((live.hud().flash?.n ?? 0) > flashes && ["hit", "kill"].includes(live.hud().flash?.kind), `the HUD flashes "${live.hud().flash?.kind}"`);
    await live.step(30);
  }
  const feed = JSON.stringify(live.hud().items?.find((i: any) => i.type === "list") ?? {});
  check(feed.includes("Test") && feed.includes("LR-9 Marksman") && feed.includes("headshot"), `the kill feed says it: ${feed.slice(0, 140)}`);
  sounds(live, "against a bot:", ["marksman", "impact-body", "hit", "kill"]);
  await live.quit();
  const errors = live.errors();
  check(errors.length === 0, `no script error${errors.length ? `: ${errors[0]}` : ""}`);
}

for (const rate of rates) await run(rate);
for (const [name, by] of Object.entries(results)) {
  const v = Object.values(by);
  check(Math.max(...v) - Math.min(...v) <= 1, `${name}: ${rates.map((r) => `${by[r]} @ ${r}`).join(", ")}`);
}
await hits();
done("weapons");
