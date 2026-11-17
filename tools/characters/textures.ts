// The cloth's textures, made in code: a tone-on-tone camouflage with the weave in it (base colour: it multiplies the
// outfit's own colour, so one picture serves every outfit), a plain heavy weave for the kit's nylon, and the weave's
// relief as a normal map. All tile. And the mapping that puts them on a sculpted mesh, which has no seams to unwrap
// along: every triangle is mapped flat along the axis it faces most (so a limb has four seams, as a sleeve has).
import { encodeIndexedPng, encodeRgbaPng } from "../../src/import/png.ts";
import type { Buf } from "./mesh.ts";

export const SIZE = 512;
/** Threads: the weave repeats every this many pixels. */
const THREAD = 4;

/** Smooth noise that tiles: `cells` lattice cells across the picture. */
function tiled(cells: number, seed: number): (u: number, v: number) => number {
  const g = new Float32Array(cells * cells);
  let s = seed * 9301 + 49297;
  for (let i = 0; i < g.length; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; g[i] = s / 0x7fffffff; }
  const at = (x: number, y: number) => g[(((y % cells) + cells) % cells) * cells + (((x % cells) + cells) % cells)]!;
  return (u, v) => {
    const x = u * cells, y = v * cells, ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
    const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
    return (at(ix, iy) * (1 - ux) + at(ix + 1, iy) * ux) * (1 - uy) + (at(ix, iy + 1) * (1 - ux) + at(ix + 1, iy + 1) * ux) * uy;
  };
}

const GREYS = (() => { const p = new Uint8Array(768); for (let i = 0; i < 256; i++) p[i * 3] = p[i * 3 + 1] = p[i * 3 + 2] = i; return p; })();
const srgb = (lin: number) => Math.max(0, Math.min(255, Math.round(255 * (lin <= 0.0031308 ? lin * 12.92 : 1.055 * Math.pow(lin, 1 / 2.4) - 0.055))));
/** How high the weave stands at a pixel, 0..1: threads `THREAD` pixels wide going over and under each other. */
function relief(x: number, y: number): number {
  const cx = Math.floor(x / THREAD), cy = Math.floor(y / THREAD);
  const fx = (x % THREAD) / THREAD - 0.5, fy = (y % THREAD) / THREAD - 0.5;
  // (A warp thread is on top where the cell's parity is even: round across its width, long along the other way.)
  const across = (cx + cy) % 2 === 0 ? fx : fy;
  return Math.sqrt(Math.max(0, 1 - 4 * across * across)) * (0.75 + 0.25 * Math.cos(((cx + cy) % 2 === 0 ? fy : fx) * Math.PI));
}

/** Camouflage in three tones of whatever colour it is on (linear 1, 0.68, 0.42), with the weave's shading. */
export function camo(): Uint8Array {
  const big = tiled(5, 1), mid = tiled(11, 2), warp = tiled(7, 3), warp2 = tiled(7, 4), speck = tiled(23, 5);
  const px = new Uint8Array(SIZE * SIZE);
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
    const u = x / SIZE + (warp(x / SIZE, y / SIZE) - 0.5) * 0.16, v = y / SIZE + (warp2(x / SIZE, y / SIZE) - 0.5) * 0.16;
    const a = big(u, v) * 0.65 + mid(u, v) * 0.35, b = mid(v + 0.37, u + 0.11) * 0.6 + speck(u, v) * 0.4;
    let tone = 1;
    if (a > 0.6) tone = 0.42;
    else if (b > 0.56) tone = 0.68;
    if (speck(u + 0.5, v + 0.5) > 0.76 && tone === 1) tone = 0.42;
    px[y * SIZE + x] = srgb(tone * (0.95 + 0.05 * relief(x, y)));
  }
  return encodeIndexedPng(SIZE, SIZE, px, GREYS);
}

/** Heavy nylon: even in tone but for the weave and a little wear. */
export function cordura(): Uint8Array {
  const wear = tiled(9, 7);
  const px = new Uint8Array(SIZE * SIZE);
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) px[y * SIZE + x] = srgb((0.88 + 0.12 * relief(x, y)) * (0.88 + 0.12 * wear(x / SIZE, y / SIZE)));
  return encodeIndexedPng(SIZE, SIZE, px, GREYS);
}

/** The weave's relief as a tangent-space normal map. */
export function weave(strength = 1.2): Uint8Array {
  const px = new Uint8Array(SIZE * SIZE * 4);
  const h = (x: number, y: number) => relief((x + SIZE) % SIZE, (y + SIZE) % SIZE);
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
    const dx = (h(x + 1, y) - h(x - 1, y)) * strength, dy = (h(x, y + 1) - h(x, y - 1)) * strength;
    const l = Math.hypot(dx, dy, 1), o = (y * SIZE + x) * 4;
    px[o] = Math.round(127.5 - (dx / l) * 127.5); px[o + 1] = Math.round(127.5 - (dy / l) * 127.5); px[o + 2] = Math.round(127.5 + (1 / l) * 127.5); px[o + 3] = 255;
  }
  return encodeRgbaPng(SIZE, SIZE, px);
}

/**
 * The mesh with texture coordinates: every triangle mapped along the axis its face looks along most, the picture
 * `repeat` millimetres across. Vertices on a seam are doubled.
 */
export function mapped(b: Buf, repeat: number): Buf & { uv: number[] } {
  const out = { pos: [] as number[], nrm: [] as number[], idx: [] as number[], uv: [] as number[] };
  const seen = new Map<number, number>();
  for (let t = 0; t < b.idx.length; t += 3) {
    const [a, c, d] = [b.idx[t]!, b.idx[t + 1]!, b.idx[t + 2]!];
    const p = (i: number, k: number) => b.pos[i * 3 + k]!;
    const ux = p(c, 0) - p(a, 0), uy = p(c, 1) - p(a, 1), uz = p(c, 2) - p(a, 2), vx = p(d, 0) - p(a, 0), vy = p(d, 1) - p(a, 1), vz = p(d, 2) - p(a, 2);
    const n = [Math.abs(uy * vz - uz * vy), Math.abs(uz * vx - ux * vz), Math.abs(ux * vy - uy * vx)];
    const axis = n[0]! >= n[1]! && n[0]! >= n[2]! ? 0 : n[1]! >= n[2]! ? 1 : 2;
    for (const i of [a, c, d]) {
      const key = i * 3 + axis;
      let j = seen.get(key);
      if (j === undefined) {
        j = out.pos.length / 3;
        seen.set(key, j);
        out.pos.push(p(i, 0), p(i, 1), p(i, 2));
        out.nrm.push(b.nrm[i * 3]!, b.nrm[i * 3 + 1]!, b.nrm[i * 3 + 2]!);
        out.uv.push((axis === 0 ? p(i, 2) : p(i, 0)) / repeat, (axis === 1 ? p(i, 2) : p(i, 1)) / repeat);
      }
      out.idx.push(j);
    }
  }
  return out;
}
