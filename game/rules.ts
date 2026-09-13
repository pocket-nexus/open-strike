// The base game, written as the first mod (RUNTIMES.md discipline #5: if the
// built-in behavior can't be expressed through the surface, the surface is
// too weak). Round flow, scoring and difficulty all live HERE — the Rust
// core simulates; it never decides.

import { createSignal } from "solid-js";
import { strike } from "./sdk.ts";

/** Freeze time before a round goes live (seconds). */
export const ROUND_FREEZE = 1.2;
/** Pause on the end screen before the next round (seconds). */
export const ROUND_END_PAUSE = 3.5;

// The rifle and the opposition, stated explicitly: change these numbers and
// you have made a mod.
// Native core owns the CS 1.6 weapon catalog. Mods can still replace the
// equipped weapon's tuning through strike.configureWeapon.
strike.configureBots({
  count: 3,
  speed: 225,
  attackInterval: 0.95,
  damageMin: 8,
  damageMax: 14,
});

/** Seconds since the current phase began (HUD reads this for countdowns). */
const [phaseAge, setPhaseAge] = createSignal(0);
export { phaseAge };

let lastPhase = "";
let phaseStart = 0;

strike.onTick((s) => {
  if (s.phase !== lastPhase) {
    lastPhase = s.phase;
    phaseStart = s.time;
  }
  setPhaseAge(s.time - phaseStart);

  if (s.phase === "starting" && s.time - phaseStart >= ROUND_FREEZE) {
    strike.setPhase("live");
  }
  if (s.phase === "live" && s.totalBots > 0 && s.aliveBots === 0) {
    strike.addWin();
    strike.setPhase("won");
  }
  if ((s.phase === "won" || s.phase === "lost") && s.time - phaseStart >= ROUND_END_PAUSE) {
    strike.resetRound();
  }
});

strike.on("playerDied", () => {
  strike.addLoss();
  strike.setPhase("lost");
});
