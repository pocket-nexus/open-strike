// What the soldiers cost a frame: practice with eight bots running about the map (every one posed every frame, seen
// or not), the engine's frame log read back. Per frame, mean and 95th percentile: the frame script, the skinning,
// the BLAS rebuilds (GPU, timed alone), the uploads, the GPU's frame.
//
//   node tools/bench-soldiers.ts [--frames 600] [--bots 8] [--size 1280x720]
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { build } from "./build.ts";
import { ROOT } from "./lib/engine.ts";
import { startLive } from "./lib/live.ts";

const args = process.argv.slice(2);
const flag = (k: string, d: string) => (args.includes(k) ? args[args.indexOf(k) + 1]! : d);
const frames = Number(flag("--frames", "600"));
const [width, height] = flag("--size", "1280x720").split("x").map(Number);
const log = join(ROOT, "out/bench-soldiers.jsonl");
mkdirSync(join(ROOT, "out"), { recursive: true });

const { out } = await build();
const live = await startLive(out, {
  launch: { practice: true, bots: Number(flag("--bots", "8")), name: "Bench" },
  width, height, scale: "1", args: ["--frame-log", log], env: { THREERT_PROFILE_BLAS: "1" },
});
// (A place that sees much of the map; the bots run about whether seen or not.)
live.send({ cmd: "event", type: "place", payload: { at: [-17.6, 0, -4.6], yaw: -1.68, pitch: -0.05, bare: true } });
await live.step(120);
const skip = readFileSync(log, "utf8").trim().split("\n").length;
await live.step(frames);
const errors = live.errors();
await live.quit();

const rows = readFileSync(log, "utf8").trim().split("\n").slice(skip).map((l) => JSON.parse(l) as Record<string, number>);
const stat = (k: string) => {
  const v = rows.map((r) => Number(r[k] ?? 0)).sort((a, b) => a - b);
  return `${(v.reduce((a, b) => a + b, 0) / v.length).toFixed(2)} / ${v[Math.floor(v.length * 0.95)]!.toFixed(2)}`;
};
console.log(`${rows.length} frames at ${width}x${height}, mean / p95 ms:`);
for (const k of ["script", "commit", "skin", "upload", "blas", "gpu", "cpu"]) console.log(`  ${k.padEnd(7)} ${stat(k)}`);
const fallbacks = rows.at(-1)?.fallbacks ?? 0;
console.log(`  rebuilds of the scene: ${fallbacks}`);
if (errors.length) console.log(errors.slice(0, 5).join("\n"));
