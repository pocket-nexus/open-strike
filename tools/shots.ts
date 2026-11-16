// Pictures of the game, traced: the map from its lanes and a staged firefight, for the platform page (media/) and for
// looking at while the map and the soldiers are worked on. The game runs in the headless renderer in practice; the
// player and the bots are put in place (the `place` and `stage` handlers), then time is slowed to almost nothing so
// a frame's worth of muzzle flash stays lit while the picture converges.
//
//   node tools/shots.ts [--only hall,yard] [--out out/shots] [--width 1920 --height 1080] [--frames 96]
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { ROOT, engineRequire } from "./lib/engine.ts";
import { build } from "./build.ts";
import { startLive, type Live } from "./lib/live.ts";

type V3 = [number, number, number];
interface Bot { at: V3; yaw: number; pitch?: number; flags?: number; speed?: number; weapon?: number; team?: "ember" | "azure"; fire?: V3 }
export interface Picture {
  name: string;
  at: V3; yaw: number; pitch?: number;
  /** Without the weapon in the picture. */
  bare?: boolean;
  bots?: Bot[];
  /** What the player does before the picture: keys held, buttons held, for how many frames; and whether it fires in the frame taken. */
  act?: { keys?: string[]; buttons?: number[]; frames: number; weapon?: string }[];
  fire?: boolean;
}
const deg = (d: number) => (d * Math.PI) / 180;
const CROUCH = 1, SPRINT = 32;

export const PICTURES: Picture[] = [
  { name: "hall", at: [-21.5, 0, -2.4], yaw: deg(-84), pitch: 0.06, bare: true, bots: [] },
  { name: "hall-furnace", at: [-6.2, 0, 5.3], yaw: deg(-47), pitch: 0.04, bare: true, bots: [] },
  { name: "yard", at: [-20.5, 0, -17.5], yaw: deg(-97), pitch: 0.04, bare: true, bots: [] },
  { name: "gantry", at: [-10.5, 3, 9.2], yaw: deg(-76), pitch: -0.1, bare: true, bots: [] },
  { name: "alley", at: [-21, 0, 18], yaw: deg(-80), pitch: 0.1, bare: true, bots: [] },
  { name: "bay", at: [-31, 0, 11.5], yaw: deg(-150), pitch: 0.02, bare: true, bots: [] },
  {
    name: "soldiers", at: [-18.4, 0, -4.4], yaw: deg(-96), pitch: -0.03, bare: true,
    bots: [
      { at: [-15.2, 0, -5.4], yaw: deg(100), team: "azure", weapon: 0 },
      { at: [-14.6, 0, -3.9], yaw: deg(70), team: "ember", weapon: 2, flags: CROUCH },
      { at: [-13.0, 0, -5.9], yaw: deg(40), team: "azure", weapon: 1, speed: 6.4, flags: SPRINT },
      { at: [-13.6, 0, -2.9], yaw: deg(150), team: "ember", weapon: 0, speed: 4.6 },
    ],
  },
  {
    name: "firefight", at: [-18.8, 0, -3.3], yaw: deg(-86), pitch: 0.03, fire: true,
    bots: [
      { at: [-8.2, 0, -0.6], yaw: deg(94), team: "azure", weapon: 0, fire: [-19.6, 2.0, -4.4] },
      { at: [-4.9, 0, -5.0], yaw: deg(100), team: "azure", weapon: 1, flags: CROUCH },
      { at: [-14.8, 0, -0.9], yaw: deg(-84), team: "ember", weapon: 0, speed: 6.2, flags: SPRINT },
      { at: [-9.2, 0, 3.6], yaw: deg(110), team: "azure", weapon: 2, speed: 4.4 },
    ],
    act: [{ buttons: [0], frames: 9 }],
  },
  {
    name: "scope", at: [-20, 0, -15.5], yaw: deg(-92), pitch: 0.0,
    bots: [{ at: [9.5, 0, -15.2], yaw: deg(88), team: "azure", weapon: 0 }, { at: [4.4, 1.2, -21.5], yaw: deg(100), team: "azure", weapon: 2, flags: CROUCH }],
    act: [{ keys: ["3"], frames: 50 }, { buttons: [2], frames: 150 }],
  },
  {
    name: "yard-fight", at: [-14.6, 0, -18.3], yaw: deg(-84), pitch: 0.04, fire: true,
    bots: [
      { at: [-3.4, 0, -17.6], yaw: deg(95), team: "azure", weapon: 0, fire: [-15.4, 1.6, -19.2] },
      { at: [2.2, 1.2, -21.2], yaw: deg(100), team: "azure", weapon: 2, flags: CROUCH },
      { at: [-11.4, 0, -16.4], yaw: deg(-78), team: "ember", weapon: 1, speed: 4.5 },
      { at: [6.8, 0, -17.2], yaw: deg(120), team: "azure", weapon: 0, speed: 5 },
    ],
    act: [{ buttons: [0], frames: 7 }],
  },
];

export async function take(live: Live, p: Picture, path: string, frames: number): Promise<void> {
  live.input({ keys: [], buttons: [] });
  live.send({ cmd: "lockstep", dt: 1 / 60 });
  live.send({ cmd: "event", type: "place", payload: { at: p.at, yaw: p.yaw, pitch: p.pitch ?? 0, bare: p.bare === true } });
  live.send({ cmd: "event", type: "stage", payload: { bots: p.bots ?? [] } });
  await live.step(150);          // (the exposure adapts to the place, as an eye does: a couple of seconds)
  for (const a of p.act ?? []) {
    live.input({ keys: a.keys ?? [], buttons: a.buttons ?? [], pressed: [...(a.keys ?? []), ...(a.buttons ?? []).map((b) => `Mouse${b}`)] });
    await live.step(1);
    live.input({ keys: [], buttons: a.buttons ?? [] });
    await live.step(a.frames - 1);
  }
  if (p.fire) {
    // The others fire now too (their flashes are in the same frame as the player's).
    live.send({ cmd: "event", type: "stage", payload: { bots: p.bots ?? [] } });
    live.input({ buttons: [0], pressed: ["Mouse0"] });
    live.send({ cmd: "lockstep", dt: 1 / 60 });
    await live.step(1);
  }
  // Time almost stopped: what is lit stays lit, what flies stays where it is, and the picture converges.
  live.send({ cmd: "lockstep", dt: 0.00005 });
  await live.step(frames);
  await live.snapshot(path, 1);
  live.input({ keys: [], buttons: [] });
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const flag = (k: string, d: string) => (args.includes(k) ? args[args.indexOf(k) + 1]! : d);
  const only = flag("--only", "").split(",").filter(Boolean);
  const outDir = resolve(ROOT, flag("--out", "out/shots"));
  mkdirSync(outDir, { recursive: true });
  const { out } = await build();
  const live = await startLive(out, { launch: { practice: true, bots: 4, targets: true, name: "Ada" }, width: Number(flag("--width", "1280")), height: Number(flag("--height", "720")), scale: "1" });
  await live.step(30);
  for (const p of PICTURES) {
    if (only.length && !only.includes(p.name)) continue;
    const path = join(outDir, `${p.name}.png`);
    await take(live, p, path, Number(flag("--frames", "72")));
    if (args.includes("--jpg")) {
      const sharp = engineRequire("sharp") as typeof import("sharp");
      await sharp(path).jpeg({ quality: 90 }).toFile(path.replace(/\.png$/, ".jpg"));
    }
    console.log(path.replace(ROOT + "/", ""));
  }
  const errors = live.errors();
  if (errors.length) console.error(errors.slice(0, 5).join("\n"));
  await live.quit();
}
