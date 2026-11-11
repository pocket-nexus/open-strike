// Summarize physical PSP windows; do not infer fps from CPU/GPU averages.
import { readFileSync } from "node:fs";
const args = Bun.argv.slice(2);
const path = args[0];
if (!path || path.startsWith("--")) throw new Error("bun scripts/bench-report.ts RUN.jsonl [--min-fps 55] [--max-late 0] [--tour]");
const option = (key: string, fallback: number) => {
  const i = args.indexOf(key);
  if (i < 0) return fallback;
  const value = Number(args[i+1]);
  if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid ${key}`);
  return value;
};
const windows = readFileSync(path,"utf8").trim().split("\n").map((line) => JSON.parse(line));
if (!windows.length || windows.some((w, i) => w.window !== i+1 || w.frames !== 300 || !(w.observed_fps_milli > 0))) throw new Error("Expected ordered, complete 300-frame windows with measured fps");
if (args.includes("--tour") && (windows.length !== 20 || windows.some((w, i) => !w.map_probe || w.probe_view !== Math.floor(i/2)))) throw new Error("Expected all ten 360-degree map views (20 windows)");
const frames = windows.reduce((n,w) => n+w.frames,0);
const seconds = windows.reduce((n,w) => n+w.frames*1000/w.observed_fps_milli,0);
const late = windows.reduce((n,w) => n+w.late_frames,0);
const result = {
  frames, seconds, fps: frames/seconds,
  worstWindowFps: Math.min(...windows.map(w=>w.observed_fps_milli/1000)),
  longestWindowP95Ms: Math.max(...windows.map(w=>w.p95_frame_us/1000)),
  longestWindowP99Ms: Math.max(...windows.map(w=>w.p99_frame_us/1000)),
  lateFrames: late, latePercent: late/frames*100,
  missedVblanks: windows.reduce((n,w)=>n+w.missed_vblanks,0),
  events: Object.fromEntries(["hits","kills","damage","deaths","resets","shots"].map(k=>[k,windows.reduce((n,w)=>n+(w.events?.[k]??0),0)])),
};
console.log(JSON.stringify(result,null,2));
if (result.worstWindowFps < option("--min-fps",0) || late > option("--max-late",Infinity)) process.exitCode = 1;
