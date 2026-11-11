import { expect, test } from "bun:test";
import { cameraMatrix } from "../site/map-viewer/math.js";

function project(matrix: ArrayLike<number>, point: number[]) {
  const p = [...point, 1];
  const clip = [0, 1, 2, 3].map(row => p.reduce((sum, v, col) => sum + matrix[col * 4 + row] * v, 0));
  return clip.slice(0, 3).map(v => v / clip[3]);
}

test("BSP camera centers its forward ray at translated and rotated views", () => {
  for (const [yaw, pitch] of [[0, 0], [Math.PI / 2, 0], [-1.2, .6], [2.1, -.5]]) {
    const eye = [172.8, 313.6, 233.6];
    const forward = [-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)];
    const p = project(cameraMatrix(eye, yaw, pitch, 16 / 9), eye.map((v, i) => v + forward[i] * 128));
    expect(p[0]).toBeCloseTo(0, 5);
    expect(p[1]).toBeCloseTo(0, 5);
    expect(p[2]).toBeGreaterThan(-1);
    expect(p[2]).toBeLessThan(1);
  }
});

test("PSP Y-up coordinates retain right and up; aspect changes horizontal coverage", () => {
  const wide = project(cameraMatrix([0, 0, 0], 0, 0, 2), [32, 32, -128]);
  const square = project(cameraMatrix([0, 0, 0], 0, 0, 1), [32, 32, -128]);
  expect(wide[0]).toBeGreaterThan(0);
  expect(wide[1]).toBeGreaterThan(0);
  expect(wide[0] * 2).toBeCloseTo(square[0], 5);
  expect(wide[1]).toBeCloseTo(square[1], 5);
});
