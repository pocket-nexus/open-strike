import { describe, expect, test } from "bun:test";
import { createPrimaryTouch, BUTTON, CONTROL } from "../game/primary-touch.ts";

function rig(held: number[] = []) {
  let enabled = true,
    completed = 0;
  const events: number[][] = [];
  const input = createPrimaryTouch(
    {
      enabled: () => enabled,
      input: (...v) => events.push(v),
      visual() {},
      completed: () => completed++,
    },
    held,
  );
  return {
    input,
    events,
    last: () => events.at(-1)!,
    enabled: (v: boolean) => (enabled = v),
    completed: () => completed,
  };
}
const point = (id: number, x: number, y: number) => ({ id, x, y });
const button = (id: number, name: keyof typeof CONTROL) => ({
  id,
  ...CONTROL[name],
});
describe("primary gameplay touches", () => {
  test("move, aim, fire and jump remain independent across four contacts", () => {
    const r = rig();
    r.input.down(point(4, 70, 240));
    r.input.move(point(4, 100, 210));
    r.input.down(point(2, 260, 160));
    r.input.move(point(2, 280, 150));
    expect(r.last()[3]).toBe(20 * 1024);
    r.input.down(button(5, "fire"));
    r.input.down(button(7, "jump"));
    expect(r.last()[2]).toBe(BUTTON.fire | BUTTON.jump);
    expect(Math.hypot(r.last()[0], r.last()[1])).toBeLessThanOrEqual(1000.1);
    r.input.up(button(7, "jump"));
    expect(r.last()[2]).toBe(BUTTON.fire);
    r.input.up(point(4, 100, 210));
    expect(r.last().slice(0, 3)).toEqual([0, 0, BUTTON.fire]);
    r.input.up(button(5, "fire"));
    expect(r.last()[2]).toBe(0);
  });
  test("firing thumb can drag to aim without leaving fire mode", () => {
    const r = rig();
    r.input.down(button(1, "fire"));
    r.input.move(point(1, 320, 140));
    expect(r.last()[2]).toBe(BUTTON.fire);
    expect(r.last()[3]).toBe(-104 * 1024);
    r.input.up(point(1, 320, 140));
    expect(r.last()[2]).toBe(0);
  });
  test("crossing into buttons never transfers a look contact or duplicates aim", () => {
    const r = rig();
    r.input.down(point(1, 250, 160));
    r.input.move(button(1, "fire"));
    expect(r.last()[2]).toBe(0);
    r.input.down(point(2, 280, 170));
    r.input.up(button(1, "fire"));
    const n = r.events.length;
    r.input.move(point(2, 330, 200));
    expect(r.events.length).toBe(n);
  });
  test("reload is one release pulse and dragging away cancels it", () => {
    const r = rig();
    r.input.down(button(1, "reload"));
    r.input.up(button(1, "reload"));
    expect(r.events.filter((v) => v[2] & BUTTON.reload)).toHaveLength(1);
    r.input.down(button(1, "reload"));
    r.input.move(point(1, 280, 100));
    r.input.move(button(1, "reload"));
    r.input.up(button(1, "reload"));
    expect(r.events.filter((v) => v[2] & BUTTON.reload)).toHaveLength(1);
  });
  test("walk toggles on release; cancellation and disabled gameplay clear held output", () => {
    const r = rig();
    r.input.down(button(1, "walk"));
    r.input.up(button(1, "walk"));
    expect(r.last()[2]).toBe(BUTTON.walk);
    r.input.down(button(2, "fire"));
    r.enabled(false);
    r.input.move(point(2, 400, 200));
    expect(r.last()).toEqual([0, 0, 0, 0, 0]);
    r.enabled(true);
    r.input.move(button(2, "fire"));
    expect(r.last()[2]).toBe(0);
  });
  test("a held finger cannot restart fire when a pause dialog closes", () => {
    const r = rig([1]);
    r.input.down(button(1, "fire"));
    expect(r.events).toHaveLength(0);
    r.input.up(button(1, "fire"));
    r.input.down(button(1, "fire"));
    expect(r.last()[2]).toBe(BUTTON.fire);
    r.input.cancel(1);
    expect(r.last()[2]).toBe(0);
  });
  test("look distance is identical at 20, 30, 60 and 120 input samples", () => {
    for (const count of [20, 30, 60, 120]) {
      const r = rig();
      r.input.down(point(1, 250, 130));
      for (let i = 1; i <= count; i++)
        r.input.move(point(1, 250 + (i * 120) / count, 130));
      expect(r.events.reduce((sum, e) => sum + e[3], 0)).toBe(120 * 1024);
    }
  });
});
