import { expect, test } from "bun:test";
import {
  createTacticalTouch,
  mapPoint,
  unmapPoint,
} from "../game/tactical-touch.ts";

function fixture() {
  let enabled = true;
  const inputs: number[][] = [];
  const marks: number[][] = [];
  let zooms = 0;
  const touch = createTacticalTouch({
    enabled: () => enabled,
    input: (...args) => inputs.push(args),
    mark: (...args) => marks.push(args),
    zoom: () => zooms++,
    clear() {},
    pressed() {},
  });
  return {
    touch,
    inputs,
    marks,
    zooms: () => zooms,
    disable: () => {
      enabled = false;
    },
  };
}
const c = (x: number, y: number, id = 0) => ({ x, y, id });

test("fire holds until release; sliding off cancels without transferring buttons", () => {
  const f = fixture();
  f.touch.down(c(250, 50));
  expect(f.inputs).toEqual([[1, 0, 0]]);
  f.touch.move(c(250, 90));
  f.touch.move(c(250, 50));
  f.touch.up(c(250, 50));
  expect(f.inputs.slice(1).every((row) => row[0] === 0)).toBe(true);
});
test("reload is an inside-release pulse, and canceled touches cannot reload", () => {
  const f = fixture();
  f.touch.down(c(250, 90));
  f.touch.up(c(250, 90));
  expect(f.inputs).toEqual([
    [0, 0, 0],
    [2, 0, 0],
    [0, 0, 0],
  ]);
  f.inputs.length = 0;
  f.touch.down(c(250, 90));
  f.touch.move(c(200, 90));
  f.touch.up(c(250, 90));
  expect(f.inputs.every((row) => row[0] === 0)).toBe(true);
});
test("map drag delivers continuous deltas and reversals without a waypoint", () => {
  const f = fixture();
  f.touch.down(c(100, 100));
  f.touch.move(c(102, 101));
  expect(f.inputs).toEqual([]);
  f.touch.move(c(110, 103));
  f.touch.move(c(106, 101));
  f.touch.up(c(106, 101));
  expect(f.inputs).toEqual([
    [0, 10, 3],
    [0, -4, -2],
    [0, 0, 0],
  ]);
  expect(f.marks).toEqual([]);
});
test("map tap marks map coordinates; zoom inverse preserves a world point", () => {
  const f = fixture();
  f.touch.down(c(100, 100));
  f.touch.up(c(101, 101));
  expect(f.marks).toEqual([[93, 61]]);
  for (const zoom of [1, 2, 4])
    for (const center of [0, 40, 104, 208])
      expect(
        unmapPoint(mapPoint(68, center, 208, zoom), center, 208, zoom),
      ).toBe(68);
  f.touch.down(c(20, 212));
  f.touch.up(c(20, 212));
  expect(f.zooms()).toBe(1);
});
test("cancel, disabled state, and unrelated contact ids never retain shooting", () => {
  const f = fixture();
  f.touch.down(c(250, 50));
  f.touch.up(c(250, 50, 1));
  expect(f.inputs).toHaveLength(1);
  f.disable();
  f.touch.move(c(251, 50));
  expect(f.inputs.at(-1)).toEqual([0, 0, 0]);
  f.inputs.length = 0;
  f.touch.down(c(250, 50));
  f.touch.up(c(250, 50));
  expect(f.inputs).toEqual([]);
});
