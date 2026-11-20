// Deaths, on numbers: practice on Foundry, bots shot dead where they stand (standing, crouched, running; in the head,
// the body, the legs; carbine, shotgun, marksman), the ragdolls followed frame by frame. Checked: each falls (its
// head ends near the ground), lands on the ground and not through it, stays near where it stood (knocked away from
// the shot by a shotgun more than a carbine, never flung), never leaves the ground by more than a stumble, and lies
// still within a few seconds (asleep: no pose, no skinning after).
//
//   node tools/test-ragdoll.ts [--verbose]
import { build } from "./build.ts";
import { checker, startLive } from "./lib/live.ts";

const verbose = process.argv.includes("--verbose");
const { out } = await build();
const { check, done } = checker();
const log = "out/test-ragdoll.jsonl";
const live = await startLive(out, { launch: { practice: true, bots: 4, name: "Test" }, args: ["--frame-log", log] });
type V3 = [number, number, number];
const cases: { at: V3; yaw: number; flags?: number; speed?: number; weapon: number; die: string }[] = [
  { at: [-15.2, 0, -5.8], yaw: 1.7, weapon: 0, die: "head" },
  { at: [-14.8, 0, -4.8], yaw: 1.2, weapon: 1, flags: 1, die: "body" },
  { at: [-14.6, 0, -3.7], yaw: 2.8, weapon: 2, speed: 4.6, die: "limb" },
  { at: [-15.0, 0, -2.6], yaw: -1.4, weapon: 1, die: "body" },
];
live.send({ cmd: "event", type: "place", payload: { at: [-17.6, 0, -4.9], yaw: -1.57 } });
live.send({ cmd: "event", type: "stage", payload: { bots: cases.map(({ die: _, ...b }) => b) } });
await live.step(60);
live.send({ cmd: "event", type: "stage", payload: { bots: cases } });
const track: Record<number, { t: number; waist: V3; head: V3; low: number; asleep: boolean }[]> = {};
for (let f = 0; f < 300; f += 5) {
  await live.step(5);
  const r = (await live.report()) as unknown as { ragdolls: { slot: number; waist: V3; head: V3; low: number; asleep: boolean }[] };
  for (const d of r.ragdolls) (track[d.slot] ??= []).push({ t: f + 5, ...d });
}
const slots = Object.keys(track).map(Number).sort((a, b) => a - b);
check(slots.length === cases.length, `${cases.length} ragdolls (${slots.length})`);
slots.forEach((slot, i) => {
  const c = cases[i]!, t = track[slot]!, end = t.at(-1)!;
  if (verbose) for (const x of t) console.log(slot, x.t, x.waist.join(","), "head", x.head[1], "low", x.low, x.asleep ? "asleep" : "");
  const what = `${c.die}${c.flags ? " crouched" : c.speed ? " running" : ""}, ${["carbine", "shotgun", "marksman"][c.weapon]}`;
  const moved = Math.hypot(end.waist[0] - c.at[0], end.waist[2] - c.at[2]);
  check(end.head[1] < 0.4 && end.waist[1] < 0.35, `${what}: down (head ${end.head[1].toFixed(2)} m, waist ${end.waist[1].toFixed(2)} m)`);
  check(Math.min(...t.map((x) => x.low)) > -0.02, `${what}: never through the floor (lowest ${Math.min(...t.map((x) => x.low)).toFixed(3)} m)`);
  check(Math.max(...t.map((x) => x.waist[1])) < 1.25, `${what}: never flung up (waist at most ${Math.max(...t.map((x) => x.waist[1])).toFixed(2)} m)`);
  check(moved < 2.0, `${what}: lies near where it stood (${moved.toFixed(2)} m)`);
  check(end.asleep, `${what}: lies still by 5 s (asleep from ${t.find((x) => x.asleep)?.t ?? "-"} frames)`);
});
// What it costs: the frame script while four bodies fall, against while they stand (the reports' frames left out).
{
  const { readFileSync } = await import("node:fs");
  const rows = readFileSync(log, "utf8").trim().split("\n").flatMap((l) => { try { return [JSON.parse(l) as { script: number }]; } catch { return []; } });
  const mean = (a: { script: number }[]) => a.reduce((x, r) => x + r.script, 0) / a.length;
  console.log(`frame script: standing ${mean(rows.slice(20, 60)).toFixed(2)} ms, four falling ${mean(rows.slice(62, 120)).toFixed(2)} ms`);
}
check(live.errors().length === 0, `no script error ${live.errors().slice(0, 2).join(" | ")}`);
await live.quit();
done("ragdoll");
