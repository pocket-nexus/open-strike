// The soldier's hands as the world sees them: gloves closed on a rifle, made from the first-person hand poses of the
// carbine (tools/weapons). The right hand's part has the weapon's own origin (the grip); the left one's origin is the
// weapon's support point (`gripL` in the weapon's meta). The game places both with the weapon, and brings the
// forearms to the wrists given here.
import { Kit } from "../weapons/kit.ts";
import { carbine } from "../weapons/carbine.ts";
import { handShape } from "../weapons/arms.ts";
import { sculptArm } from "./hand.ts";
import type { Buf } from "./mesh.ts";

export function hands(): { right: Map<string, Buf>; left: Map<string, Buf>; meta: { wristR: number[]; wristL: number[] } } {
  // (The world model's kit: the weapon is built without its arms; the poses come with its meta.)
  const meta = carbine(new Kit(1));
  const { right, left } = meta.hands!;
  const at = left.wrist.map((v, i) => v - meta.gripL[i]!) as [number, number, number];
  const m = (v: number[]) => v.map((x) => +(x / 1000).toFixed(4));
  return {
    right: sculptArm(handShape(right), { cell: 4, tolerance: 0.3 }),
    left: sculptArm(handShape({ ...left, wrist: at, thumb: left.thumb.map((t) => t.map((v, i) => v - meta.gripL[i]!)) as typeof left.thumb }), { cell: 4, tolerance: 0.3 }),
    meta: { wristR: m(right.wrist), wristL: m(at) },
  };
}
