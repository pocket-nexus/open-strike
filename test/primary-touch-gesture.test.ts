import { afterEach, beforeEach, expect, test } from "bun:test";
import { createRoot } from "solid-js";
import { __runGestures, resetGestures } from "@pocketjs/framework/gesture";
import { resetFrameHooks, runFrameHooks } from "@pocketjs/framework/frame";
import { __advanceClock, resetClock } from "@pocketjs/framework/clock";
import {
  __packTouch, __packTouchCancel, __resetTouches, __setTouches,
} from "@pocketjs/framework/touch";
import { BUTTON, CONTROL } from "../game/primary-touch.ts";
import { usePrimaryTouch } from "../game/primary-touch-gesture.ts";

type Contact = [id: number, x: number, y: number];
const finger = (id: number, name: keyof typeof CONTROL): Contact =>
  [id, CONTROL[name].x, CONTROL[name].y];
const disposers: (() => void)[] = [];

function mount() {
  const events: number[][] = [];
  const dispose = createRoot((dispose) => {
    usePrimaryTouch({
      enabled: () => true,
      input: (...values) => events.push(values),
      visual() {},
      completed() {},
    });
    return dispose;
  });
  disposers.push(dispose);
  return { events, dispose, last: () => events.at(-1)! };
}

// Match the shipping frame order: latch snapshots, run gestures, then hooks.
function frame(contacts: Contact[], cancelled: number[] = []) {
  __advanceClock();
  __setTouches([
    ...contacts.map(([id, x, y]) => __packTouch(id, x, y)),
    ...cancelled.map(__packTouchCancel),
  ]);
  runFrameHooks(0, undefined, undefined, () => __runGestures());
}

beforeEach(() => {
  resetClock();
  resetFrameHooks();
  resetGestures();
  __resetTouches();
});
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  resetFrameHooks();
  resetGestures();
  __resetTouches();
});

for (const ending of ["release", "cancel"] as const) {
  test(`pause remount retires an unowned ${ending} before fire and movement IDs are reused`, () => {
    const held: Contact[] = [finger(255, "fire"), [0, 70, 240]];
    const old = mount();
    frame(held);
    expect(old.last()[2]).toBe(BUTTON.fire);
    old.dispose(); // Pause removes the controls while both fingers stay down.
    expect(old.last()).toEqual([0, 0, 0, 0, 0]);
    frame(held);
    const resumed = mount();
    frame([finger(255, "fire"), [0, 100, 210]]);
    expect(resumed.events).toEqual([]); // No ownership of pre-mount contacts.
    frame([], ending === "cancel" ? [255, 0] : []);
    expect(resumed.events).toEqual([]); // In particular, no onUp/onCancel.

    frame(held); // Host wraps/reuses 8-bit IDs: the first fresh DOWN must work.
    expect(resumed.last()[2]).toBe(BUTTON.fire);
    frame([finger(255, "fire"), [0, 100, 210]]);
    expect(resumed.last()[0]).toBeGreaterThan(0);
    expect(resumed.last()[1]).toBeGreaterThan(0);
    frame([]);
    expect(resumed.last()).toEqual([0, 0, 0, 0, 0]);
  });
}

test("releasing one pre-mount finger preserves suppression of the other", () => {
  frame([finger(11, "fire"), [12, 70, 240]]);
  const resumed = mount();
  frame([[12, 90, 220]]);
  expect(resumed.events).toEqual([]);
  frame([finger(11, "fire"), [12, 100, 210]]);
  expect(resumed.last().slice(0, 3)).toEqual([0, 0, BUTTON.fire]);
  frame([]);
  frame([[12, 70, 240]]);
  frame([[12, 100, 210]]);
  expect(resumed.last()[0]).toBeGreaterThan(0);
  expect(resumed.last()[2]).toBe(0);
});
